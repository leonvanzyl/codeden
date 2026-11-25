import { randomUUID } from "node:crypto";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { type RunnerEvent, RunnerEventMessage } from "@codeden/contracts";

interface JournalState {
  runnerId: string;
  /** Highest seq ever assigned. */
  lastSeq: number;
  /** Highest seq the server acknowledged. */
  ackedSeq: number;
}

interface Entry {
  msg: RunnerEventMessage;
  /** Size of its line in `journal.jsonl`. */
  bytes: number;
}

interface PendingEntry extends Entry {
  line: string;
}

const STREAM_BATCH_ENTRIES = 16;
const STREAM_BATCH_BYTES = 128 * 1024;

export interface JournalOptions {
  /** Compact once this many acked events are still in the file. Default 1,000. */
  compactEntries?: number;
  /** ...or once they take this many bytes. Default 1 MiB. */
  compactBytes?: number;
  /** While acks flow, persist (state, then compaction when due) at most this often. Default 250 ms. */
  persistMs?: number;
  /**
   * False once another runner owns these files (its lock names another runner, #615). Checked
   * before every save, including the one at `close`: the journal then stops writing for good.
   */
  owned?: () => boolean;
  /** Publish each record only after its append succeeds. */
  onAppend?: (message: RunnerEventMessage) => void;
  /** Called once when a failed append requires recovery from disk. */
  onAppendError?: (error: Error) => void;
}

/**
 * Durable runner event journal (§4.2). Events are appended to `journal.jsonl` with a
 * monotonically increasing seq and kept until the server acks them, so nothing is lost
 * while the server is away. `state.json` holds the stable runner id and seq counters.
 *
 * An ack only moves the acked position in memory. While acks flow, the journal persists at
 * most every `persistMs`: it writes `state.json`, then, when enough acked events have piled
 * up and they outweigh what is left, rewrites the file without them (compaction), so each
 * ack costs no more than its append did. State always goes first, so `lastSeq` outlives the
 * events a compaction drops. `close` persists and compacts at once. After a crash the journal
 * may still hold events the server already acked; the server's `resume` acks them again and
 * they are not replayed. Once another runner owns the files (`handOver`, or `owned` false before
 * a save), this journal writes nothing more to them.
 */
export class Journal {
  private readonly file: string;
  private readonly stateFile: string;
  private readonly compactEntries: number;
  private readonly compactBytes: number;
  private readonly persistMs: number;
  private readonly owned: () => boolean;
  /** Another runner took the files over: nothing is written to them any more. */
  private handedOver = false;
  private state: JournalState;
  /** Every event in `journal.jsonl`, oldest first; those before `head` are acked. */
  private entries: Entry[] = [];
  private head = 0;
  private fileBytes = 0;
  private ackedBytes = 0;
  private persistTimer: ReturnType<typeof setTimeout> | undefined;
  private pending: PendingEntry[] = [];
  private pendingBytes = 0;
  private flushTimer: ReturnType<typeof setImmediate> | undefined;
  private appendError: Error | undefined;
  private appendCount = 0;
  private appendMaxMs = 0;
  private queuedBytesPeak = 0;

  constructor(
    dir: string,
    private readonly opts: JournalOptions = {},
  ) {
    mkdirSync(dir, { recursive: true });
    this.file = join(dir, "journal.jsonl");
    this.stateFile = join(dir, "state.json");
    this.compactEntries = opts.compactEntries ?? 1000;
    this.compactBytes = opts.compactBytes ?? 1024 * 1024;
    this.persistMs = opts.persistMs ?? 250;
    this.owned = opts.owned ?? (() => true);
    this.state = this.loadState();
    const { entries, torn } = this.loadEntries();
    this.entries = entries;
    for (const e of entries) this.fileBytes += e.bytes;
    this.state.lastSeq = Math.max(this.state.lastSeq, entries.at(-1)?.msg.seq ?? 0);
    this.advanceHead(this.state.ackedSeq);
    // A crash mid-append leaves a torn last line: rewrite, so the next append gets its own line.
    if (torn) {
      this.writeState(this.state);
      this.compact();
    }
  }

  get runnerId(): string {
    return this.state.runnerId;
  }

  get lastSeq(): number {
    return this.state.lastSeq;
  }

  get unacked(): number {
    return this.entries.length - this.head;
  }

  /** Serialized bytes awaiting append or server acknowledgment. */
  get queuedBytes(): number {
    return this.fileBytes - this.ackedBytes + this.pendingBytes;
  }

  takeAppendDiagnostics() {
    const metrics = {
      appendCount: this.appendCount,
      appendMaxMs: this.appendMaxMs,
      journalQueuedBytes: Math.max(this.queuedBytes, this.queuedBytesPeak),
    };
    this.appendCount = 0;
    this.appendMaxMs = 0;
    this.queuedBytesPeak = this.queuedBytes;
    return metrics;
  }

  /** Assign the next seq, persist the event, and return the wire message. */
  append(event: RunnerEvent): RunnerEventMessage {
    this.flushDeltas();
    const entry = this.prepare(event);
    this.write([entry]);
    return entry.msg;
  }

  /** Coalesce streamed deltas from this event-loop turn into a bounded append. */
  queueDelta(event: RunnerEvent): void {
    if (this.handedOver) return;
    if (this.appendError) throw this.appendError;
    const entry = this.prepare(event);
    if (
      this.pending.length === STREAM_BATCH_ENTRIES ||
      this.pendingBytes + entry.bytes > STREAM_BATCH_BYTES
    ) {
      this.flushDeltas();
    }
    if (this.handedOver) return;
    if (entry.bytes > STREAM_BATCH_BYTES) {
      this.write([entry]);
      return;
    }
    this.pending.push(entry);
    this.pendingBytes += entry.bytes;
    this.queuedBytesPeak = Math.max(this.queuedBytesPeak, this.queuedBytes);
    this.flushTimer ??= setImmediate(() => {
      try {
        this.flushDeltas();
      } catch (error) {
        if (error !== this.appendError || !this.opts.onAppendError) throw error;
      }
    });
  }

  flushDeltas(): void {
    if (this.flushTimer) clearImmediate(this.flushTimer);
    this.flushTimer = undefined;
    if (this.appendError) throw this.appendError;
    if (this.pending.length === 0) return;
    const entries = this.pending;
    this.pending = [];
    this.pendingBytes = 0;
    this.write(entries);
  }

  private prepare(event: RunnerEvent): PendingEntry {
    const msg: RunnerEventMessage = {
      type: "event",
      seq: this.state.lastSeq + this.pending.length + 1,
      ts: new Date().toISOString(),
      event,
    };
    const line = `${JSON.stringify(msg)}\n`;
    return { msg, line, bytes: Buffer.byteLength(line) };
  }

  private write(batch: PendingEntry[]): void {
    if (!this.handedOver && !this.owned()) this.handOver();
    if (this.handedOver) return;
    const startedAt = performance.now();
    try {
      appendFileSync(this.file, batch.map((entry) => entry.line).join(""));
    } catch (error) {
      // A partial write can contain whole records. Only restart may recover their sequence
      // numbers from disk. Stop writing and compacting until then.
      this.appendError = error instanceof Error ? error : new Error(String(error));
      this.cancelPersist();
      this.opts.onAppendError?.(this.appendError);
      throw this.appendError;
    }
    this.appendCount += 1;
    this.appendMaxMs = Math.max(this.appendMaxMs, performance.now() - startedAt);
    for (const { msg, bytes } of batch) {
      this.entries.push({ msg, bytes });
      this.fileBytes += bytes;
      this.state.lastSeq = msg.seq;
    }
    this.queuedBytesPeak = Math.max(this.queuedBytesPeak, this.queuedBytes);
    for (const { msg } of batch) this.opts.onAppend?.(msg);
  }

  /** Acknowledge everything with `seq <= seq` (cumulative ack). */
  ack(seq: number): void {
    if (this.handedOver || this.appendError) return;
    const upTo = Math.min(seq, this.state.lastSeq);
    if (upTo <= this.state.ackedSeq) return;
    this.state.ackedSeq = upTo;
    this.advanceHead(upTo);
    this.schedulePersist();
  }

  /** Unacked events after `seq`, oldest first (for replay on resume). */
  after(seq: number): RunnerEventMessage[] {
    const out: RunnerEventMessage[] = [];
    for (let i = this.head; i < this.entries.length; i++) {
      const msg = this.entries[i]?.msg;
      if (msg && msg.seq > seq) out.push(msg);
    }
    return out;
  }

  /** Persist the acked position and drop every acked event from the file (runner shutdown). */
  close(): void {
    this.flushDeltas();
    this.persist(true);
  }

  /**
   * Another runner owns `journal.jsonl` and `state.json` now (#615): cancel a pending save and
   * never write to them again. Acks are ignored and `close` saves nothing.
   */
  handOver(): void {
    this.handedOver = true;
    if (this.flushTimer) clearImmediate(this.flushTimer);
    this.flushTimer = undefined;
    this.pending = [];
    this.pendingBytes = 0;
    this.cancelPersist();
  }

  private advanceHead(ackedSeq: number): void {
    for (;;) {
      const entry = this.entries[this.head];
      if (!entry || entry.msg.seq > ackedSeq) return;
      this.ackedBytes += entry.bytes;
      this.head += 1;
    }
  }

  /** Enough acked events piled up, and rewriting what is left costs no more than they do. */
  private compactDue(): boolean {
    const piledUp = this.head >= this.compactEntries || this.ackedBytes >= this.compactBytes;
    return piledUp && this.ackedBytes >= this.fileBytes - this.ackedBytes;
  }

  private schedulePersist(): void {
    if (this.persistTimer) return;
    this.persistTimer = setTimeout(() => {
      this.persistTimer = undefined;
      try {
        this.persist(false);
      } catch {
        // Only the acked position is late on disk; the next ack or `close` tries again.
      }
    }, this.persistMs);
    this.persistTimer.unref();
  }

  private cancelPersist(): void {
    if (this.persistTimer) clearTimeout(this.persistTimer);
    this.persistTimer = undefined;
  }

  /**
   * Write the acked position, then compact when it is due (`all`: whenever anything is acked).
   * State first, so `lastSeq` outlives the events the compaction drops.
   */
  private persist(all: boolean): void {
    this.cancelPersist();
    if (!this.handedOver && !this.owned()) this.handOver();
    if (this.handedOver || this.appendError) return;
    this.writeState(this.state);
    if (all ? this.head > 0 : this.compactDue()) this.compact();
  }

  /** Rewrite the file without its acked events. Callers write the state first. */
  private compact(): void {
    const live = this.entries.slice(this.head);
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, live.map((e) => `${JSON.stringify(e.msg)}\n`).join(""));
    renameSync(tmp, this.file);
    this.entries = live;
    this.head = 0;
    this.fileBytes -= this.ackedBytes;
    this.ackedBytes = 0;
  }

  private writeState(state: JournalState): void {
    const tmp = `${this.stateFile}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`);
    renameSync(tmp, this.stateFile);
  }

  private loadState(): JournalState {
    try {
      const raw = JSON.parse(readFileSync(this.stateFile, "utf8")) as Partial<JournalState>;
      if (typeof raw.runnerId === "string") {
        return { runnerId: raw.runnerId, lastSeq: raw.lastSeq ?? 0, ackedSeq: raw.ackedSeq ?? 0 };
      }
    } catch {
      // first run
    }
    const fresh = { runnerId: randomUUID(), lastSeq: 0, ackedSeq: 0 };
    this.writeState(fresh);
    return fresh;
  }

  private loadEntries(): { entries: Entry[]; torn: boolean } {
    if (!existsSync(this.file)) return { entries: [], torn: false };
    const raw = readFileSync(this.file, "utf8");
    const entries: Entry[] = [];
    let torn = raw.length > 0 && !raw.endsWith("\n");
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      const parsed = RunnerEventMessage.safeParse(safeJson(line));
      if (parsed.success) entries.push({ msg: parsed.data, bytes: Buffer.byteLength(line) + 1 });
      else torn = true; // a line cut short by a crash is skipped
    }
    return { entries: entries.sort((a, b) => a.msg.seq - b.msg.seq), torn };
  }
}

function safeJson(line: string): unknown {
  try {
    return JSON.parse(line);
  } catch {
    return undefined;
  }
}

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

export interface JournalOptions {
  /** Compact once this many acked events are still in the file. Default 1,000. */
  compactEntries?: number;
  /** ...or once they take this many bytes. Default 1 MiB. */
  compactBytes?: number;
  /** While acks flow, write the acked position to `state.json` at most this often. Default 250 ms. */
  stateWriteMs?: number;
}

/**
 * Durable runner event journal (§4.2). Events are appended to `journal.jsonl` with a
 * monotonically increasing seq and kept until the server acks them, so nothing is lost
 * while the server is away. `state.json` holds the stable runner id and seq counters.
 *
 * An ack only moves the acked position in memory. Acked events leave the file in one rewrite
 * (compaction) once enough have piled up and they outweigh what is left, so each ack costs
 * no more than its append did. The acked position reaches `state.json` at most every
 * `stateWriteMs`, at compaction and on `close`. After a crash the journal may still hold events
 * the server already acked; the server's `resume` acks them again and they are not replayed.
 */
export class Journal {
  private readonly file: string;
  private readonly stateFile: string;
  private readonly compactEntries: number;
  private readonly compactBytes: number;
  private readonly stateWriteMs: number;
  private state: JournalState;
  /** Every event in `journal.jsonl`, oldest first; those before `head` are acked. */
  private entries: Entry[] = [];
  private head = 0;
  private fileBytes = 0;
  private ackedBytes = 0;
  private stateTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(dir: string, opts: JournalOptions = {}) {
    mkdirSync(dir, { recursive: true });
    this.file = join(dir, "journal.jsonl");
    this.stateFile = join(dir, "state.json");
    this.compactEntries = opts.compactEntries ?? 1000;
    this.compactBytes = opts.compactBytes ?? 1024 * 1024;
    this.stateWriteMs = opts.stateWriteMs ?? 250;
    this.state = this.loadState();
    const { entries, torn } = this.loadEntries();
    this.entries = entries;
    for (const e of entries) this.fileBytes += e.bytes;
    this.state.lastSeq = Math.max(this.state.lastSeq, entries.at(-1)?.msg.seq ?? 0);
    this.advanceHead(this.state.ackedSeq);
    // A crash mid-append leaves a torn last line: rewrite, so the next append gets its own line.
    if (torn) this.compact();
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

  /** Assign the next seq, persist the event, and return the wire message. */
  append(event: RunnerEvent): RunnerEventMessage {
    this.state.lastSeq += 1;
    const msg: RunnerEventMessage = {
      type: "event",
      seq: this.state.lastSeq,
      ts: new Date().toISOString(),
      event,
    };
    const line = `${JSON.stringify(msg)}\n`;
    appendFileSync(this.file, line);
    const bytes = Buffer.byteLength(line);
    this.entries.push({ msg, bytes });
    this.fileBytes += bytes;
    return msg;
  }

  /** Acknowledge everything with `seq <= seq` (cumulative ack). */
  ack(seq: number): void {
    const upTo = Math.min(seq, this.state.lastSeq);
    if (upTo <= this.state.ackedSeq) return;
    this.state.ackedSeq = upTo;
    this.advanceHead(upTo);
    if (this.compactDue()) this.compact();
    else this.scheduleStateWrite();
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

  /** Persist the acked position and drop acked events from the file (runner shutdown). */
  close(): void {
    if (this.head > 0) this.compact();
    else this.writeState();
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

  /** Rewrite the file without its acked events. State first, so `lastSeq` outlives them. */
  private compact(): void {
    this.writeState();
    const live = this.entries.slice(this.head);
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, live.map((e) => `${JSON.stringify(e.msg)}\n`).join(""));
    renameSync(tmp, this.file);
    this.entries = live;
    this.head = 0;
    this.fileBytes -= this.ackedBytes;
    this.ackedBytes = 0;
  }

  private scheduleStateWrite(): void {
    if (this.stateTimer) return;
    this.stateTimer = setTimeout(() => {
      this.stateTimer = undefined;
      try {
        this.writeState();
      } catch {
        // Only the acked position is late; the next write or `close` catches up.
      }
    }, this.stateWriteMs);
    this.stateTimer.unref();
  }

  private writeState(): void {
    if (this.stateTimer) clearTimeout(this.stateTimer);
    this.stateTimer = undefined;
    this.persistState(this.state);
  }

  private persistState(state: JournalState): void {
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
    this.persistState(fresh);
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

import {
  type AgentEventOf,
  itemDeltaText,
  mergeItemDeltas,
  type RunnerEvent,
} from "@codeden/contracts";

/** How long a streamed delta may wait for more of the same item: short enough to look live. */
export const DELTA_WINDOW_MS = 50;
/** A batch is passed on once it holds this many characters. */
export const DELTA_MAX_CHARS = 16 * 1024;

export interface DeltaBatcherOptions {
  /** Default `DELTA_WINDOW_MS`. */
  windowMs?: number;
  /** Default `DELTA_MAX_CHARS`. */
  maxChars?: number;
}

interface Batch {
  delta: AgentEventOf<"item.delta">;
  chars: number;
  timer: ReturnType<typeof setTimeout>;
}

/**
 * Batches streamed `item.delta` events on their way to the journal. Every event the runner
 * journals is also a send, a server transaction and an ack, and providers stream an answer a
 * few characters at a time. Per session, consecutive deltas that extend the same item the
 * same way (`mergeItemDeltas`) are merged and passed on as one: after `windowMs`, once the
 * batch holds `maxChars`, or right before any other event of that session, whoever emits it
 * (the session's provider, a checkpoint command, workspace setup). An event that belongs to
 * no session (a terminal exiting, a drain) passes every batch on first. So no event overtakes
 * a delta that came before it, and only deltas ever wait.
 */
export class DeltaBatcher {
  private readonly batches = new Map<string, Batch>();

  constructor(
    private readonly out: (event: RunnerEvent) => void,
    private readonly opts: DeltaBatcherOptions = {},
  ) {}

  push(event: RunnerEvent): void {
    if (event.kind === "agent" && event.event.type === "item.delta") {
      this.add(event.sessionId, event.event);
      return;
    }
    this.flush("sessionId" in event ? event.sessionId : undefined);
    this.out(event);
  }

  /** Pass on the pending batch of one session, or of every session. */
  flush(sessionId?: string): void {
    if (sessionId === undefined) {
      for (const id of [...this.batches.keys()]) this.flush(id);
      return;
    }
    const batch = this.batches.get(sessionId);
    if (!batch) return;
    clearTimeout(batch.timer);
    this.batches.delete(sessionId);
    this.out({ kind: "agent", sessionId, event: batch.delta });
  }

  private add(sessionId: string, delta: AgentEventOf<"item.delta">): void {
    const chars = itemDeltaText(delta.delta).length;
    let batch = this.batches.get(sessionId);
    const merged = batch && mergeItemDeltas(batch.delta, delta);
    if (batch && merged) {
      batch.delta = merged;
      batch.chars += chars;
    } else {
      this.flush(sessionId);
      const windowMs = this.opts.windowMs ?? DELTA_WINDOW_MS;
      batch = { delta, chars, timer: setTimeout(() => this.flush(sessionId), windowMs) };
      this.batches.set(sessionId, batch);
    }
    if (batch.chars >= (this.opts.maxChars ?? DELTA_MAX_CHARS)) this.flush(sessionId);
  }
}

import {
  type AgentEvent,
  type AgentEventOf,
  itemDeltaText,
  mergeItemDeltas,
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

/**
 * Batches one session's streamed `item.delta` events. Every event the runner emits is a
 * journal append, a send, a server transaction and an ack, and providers stream an answer a
 * few characters at a time. Consecutive deltas that extend the same item the same way
 * (`mergeItemDeltas`) are merged and passed on as one: after `windowMs`, once the batch holds
 * `maxChars`, or right before any other event of the session. Every other event (turns,
 * items, approvals, questions) passes through at once, so the order is unchanged.
 */
export class DeltaBatcher {
  private pending: AgentEventOf<"item.delta"> | undefined;
  private chars = 0;
  private timer: ReturnType<typeof setTimeout> | undefined;

  constructor(
    private readonly out: (event: AgentEvent) => void,
    private readonly opts: DeltaBatcherOptions = {},
  ) {}

  push(event: AgentEvent): void {
    if (event.type !== "item.delta") {
      this.flush();
      this.out(event);
      return;
    }
    const merged = this.pending && mergeItemDeltas(this.pending, event);
    if (merged) {
      this.pending = merged;
    } else {
      this.flush();
      this.pending = event;
      this.timer = setTimeout(() => this.flush(), this.opts.windowMs ?? DELTA_WINDOW_MS);
    }
    this.chars += itemDeltaText(event.delta).length;
    if (this.chars >= (this.opts.maxChars ?? DELTA_MAX_CHARS)) this.flush();
  }

  /** Pass on the pending batch now, if there is one. */
  flush(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    const batch = this.pending;
    this.pending = undefined;
    this.chars = 0;
    if (batch) this.out(batch);
  }
}

import type { RunnerEventMessage } from "@codeden/contracts";

/** Most runner events stored in one transaction. */
export const INTAKE_MAX_BATCH = 256;

/**
 * Collects the runner's durable events as they arrive and hands them on in batches: everything
 * that arrived since the last batch, once the event loop has served other I/O (`setImmediate`),
 * at most `maxBatch` at a time. A burst of streamed deltas is then stored in one transaction
 * instead of one each, and HTTP requests get a turn between batches. `flush` hands on what is
 * queued right away; the client calls it before any other runner message, so events are always
 * stored before the messages that came after them are handled.
 */
export class RunnerEventIntake {
  private queue: RunnerEventMessage[] = [];
  private scheduled: ReturnType<typeof setImmediate> | undefined;

  constructor(
    private readonly store: (batch: RunnerEventMessage[]) => void,
    private readonly maxBatch = INTAKE_MAX_BATCH,
  ) {}

  push(msg: RunnerEventMessage): void {
    this.queue.push(msg);
    this.schedule();
  }

  /** Store everything queued now. */
  flush(): void {
    if (this.scheduled) clearImmediate(this.scheduled);
    this.scheduled = undefined;
    while (this.queue.length > 0) this.store(this.queue.splice(0, this.maxBatch));
  }

  private schedule(): void {
    this.scheduled ??= setImmediate(() => {
      this.scheduled = undefined;
      const batch = this.queue.splice(0, this.maxBatch);
      if (this.queue.length > 0) this.schedule();
      if (batch.length > 0) this.store(batch);
    });
  }
}

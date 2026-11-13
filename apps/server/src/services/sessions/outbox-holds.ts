import { runnerErrorCode } from "../runner-port";

/** Runner failures worth retrying: the runner is away or slow, not refusing the message. */
export function isTransientRunnerError(error: unknown): boolean {
  const code = runnerErrorCode(error);
  return code === "runner_unavailable" || code === "timeout";
}

/** The provider's words when it refuses a turn because one is running. */
export const TURN_RUNNING_TEXT = /turn is already running/i;

/**
 * The runner refused a new turn because the provider is still running one, which the server
 * had not seen yet. Not a failure: the message waits for that turn to end. Runners before
 * `turn_running` report it as `command_failed` with the provider's message.
 */
export function isTurnRunningError(error: unknown): boolean {
  const code = runnerErrorCode(error);
  if (code === "turn_running") return true;
  return (
    code === "command_failed" && error instanceof Error && TURN_RUNNING_TEXT.test(error.message)
  );
}

/**
 * Sessions whose queued-message delivery failed. The message went back in its place and
 * delivery pauses, so a failing send never loops on the status change it causes. It resumes
 * after `retryMs` when the failure was transient, when the runner is ready again
 * (`releaseAll`), or once any message reaches the session (`release`).
 */
export class OutboxHolds {
  private readonly held = new Map<string, NodeJS.Timeout | undefined>();

  constructor(
    private readonly opts: {
      /** Wait before retrying a transient failure (default 30 s). */
      retryMs?: number;
      /** Retry delivery for a session whose hold ran out. */
      onRetry: (sessionId: string) => void;
    },
  ) {}

  isHeld(sessionId: string): boolean {
    return this.held.has(sessionId);
  }

  /** Pause delivery; `retry` resumes it on its own after the retry delay. */
  hold(sessionId: string, retry: boolean): void {
    this.release(sessionId);
    const timer = retry
      ? setTimeout(() => {
          this.held.delete(sessionId);
          this.opts.onRetry(sessionId);
        }, this.opts.retryMs ?? 30_000)
      : undefined;
    timer?.unref?.();
    this.held.set(sessionId, timer);
  }

  release(sessionId: string): void {
    const timer = this.held.get(sessionId);
    if (timer) clearTimeout(timer);
    this.held.delete(sessionId);
  }

  releaseAll(): void {
    for (const id of [...this.held.keys()]) this.release(id);
  }
}

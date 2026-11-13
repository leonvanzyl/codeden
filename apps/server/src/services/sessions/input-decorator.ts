import type { QueueSender, Session, UserInput } from "@codeden/contracts";
import { runnerErrorCode } from "../runner-port";

/**
 * A turn's input as rewritten at send time, with what to do once the runner took the turn
 * (`delivered`) or could not (`failed`, with the error): orchestration only counts the notices
 * it carries as delivered when they actually reached the session.
 */
export interface DecoratedInput {
  input: UserInput;
  delivered?: () => void;
  failed?: (error: unknown) => void;
}

/**
 * Rewrites a turn's input at send time. `from` is who sent the input that starts the turn, so
 * orchestration can tell the turns the user started from automatic ones (the loop guard).
 */
export type InputDecorator = (
  session: Session,
  input: UserInput,
  from: QueueSender,
) => DecoratedInput;

/**
 * Failures that leave unknown whether the runner started the turn: the command timed out, the
 * connection dropped (or was never there: the code is the same), or its answer was unreadable
 * (`runner_error`). The runner may have accepted the input before that. Any other failure is a
 * definite refusal (the runner answered with its reason, or the server never sent it).
 */
export function mayHaveStarted(error: unknown): boolean {
  const code = runnerErrorCode(error);
  return (
    code === undefined ||
    code === "timeout" ||
    code === "runner_unavailable" ||
    code === "runner_error"
  );
}

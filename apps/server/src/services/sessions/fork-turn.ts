import type { Session } from "@codeden/contracts";
import { badRequest, conflict, notFound, type ServiceError } from "../errors";
import { runnerErrorCode } from "../runner-port";
import type { SessionRepo } from "./repo";

/**
 * Where a fork that names a turn ("Fork from here", §9) starts: through the end of `turnId`,
 * the source's turn number `turnNumber`. An earlier turn is copied up to its fork point
 * (`upTo`) and its own checkpoint (`checkpoint`, from the server's projection); the latest turn
 * is the latest moment, forked as a whole.
 */
export type ForkTurn = { turnId: string; turnNumber: number } & (
  | { latest: true }
  | { latest: false; upTo: string; checkpoint: number }
);

/** Runner error code (from the provider): the conversation no longer holds the fork point. */
const FORK_POINT_MISSING = "fork_point_missing";

/**
 * Check that `source` can be forked at `turnId`, before asking the runner anything: a turn of
 * its own root thread that has ended, and (unless it is the latest) one whose end recorded a
 * fork point and a checkpoint. Throws `ServiceError`s.
 */
export function forkTurn(repo: SessionRepo, source: Session, turnId: string): ForkTurn {
  const turn = repo.turn(source.id, turnId);
  if (!turn) throw notFound("The session has no such turn", "turn_not_found");
  if (turn.threadId !== source.rootThreadId) {
    throw badRequest("Only the session's own turns can be forked from", "fork_unsupported");
  }
  if (turn.status === "running") {
    throw conflict("Wait for the turn to finish before forking from it", "turn_running");
  }
  const rootTurns = repo.rootTurnIds(source);
  const turnNumber = rootTurns.indexOf(turnId) + 1;
  if (rootTurns.at(-1) === turnId) return { turnId, turnNumber, latest: true };
  if (!turn.forkPoint) {
    throw conflict(
      "This turn can't be forked from: the provider didn't record where its conversation ended",
      "fork_point_unavailable",
    );
  }
  const checkpoint = repo.turnCheckpoint(source.id, turnId);
  if (checkpoint === null) {
    throw conflict("CodeDen has no snapshot of the code at the end of this turn", "no_checkpoint");
  }
  return { turnId, turnNumber, latest: false, upTo: turn.forkPoint, checkpoint };
}

/**
 * The checkpoint of an earlier turn, once the runner confirms it still has it (`indexes` from
 * its settled list). Throws 409 `no_checkpoint` when it doesn't.
 */
export function confirmedCheckpoint(at: ForkTurn & { latest: false }, indexes: number[]): number {
  if (!indexes.includes(at.checkpoint)) {
    throw conflict("CodeDen has no snapshot of the code at the end of this turn", "no_checkpoint");
  }
  return at.checkpoint;
}

/**
 * A provider that no longer finds the fork point in the conversation (it was replaced or
 * deleted since the turn ended) answers 409 `fork_point_missing`; anything else is left to
 * the usual runner error mapping.
 */
export function forkPointMissing(error: unknown): ServiceError | null {
  if (runnerErrorCode(error) !== FORK_POINT_MISSING) return null;
  const detail = error instanceof Error ? ` (${error.message})` : "";
  return conflict(
    `This turn can't be forked from any more: its conversation changed since it ended${detail}`,
    FORK_POINT_MISSING,
  );
}

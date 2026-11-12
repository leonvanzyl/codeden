import type { Session } from "@codeden/contracts";
import { badRequest, conflict, notFound } from "../errors";
import type { SessionRepo } from "./repo";

/**
 * Where a fork that names a turn ("Fork from here", §9) starts: through the end of `turnId`.
 * An earlier turn is copied up to its fork point (`upTo`) and its own checkpoint (`checkpoint`,
 * from the server's projection); the latest turn is the latest moment, forked as a whole.
 */
export type ForkTurn =
  | { turnId: string; latest: true }
  | { turnId: string; latest: false; upTo: string; checkpoint: number };

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
  if (repo.latestRootTurnId(source) === turnId) return { turnId, latest: true };
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
  return { turnId, latest: false, upTo: turn.forkPoint, checkpoint };
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

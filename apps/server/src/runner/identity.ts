import { eq } from "drizzle-orm";
import type { Db } from "../db/client";
import { runnerState, runners, sessions } from "../db/schema";

/**
 * Why a runner's `welcome` must be refused, or `null` to accept it (`docs/remote-runners.md`
 * §8). The journal id a runner reports (`welcome.runnerId`) keys its ack position
 * (`runner_state`) and routes sessions to it (`sessions.runnerId`), and a sandbox runner can
 * report any id it likes, so:
 *
 * - No runner may report a journal id another runner record carries, deleted records included
 *   (their sessions would route to it): it would share that runner's ack position, so that
 *   runner's next events would look like replays and be dropped, and it would be sent that
 *   runner's sessions.
 * - An untrusted runner (any but the home runner) keeps the journal id it first connected with:
 *   under a new one, the sessions routed to its old id would match no record and fall back to
 *   the home runner. The home runner may come back with a new id (its journal was reset).
 * - An untrusted runner's first journal id must be new to the server: no session may carry it
 *   and no ack position may exist for it. An id only a session or `runner_state` still holds
 *   (the home runner's from before a journal reset, say) would otherwise hand it those
 *   sessions, which route to the home runner today, and their ack position. A backend that
 *   assigns journal ids itself records the id on the runner's record before placing sessions
 *   under it, which makes it the runner's own.
 *
 * `recordId` is the connecting runner's own record (`runners.id`).
 */
export function journalIdRefusal(
  db: Db,
  recordId: string,
  runnerId: string,
  untrusted: boolean,
): string | null {
  const holder = db
    .select({ id: runners.id })
    .from(runners)
    .where(eq(runners.runnerId, runnerId))
    .all()
    .find((row) => row.id !== recordId);
  if (holder) return `journal id ${runnerId} belongs to runner ${holder.id}`;
  if (!untrusted) return null;
  const own = db
    .select({ runnerId: runners.runnerId })
    .from(runners)
    .where(eq(runners.id, recordId))
    .get();
  if (own?.runnerId) {
    return own.runnerId === runnerId
      ? null
      : `journal id ${runnerId} is not its own (${own.runnerId})`;
  }
  const session = db
    .select({ id: sessions.id })
    .from(sessions)
    .where(eq(sessions.runnerId, runnerId))
    .limit(1)
    .get();
  if (session) return `journal id ${runnerId} is not new: sessions already carry it`;
  const acked = db
    .select({ runnerId: runnerState.runnerId })
    .from(runnerState)
    .where(eq(runnerState.runnerId, runnerId))
    .get();
  if (acked) return `journal id ${runnerId} is not new: events were already stored under it`;
  return null;
}

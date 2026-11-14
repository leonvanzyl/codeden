import { eq } from "drizzle-orm";
import type { Db } from "../db/client";
import { runners } from "../db/schema";

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
  if (own?.runnerId && own.runnerId !== runnerId) {
    return `journal id ${runnerId} is not its own (${own.runnerId})`;
  }
  return null;
}

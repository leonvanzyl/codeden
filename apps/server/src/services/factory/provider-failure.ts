import type { FactoryItem, Session } from "@codeden/contracts";
import type { InboxService } from "../inbox-service";
import type { SessionRepo } from "../sessions/repo";
import { PROVIDER_FAILURE_BACKOFF_MS, type Unavailable } from "./availability";

/**
 * A factory session that failed because of its provider rather than its work (§10.1, Provider
 * availability): the provider's usage limit, a sign-in problem, or a session that never
 * started. Read from the error kind the provider adapters give a failed turn.
 */

/** Nudge key prefix: this item's reviews skip the provider until the stored time. */
const SKIP = "reviewer_skip_";
/** Nudge key prefix counting an item's reviewer restarts after provider failures. */
const PROVIDER_FAILED = "reviewer_provider_failed_";
/** Provider failures in a row after which a dead reviewer counts as an ordinary failure. */
export const MAX_PROVIDER_RESTARTS = 5;

/**
 * Why `s` failed because of its provider, or null when it didn't (or didn't fail). A session
 * that could not start has the launcher's `run_failed` inbox item keyed `start`.
 */
export function providerFailure(
  repo: SessionRepo,
  inbox: Pick<InboxService, "find">,
  s: Session,
): Unavailable | null {
  if (s.status !== "failed" && s.status !== "idle") return null;
  const last = repo.rootTurnIds(s).at(-1);
  if (!last) {
    const notStarted = s.status === "failed" && inbox.find(`inbox:${s.id}:start`);
    return notStarted ? { reason: "failing to start", until: null } : null;
  }
  const turn = repo.turn(s.id, last);
  if (turn?.status !== "failed" || !turn.error) return null;
  if (turn.error.kind === "usage_limit") {
    return { reason: "at its usage limit", until: turn.error.retryAt ?? null };
  }
  if (turn.error.kind === "auth") return { reason: "not signed in", until: null };
  return null;
}

/** How many reviewers of the item failed because of their provider so far. */
export function providerRestarts(item: FactoryItem): number {
  let n = 0;
  while (item.nudges[`${PROVIDER_FAILED}${n + 1}`]) n++;
  return n;
}

/**
 * The nudges after a reviewer on `provider` failed because of it: the item's next reviewer
 * skips that provider until `until` (or a while), and the failure is counted.
 */
export function skipProvider(
  nudges: FactoryItem["nudges"],
  provider: string,
  until: string | null,
  now: Date,
): FactoryItem["nudges"] {
  const skipUntil =
    until && Date.parse(until) > now.getTime()
      ? until
      : new Date(now.getTime() + PROVIDER_FAILURE_BACKOFF_MS).toISOString();
  const n = providerRestarts({ nudges } as FactoryItem);
  return {
    ...nudges,
    [`${SKIP}${provider}`]: skipUntil,
    [`${PROVIDER_FAILED}${n + 1}`]: now.toISOString(),
  };
}

/** Providers this item's reviews skip right now, with until when. */
export function skippedProviders(
  item: FactoryItem,
  now: Date,
): Array<{ provider: string } & Unavailable> {
  return Object.entries(item.nudges).flatMap(([key, until]) =>
    key.startsWith(SKIP) && Date.parse(until) > now.getTime()
      ? [{ provider: key.slice(SKIP.length), reason: "failing to run reviews", until }]
      : [],
  );
}

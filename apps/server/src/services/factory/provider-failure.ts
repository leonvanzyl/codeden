import type { FactoryItem, Session } from "@codeden/contracts";
import type { InboxService } from "../inbox-service";
import type { SessionRepo } from "../sessions/repo";
import { PROVIDER_FAILURE_BACKOFF_MS, type Unavailable } from "./availability";

/**
 * A factory session that failed because of its provider rather than its work (§10.1, Provider
 * availability): the provider's usage limit, a sign-in problem, a CLI too old to run, or a
 * session that never started. Read from the error kind the provider adapters give a failed
 * turn, or a refused open (`Session.startError`).
 */

/** Nudge key prefix: this item's reviews skip the provider until the stored time. */
const SKIP = "reviewer_skip_";
/** Nudge key prefix counting an item's reviewer restarts after provider failures. */
const PROVIDER_FAILED = "reviewer_provider_failed_";
/** Provider failures in a row after which a dead reviewer counts as an ordinary failure. */
export const MAX_PROVIDER_RESTARTS = 5;
/**
 * A start that failed for a reason the provider didn't classify: it may be the item's own (its
 * worktree), so only that item's reviews skip the provider.
 */
const FAILING_TO_START = "failing to start";
/** A refused open the provider classified as `setup`: its CLI is older than CodeDen runs. */
const TOO_OLD = "too old to run (update it)";

/** Whether the failure keeps all new factory work off the provider, not just the item's reviews. */
export function providerWide(cause: Unavailable): boolean {
  return cause.reason !== FAILING_TO_START;
}

/**
 * Why `s` failed because of its provider, or null when it didn't (or didn't fail). A session
 * that could not start has the runner's report of the refused open (`startError`, with the
 * provider's classification: `setup` for a CLI too old to run, `auth` for one not signed in),
 * or the launcher's `run_failed` inbox item keyed `start`.
 */
export function providerFailure(
  repo: SessionRepo,
  inbox: Pick<InboxService, "find">,
  s: Session,
): Unavailable | null {
  if (s.status !== "failed" && s.status !== "idle") return null;
  const last = repo.rootTurnIds(s).at(-1);
  if (!last) {
    if (s.status !== "failed") return null;
    if (s.startError?.kind === "setup") return { reason: TOO_OLD, until: null };
    if (s.startError?.kind === "auth") return { reason: "not signed in", until: null };
    const notStarted = s.startError || inbox.find(`inbox:${s.id}:start`);
    return notStarted ? { reason: FAILING_TO_START, until: null } : null;
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

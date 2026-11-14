import { type FactoryItem, type GitHubPrRef, stoppedRetry } from "@codeden/contracts";
import type { FactoryContext } from "./context";
import type { FactoryPr } from "./github-port";
import { closeInboxFor } from "./merge";
import { MERGE_QUEUED } from "./queue";
import { headSeenAt } from "./rebase";
import { withoutRecheck } from "./recheck";
import { CLEAN_REVIEW, withoutStrikes } from "./review-environment";

/**
 * Stopped work with an open PR (§10.1, Ownership). An item whose revise rounds ran out keeps its
 * PR, and the PR often moves on afterwards: its builder resolves conflicts, or fixes a finding
 * after the last review. The verdict it stopped on then no longer covers the PR. So the loop
 * records the head each verdict covers, and a failed item whose open, mergeable PR has a newer
 * head with CI green goes back to a fresh review by itself, with no new build: it merges on
 * approve as usual, and a request for changes gets one more revise round. Once per head, at
 * most `MAX_AUTO_REREVIEWS` times per item. Retry does the same with the PR open (fresh revise
 * rounds). Either review runs in a clean worktree on the PR's head, so it sees every commit.
 */

/** Automatic re-reviews per item (each also allows one more revise round). */
export const MAX_AUTO_REREVIEWS = 3;

/** `verdict_<sha>`: the PR head the item's last recorded verdict covers. */
const VERDICT = "verdict_";
/** `auto_rereview_<sha>`: the loop sent the stopped item back to review for that head. */
const AUTO = "auto_rereview_";

/** The PR head the item's last recorded verdict covers; null when unknown. */
export function verdictHead(item: Pick<FactoryItem, "nudges">): string | null {
  const key = Object.keys(item.nudges).find((k) => k.startsWith(VERDICT));
  return key ? key.slice(VERDICT.length) : null;
}

/** The nudges recording that the item's latest verdict covers `head`. */
export function withVerdictHead(
  nudges: FactoryItem["nudges"],
  head: string | null,
  at: string,
): FactoryItem["nudges"] {
  const rest = Object.fromEntries(Object.entries(nudges).filter(([k]) => !k.startsWith(VERDICT)));
  return head ? { ...rest, [`${VERDICT}${head}`]: at } : rest;
}

/** How many times the loop sent the item back to review by itself. */
export function autoReReviews(item: Pick<FactoryItem, "nudges">): number {
  return Object.keys(item.nudges).filter((k) => k.startsWith(AUTO)).length;
}

/** Revise rounds the item may use: the tuning's, plus one per automatic re-review. */
export function reviseRoundsAllowed(item: FactoryItem, maxFixAttempts: number): number {
  return maxFixAttempts + autoReReviews(item);
}

/** Whether a nudge belongs to these records (kept when the item starts afresh, `recover.ts`). */
export function isReReviewRecord(key: string): boolean {
  return key.startsWith(VERDICT) || key.startsWith(AUTO);
}

/**
 * Stopped on its merge checks with the PR still worth reviewing: not stuck, not a failure
 * outside its code (`recover.ts` has those), not waiting on the PM over its size, and not
 * rejected by its reviewer.
 */
function stoppedOnChecks(item: FactoryItem): boolean {
  if (item.stage !== "failed" || item.review?.verdict === "reject") return false;
  if (item.failureKind !== "checks") return false;
  return !item.checks.some((c) => c.name === "size" && c.state === "fail");
}

/**
 * Whether `head` is newer than what the item's last verdict covers. Without a record (a verdict
 * from before heads were recorded, or none), a head first seen after the item stopped is.
 */
function newerThanVerdict(item: FactoryItem, head: string): boolean {
  const reviewed = verdictHead(item);
  if (reviewed) return reviewed !== head;
  const seen = headSeenAt(item, head);
  return Boolean(seen && item.finishedAt && Date.parse(seen) > Date.parse(item.finishedAt));
}

/**
 * Whether a failed item's PR goes back to review by itself: `now`, `after_ci` (its new head is
 * still waiting for CI), or null (it stays with a person's Retry).
 */
export function autoReReview(
  item: FactoryItem,
  pr: Pick<FactoryPr, "headSha" | "mergeable" | "checks">,
  requireCi: boolean,
): "now" | "after_ci" | null {
  const head = pr.headSha;
  if (!head || pr.mergeable !== "mergeable" || !stoppedOnChecks(item)) return null;
  if (!newerThanVerdict(item, head) || item.nudges[`${AUTO}${head}`]) return null;
  if (autoReReviews(item) >= MAX_AUTO_REREVIEWS) return null;
  if (pr.checks === "success" || (pr.checks === "none" && !requireCi)) return "now";
  return pr.checks === "pending" ? "after_ci" : null;
}

/**
 * The note on a failed item whose open PR is `pr`: the shared label (`stoppedRetry`), and when
 * the loop will re-review its new head by itself (`waiting`: once CI passes, or once the paused
 * factory resumes). Null when another note says more (stuck work, a size decision the PM owes).
 */
export function stoppedNote(
  item: FactoryItem,
  pr: GitHubPrRef,
  waiting: "ci" | "resume" | null = null,
): string | null {
  const label = stoppedRetry({ ...item, pr })?.label;
  if (!label) return null;
  if (waiting === "ci") return `${label}. Its new head is re-reviewed by itself once CI passes`;
  if (waiting === "resume") return `${label}. Its new head is re-reviewed once the factory resumes`;
  return label;
}

/** Nudges of the stopped attempt that would hold up a fresh review. */
function stale(key: string): boolean {
  return (
    [
      "ready",
      "ready_checked",
      MERGE_QUEUED,
      "reviewer",
      "rereview_pending",
      "rereview_sent",
      "reviewer_restarted",
    ].includes(key) || key.startsWith("conflict_from_")
  );
}

/**
 * Send a stopped item's open PR back to a fresh review (no new build, the same PR). The earlier
 * reviewer is let go (archived once idle); the next one reviews the PR's current head in a clean
 * worktree. `retry`: a person or the PM asked, so the revise rounds start afresh; otherwise
 * (`autoHead`) the loop did, once for that head.
 */
export function resumeReview(
  ctx: FactoryContext,
  item: FactoryItem,
  pr: GitHubPrRef,
  opts: { note: string; retry?: boolean; autoHead?: string },
): FactoryItem {
  const at = ctx.now().toISOString();
  const resumed = ctx.store.updateItem(item.id, (i) => ({
    ...i,
    stage: "verifying",
    pr,
    review: null,
    attempts: opts.retry ? 0 : i.attempts,
    reviewerSessionId: null,
    reviewerProvider: null,
    reviewerNote: null,
    reason: null,
    failureKind: null,
    finishedAt: null,
    // Cleanup archived its sessions; a revise round needs the builder again (a message brings
    // it back), and they are archived again once the item is done.
    sessionsArchivedAt: null,
    earlierSessionIds: i.reviewerSessionId
      ? [...new Set([...i.earlierSessionIds, i.reviewerSessionId])]
      : i.earlierSessionIds,
    note: opts.note,
    nudges: {
      // A full review replaces a re-check still owed and the environment strikes; a retry
      // also starts the automatic re-reviews afresh.
      ...Object.fromEntries(
        Object.entries(withoutRecheck(withoutStrikes(i.nudges))).filter(
          ([k]) => !stale(k) && !(opts.retry && k.startsWith(AUTO)),
        ),
      ),
      [CLEAN_REVIEW]: at,
      verifying: at,
      ...(opts.autoHead ? { [`${AUTO}${opts.autoHead}`]: at } : {}),
    },
  }));
  // What waited on a person about the stopped PR (stuck, ready) no longer does.
  closeInboxFor(ctx, item.id, "Back in review");
  return resumed;
}

import { z } from "zod";
import { type GitHubPrRef, Id } from "./common";
import type { FactoryItemStage } from "./factory-api";
import type { FactoryFailureKind } from "./factory-prs";

/**
 * Running stopped factory work again (§10.1, Stopped work with an open PR): the Retry request,
 * and `stoppedRetry`, the one rule for whether an item can be retried, what Retry does by
 * default, and the label saying what a failed item needs. The server, the panel and the
 * Factory view all read it, so they never disagree.
 */

/**
 * How a stopped item runs again. `rereview`: its open pull request goes straight back to a fresh
 * review of its current head (then a revise round, or the merge, as usual), with no new build and
 * no second PR. `rebuild`: a fresh attempt from the pipeline's first step (reproduce or analyze);
 * its open PR is closed with a link once the new one is open.
 */
export const FactoryRetryMode = z.enum(["rereview", "rebuild"]);
export type FactoryRetryMode = z.infer<typeof FactoryRetryMode>;

/**
 * The body of `POST /api/projects/:id/factory/items/:itemId/retry`. Without a mode, an item whose
 * pull request is still open is re-reviewed, and any other is rebuilt.
 */
export const FactoryRetryOptions = z.object({
  mode: FactoryRetryMode.optional().describe(
    "`rereview` (the default when its pull request is open): a fresh review of the open PR, no new build. `rebuild`: start over from the first step, replacing the PR.",
  ),
});
export type FactoryRetryOptions = z.infer<typeof FactoryRetryOptions>;

/** Run a stopped (failed or rejected) item again: the PM's `factory_retry_item`. */
export const FactoryRetryRequest = FactoryRetryOptions.extend({ itemId: Id });
export type FactoryRetryRequest = z.infer<typeof FactoryRetryRequest>;

/** What `stoppedRetry` reads: a `FactoryItem` or a panel `FactoryWorkItem` both fit. */
export interface StoppedItem {
  stage: FactoryItemStage;
  /** Its own PR, with its state as last read (the server passes the synced state). */
  pr: GitHubPrRef | null;
  failureKind: FactoryFailureKind | null;
  /** Revise rounds used. */
  attempts: number;
  reason: string | null;
}

/** What Retry offers a stopped item. */
export interface StoppedRetry {
  /** What Retry does by default: `rereview` while its own PR is open, otherwise `rebuild`. */
  mode: FactoryRetryMode;
  /** The open PR a re-review resumes; null when there is none (only `rebuild` applies). */
  pr: GitHubPrRef | null;
  /**
   * What a failed item with an open PR needs, plainly: "Stopped after N revise rounds; needs a
   * re-review (Retry)". Null when its reason says more (stuck work is in the inbox; work over the
   * size limit waits on the PM) or it has no open PR. Never "waiting for a person to merge",
   * which only escalated work is.
   */
  label: string | null;
}

/** A failure on the size limit: the PM splits it or allows it, so no re-review is asked for. */
const SIZE_FAILURE = /(^|; )size: /;

/**
 * Whether a factory item can be retried, and how: stopped work (failed or rejected) can; anything
 * else (null) can't.
 */
export function stoppedRetry(item: StoppedItem): StoppedRetry | null {
  if (item.stage !== "failed" && item.stage !== "rejected") return null;
  const open = item.pr?.state === "open" || item.pr?.state === "draft";
  const pr = open ? item.pr : null;
  const needsReview =
    pr !== null &&
    item.stage === "failed" &&
    item.failureKind !== "stuck" &&
    !SIZE_FAILURE.test(item.reason ?? "");
  const n = item.attempts;
  return {
    mode: pr ? "rereview" : "rebuild",
    pr,
    label: needsReview
      ? `Stopped after ${n} revise round${n === 1 ? "" : "s"}; needs a re-review (Retry)`
      : null,
  };
}

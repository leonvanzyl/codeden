import type { FactoryItem, FactoryLoop, ReviewVerdict } from "@codeden/contracts";
import type { FactoryContext } from "./context";
import { failItem } from "./outcomes";
import { REINSTALL } from "./prompts";

/**
 * A reviewer whose own checkout can't verify the change (§10.1, #206): a half-finished install,
 * a corrupted dependency, timeouts under load. That is no defect of the pull request, and CI on
 * its head runs the full suite on a clean machine, so a request for changes marked
 * `blockers: "environment"` never becomes a revise round and never reaches the author. The
 * reviewer is told the CI result and reviews again on the merits. When its environment stops it
 * again, the item fails as an infrastructure failure (the loop puts it back by itself, without
 * using a revise round), and its next reviewer works in a clean worktree on the PR's head
 * instead of the author's.
 */

/** Nudges counting the reviewer's environment-only verdicts (`review_env_1`, ...). */
const STRIKE = "review_env_";

/** Nudge: the item's reviews run in a clean worktree on the PR's head, not the author's. */
export const CLEAN_REVIEW = "review_clean_worktree";

/** A request for changes the reviewer says only its own environment stands behind. */
export function environmentOnly(verdict: ReviewVerdict): boolean {
  return verdict.verdict === "request_changes" && verdict.blockers === "environment";
}

/** How many environment-only verdicts the item's current reviewer sent. */
export function environmentStrikes(item: FactoryItem): number {
  let n = 0;
  while (item.nudges[`${STRIKE}${n + 1}`]) n++;
  return n;
}

/** The nudges without the environment-only count: a recorded verdict starts it again. */
export function withoutStrikes(nudges: FactoryItem["nudges"]): FactoryItem["nudges"] {
  return Object.fromEntries(Object.entries(nudges).filter(([k]) => !k.startsWith(STRIKE)));
}

/** What CI on the PR's head says, from the item's last merge checks. */
function ciResult(item: FactoryItem): string {
  const ci = item.checks.find((c) => c.name === "ci");
  switch (ci?.state) {
    case "pass":
      return "CI on the pull request's head passed";
    case "fail":
      return `CI on the pull request's head failed (${ci.detail ?? "see the PR"}), which already sends it back to the author`;
    case "skipped":
      return "No CI runs on this repository, so the author's test results in the pull request are the evidence";
    default:
      return "CI on the pull request's head hasn't finished yet, and the merge checks wait for it to pass";
  }
}

const NOT_A_CAUSE =
  "a request for changes needs a cause in the pull request (a defect, a criterion not met, or red CI), and your local environment isn't one.";

/** `factory_submit_review` with an environment-only request for changes (never recorded). */
export function environmentBlocked(
  ctx: FactoryContext,
  item: FactoryItem,
): { recorded: false; message: string } {
  if (item.stage !== "verifying") {
    return {
      recorded: false,
      message: `Not recorded, and not passed to the author: ${NOT_A_CAUSE} You will be asked to review the revision; judge it on its code and CI.`,
    };
  }
  if (environmentStrikes(item) > 0) {
    replaceBlockedReviewer(
      ctx,
      ctx.store.loopOrNew(item.projectId, ctx.now()),
      item,
      "couldn't verify the change in its local environment again",
    );
    return {
      recorded: false,
      message:
        "Not recorded. Your local environment couldn't verify the change again, so a fresh reviewer reviews it in a clean worktree. Your review ends here: don't submit another verdict.",
    };
  }
  const at = ctx.now().toISOString();
  ctx.store.updateItem(item.id, (i) => ({
    ...i,
    note: "The reviewer's local environment couldn't verify the change: it reviews again with the CI result",
    nudges: { ...i.nudges, [`${STRIKE}1`]: at },
  }));
  return {
    recorded: false,
    message: [
      `Not recorded, and not sent to the author: ${NOT_A_CAUSE}`,
      `${ciResult(item)}. CI runs the full suite on a clean machine and is the authority for it.`,
      `If your install is broken, reinstall the dependencies cleanly and non-interactively (for pnpm: ${REINSTALL}) and run what you can.`,
      "Then submit a fresh verdict judged on the code: `approve` when it is right (the merge checks still wait for CI to pass), saying which local checks couldn't run and why; or `request_changes` naming a defect in the pull request. If your environment stops you again, a fresh reviewer takes over in a clean worktree.",
    ].join("\n"),
  };
}

/**
 * The reviewer's environment kept it from verifying the change: the item fails as an
 * infrastructure failure (no revise round; the loop puts it back by itself), the reviewer is
 * let go (archived once idle) and the next one reviews in a clean worktree on the PR's head.
 */
export function replaceBlockedReviewer(
  ctx: FactoryContext,
  loop: FactoryLoop,
  item: FactoryItem,
  why: string,
): FactoryLoop {
  const at = ctx.now().toISOString();
  const current = ctx.store.updateItem(item.id, (i) => ({
    ...i,
    reviewerSessionId: null,
    earlierSessionIds: i.reviewerSessionId
      ? [...new Set([...i.earlierSessionIds, i.reviewerSessionId])]
      : i.earlierSessionIds,
    nudges: { ...i.nudges, [CLEAN_REVIEW]: at },
  }));
  return failItem(
    ctx,
    loop,
    current,
    `review: the reviewer ${why} (${ciResult(item)}); a fresh reviewer reviews it in a clean worktree`,
    { kind: "infrastructure" },
  );
}

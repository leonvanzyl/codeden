import type { FactoryItem, FactoryLoop, GitHubPrRef, Project } from "@codeden/contracts";
import { errorMessage } from "../errors";
import type { FactoryContext } from "./context";
import type { FactoryPr } from "./github-port";
import { prDecidedOutside } from "./merge";
import {
  advanceConflicting,
  baseBranchOf,
  lastRebaseAsk,
  MAX_REBASE_ASKS,
  prAgent,
  rebaseAsks,
  trackHead,
} from "./rebase";
import { adoptAgentPr, rebuildOriginal } from "./rebuild";
import { recoverable } from "./recover";
import {
  autoReReview,
  autoReReviews,
  MAX_AUTO_REREVIEWS,
  resumeReview,
  stoppedNote,
} from "./rereview";
import { isBusy } from "./sessions";

/**
 * Ownership (§10.1): the loop owns every PR the factory opened until it merges or closes,
 * whatever the item's stage. Verification looks after its own PRs; this step looks after the
 * PRs of items that ended `failed` or `escalated`. A person merging or closing one finishes its
 * item; one that becomes conflicting is rebased (not a revise round), or rebuilt after three
 * requests, so nobody ever opens a factory PR that rotted into conflicts. A failed item whose PR
 * moved past its last review goes back to review by itself (`rereview.ts`); otherwise it waits
 * for a Retry. A rebuild that ended without its new PR leaves the PR it was replacing with the
 * item. The factory never merges these from here: escalated work is a person's to merge.
 */

/** How often an owned PR outside verification is read from GitHub (its mergeability). */
export const OWNED_RECHECK_MS = 5 * 60_000;

const CHECKED = "owned_checked";

function note(ctx: FactoryContext, item: FactoryItem, text: string): void {
  ctx.store.updateItem(item.id, (i) => ({ ...i, note: text }));
}

/**
 * Failed and escalated work waits for a person, so it is not work in flight: while the loop is
 * paused or draining (`drain.ts`) it starts no agent turn (a rebase, a re-review).
 */
function holdsAgentTurns(loop: FactoryLoop): boolean {
  return loop.state === "paused" || Boolean(loop.drain);
}

export async function advanceOwned(
  ctx: FactoryContext,
  project: Project,
  loop: FactoryLoop,
  item: FactoryItem,
): Promise<FactoryLoop> {
  if (!item.pr) {
    const original = rebuildOriginal(item);
    if (original) await advanceOriginal(ctx, project, item, original);
    return loop;
  }
  // An integrator that opened a new PR for the work: the item follows it (still a person's to
  // merge), and the old one is closed with a link (`closeReplacedPrs`).
  const before = item.pr.number;
  item = adoptAgentPr(ctx, project, item);
  if (!item.pr) return loop;
  const adopted = item.pr.number !== before;
  // Merged or closed by a person: the synced PR says so, no API call.
  const ref = ctx.github.prRef(project.id, item.pr.number);
  if (ref && (ref.state === "merged" || ref.state === "closed")) {
    prDecidedOutside(ctx, item, ref);
    return loop;
  }
  // A failure outside its code goes back to verification by itself (`recover.ts`).
  if (recoverable(item)) return loop;
  if (!adopted && !due(ctx, item)) return loop;
  let pr: FactoryPr;
  try {
    pr = await ctx.github.prDetails(project.id, item.pr.number);
  } catch (error) {
    note(ctx, item, `Could not read the PR: ${errorMessage(error)}`);
    return loop;
  }
  ctx.prFiles.set(project.id, pr.ref.number, pr.files);
  const at = ctx.now().toISOString();
  const current = ctx.store.updateItem(item.id, (i) => ({
    ...i,
    pr: pr.ref,
    nudges: { ...trackHead(i.nudges, pr, at).nudges, [CHECKED]: at },
  }));
  if (pr.ref.state === "merged" || pr.ref.state === "closed") {
    prDecidedOutside(ctx, current, pr.ref);
    return loop;
  }
  if (pr.mergeable !== "conflicting") {
    const resolved = rebaseAsks(item) > 0 && pr.mergeable === "mergeable";
    if (current.stage === "failed") return settleStopped(ctx, loop, current, pr, resolved);
    // Escalated (a protected area): only a person merges it.
    if (resolved) note(ctx, current, "Merge conflicts resolved; waiting for a person to merge it");
    return loop;
  }
  // Rebasing work a person will merge spends an agent turn: not while paused or draining (it
  // isn't work in flight), and only on a free agent slot, which `advanceConflicting` claims (a
  // rebuild only queues the work, so it needs none).
  if (rebaseAsks(current) < MAX_REBASE_ASKS && holdsAgentTurns(loop)) {
    const branch = baseBranchOf(project);
    const why = loop.drain ? "the factory finishes its work in flight" : "the loop is paused";
    note(ctx, current, `Merge conflicts with ${branch}: waiting while ${why}`);
    return loop;
  }
  return advanceConflicting(ctx, project, loop, current, pr);
}

/**
 * A failed item's PR without conflicts. When its head moved past the last verdict, with CI
 * green, it goes back to a fresh review by itself, once per head (`rereview.ts`); not while the
 * loop is paused or draining, since a review spends an agent turn. Otherwise its note says what
 * it needs.
 */
function settleStopped(
  ctx: FactoryContext,
  loop: FactoryLoop,
  item: FactoryItem,
  pr: FactoryPr,
  resolved: boolean,
): FactoryLoop {
  const due = autoReReview(item, pr, loop.tuning.requireCi);
  if (due === "now" && pr.headSha && !holdsAgentTurns(loop)) {
    const n = autoReReviews(item) + 1;
    resumeReview(ctx, item, pr.ref, {
      note: `Back in review by itself: #${pr.ref.number} has commits its last review didn't cover (${n} of ${MAX_AUTO_REREVIEWS})`,
      autoHead: pr.headSha,
    });
    ctx.log?.(`factory: ${item.id}: #${pr.ref.number} re-reviewed after it stopped (new head)`);
    return loop;
  }
  const waiting = due === "now" ? "resume" : due === "after_ci" ? "ci" : null;
  const label = stoppedNote(item, pr.ref, waiting);
  const prefix = resolved ? "Merge conflicts resolved" : null;
  const text = [prefix, label].filter(Boolean).join(". ");
  if (text) note(ctx, item, text);
  return loop;
}

/**
 * A rebuild that ended before its replacement PR was opened: the PR it was replacing is still
 * the item's. The loop does nothing more to it (the rebuild was the last resort, so the item is
 * stuck with the user), but a person merging or closing it finishes the item.
 */
async function advanceOriginal(
  ctx: FactoryContext,
  project: Project,
  item: FactoryItem,
  original: NonNullable<FactoryItem["pr"]>,
): Promise<void> {
  const decided = (ref: GitHubPrRef | null): ref is GitHubPrRef =>
    ref?.state === "merged" || ref?.state === "closed";
  // The synced PR says so without an API call; GitHub itself is read every few minutes.
  let ref = ctx.github.prRef(project.id, original.number);
  if (!decided(ref)) {
    if (!due(ctx, item)) return;
    try {
      ref = (await ctx.github.prDetails(project.id, original.number)).ref;
    } catch (error) {
      note(ctx, item, `Could not read #${original.number}: ${errorMessage(error)}`);
      return;
    }
    const at = ctx.now().toISOString();
    ctx.store.updateItem(item.id, (i) => ({ ...i, nudges: { ...i.nudges, [CHECKED]: at } }));
  }
  if (decided(ref)) prDecidedOutside(ctx, item, ref);
}

/**
 * Whether to read the PR from GitHub now: every few minutes, and as soon as the agent asked to
 * rebase has taken its turn.
 */
function due(ctx: FactoryContext, item: FactoryItem): boolean {
  const asked = lastRebaseAsk(item);
  if (asked) {
    const agent = prAgent(ctx, item);
    if (agent && isBusy(agent)) return false;
    if (!agent || Date.parse(agent.updatedAt) > Date.parse(asked)) return true;
  }
  const checked = item.nudges[CHECKED];
  return !checked || ctx.now().getTime() - Date.parse(checked) >= OWNED_RECHECK_MS;
}

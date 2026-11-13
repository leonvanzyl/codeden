import type { FactoryItem, FactoryLoop, Project } from "@codeden/contracts";
import { errorMessage } from "../errors";
import type { FactoryContext } from "./context";
import type { FactoryPr } from "./github-port";
import { prDecidedOutside } from "./merge";
import { freeSlots } from "./policy";
import {
  advanceConflicting,
  baseBranchOf,
  lastRebaseAsk,
  MAX_REBASE_ASKS,
  prAgent,
  rebaseAsks,
  trackHead,
} from "./rebase";
import { adoptAgentPr } from "./rebuild";
import { recoverable } from "./recover";
import { isBusy } from "./sessions";

/**
 * Ownership (§10.1): the loop owns every PR the factory opened until it merges or closes,
 * whatever the item's stage. Verification looks after its own PRs; this step looks after the
 * PRs of items that ended `failed` or `escalated`, which wait for a person. A person merging or
 * closing one finishes its item; one that becomes conflicting is rebased (not a revise round),
 * or rebuilt after three requests, so nobody ever opens a factory PR that rotted into conflicts.
 * The factory never merges these: a person does.
 */

/** How often an owned PR outside verification is read from GitHub (its mergeability). */
export const OWNED_RECHECK_MS = 5 * 60_000;

const CHECKED = "owned_checked";

function note(ctx: FactoryContext, item: FactoryItem, text: string): void {
  ctx.store.updateItem(item.id, (i) => ({ ...i, note: text }));
}

export async function advanceOwned(
  ctx: FactoryContext,
  project: Project,
  loop: FactoryLoop,
  item: FactoryItem,
): Promise<FactoryLoop> {
  if (!item.pr) return loop;
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
    if (rebaseAsks(item) > 0 && pr.mergeable === "mergeable") {
      note(ctx, current, "Merge conflicts resolved; waiting for a person to merge it");
    }
    return loop;
  }
  const branch = baseBranchOf(project);
  // Rebasing work a person will merge spends an agent turn: not while paused, and only on a
  // free agent slot (a rebuild only queues the work, so it needs none).
  if (rebaseAsks(current) < MAX_REBASE_ASKS) {
    if (loop.state === "paused") {
      note(ctx, current, `Merge conflicts with ${branch}: waiting while the loop is paused`);
      return loop;
    }
    const agent = prAgent(ctx, current);
    const waitingOnTurn = agent && isBusy(agent);
    if (
      !waitingOnTurn &&
      freeSlots(ctx.sessions.activeCount(project.id), project.factoryLimits) === 0
    ) {
      note(ctx, current, `Merge conflicts with ${branch}: waiting for a free agent to rebase it`);
      return loop;
    }
  }
  return advanceConflicting(ctx, project, loop, current, pr);
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

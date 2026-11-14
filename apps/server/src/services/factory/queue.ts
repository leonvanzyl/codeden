import {
  checksPassed,
  type FactoryItem,
  type FactoryLoop,
  isFactoryMode,
  type Project,
} from "@codeden/contracts";
import { errorMessage } from "../errors";
import { CONFLICTS_DETAIL } from "./checks";
import type { FactoryContext } from "./context";
import type { FactoryPr } from "./github-port";
import { autoMerge, prDecidedOutside } from "./merge";
import { markStuck } from "./outcomes";
import { mayMerge } from "./policy";
import { baseBranchOf, REFUSED, rebaseAsks, trackedHead, UPDATE } from "./rebase";
import { mayAutoMerge } from "./trust";

/**
 * The merge queue (§10.1, Merge). With auto-merge on, work whose checks all passed doesn't merge
 * at once: it joins the queue, and the factory merges one PR at a time, oldest approved first
 * (reverts ahead of everything). Only the head of the queue acts, so CI never runs on every
 * queued PR at once. A head that is behind the default branch is brought up to date on GitHub
 * (`update-branch`, no agent), CI is awaited on the new head, and then it merges. Main moved,
 * so the next head is checked against the new main in turn. A PR GitHub keeps refusing to
 * merge or update leaves the queue for a person after `MAX_REFUSALS` tries on the same head,
 * so it never holds up the PRs behind it.
 */

/** When the item's checks first all passed (its place in the queue). */
export const MERGE_QUEUED = "merge_queued";

/** Refusals in a row to merge or update one head before the PR leaves the queue. */
export const MAX_REFUSALS = 3;

/** Join the queue once every check passed; the item keeps its place while it waits. */
export function joinQueue(ctx: FactoryContext, item: FactoryItem): FactoryItem {
  if (item.nudges[MERGE_QUEUED]) return item;
  const at = ctx.now().toISOString();
  return ctx.store.updateItem(item.id, (i) => ({
    ...i,
    nudges: { ...i.nudges, [MERGE_QUEUED]: at },
  }));
}

/** Leave the queue (auto-merge turned off: a person merges it). */
export function leaveQueue(ctx: FactoryContext, item: FactoryItem): FactoryItem {
  if (!item.nudges[MERGE_QUEUED]) return item;
  return ctx.store.updateItem(item.id, (i) => {
    const { [MERGE_QUEUED]: _q, ...nudges } = i.nudges;
    return { ...i, nudges };
  });
}

/** Whether the item's PR is being rebased: rebase requests are out, or CI waits on conflicts. */
export function isRebasing(item: FactoryItem): boolean {
  if (rebaseAsks(item) > 0) return true;
  return item.checks.some((c) => c.name === "ci" && c.detail === CONFLICTS_DETAIL);
}

/** Whether the factory asked GitHub to update the PR's current head, and no new head came yet. */
export function isUpdating(item: FactoryItem): boolean {
  const head = trackedHead(item);
  return head !== null && Boolean(item.nudges[`${UPDATE}${head}`]);
}

function compare(a: FactoryItem, b: FactoryItem): number {
  const revert = (i: FactoryItem) => (i.source === "revert" ? 0 : 1);
  return (
    revert(a) - revert(b) ||
    (a.nudges[MERGE_QUEUED] ?? "").localeCompare(b.nudges[MERGE_QUEUED] ?? "") ||
    (a.pr?.number ?? 0) - (b.pr?.number ?? 0)
  );
}

/** The queue, in the order the PRs merge: verifying work the factory merges itself. */
export function mergeQueue(ctx: FactoryContext, project: Project): FactoryItem[] {
  if (!isFactoryMode(project.autonomyMode)) return [];
  return ctx.store
    .items(project.id, ["verifying"])
    .filter((i) => i.pr && i.nudges[MERGE_QUEUED] && mayAutoMerge(i, project.factoryLimits))
    .sort(compare);
}

/** The PR that acts next: the first in the queue that isn't being rebased. */
export function queueHead(queue: FactoryItem[]): FactoryItem | undefined {
  return queue.find((i) => !isRebasing(i));
}

function note(ctx: FactoryContext, item: FactoryItem, text: string): void {
  ctx.store.updateItem(item.id, (i) => ({ ...i, note: text }));
}

/**
 * One step of the queue per tick, so at most one merge happens per tick: the head is brought
 * up to date when it is behind, otherwise merged. The other queued PRs say where they stand.
 */
export async function advanceQueue(
  ctx: FactoryContext,
  project: Project,
  loop: FactoryLoop,
): Promise<FactoryLoop> {
  const queue = mergeQueue(ctx, project);
  const head = queueHead(queue);
  queue.forEach((item, n) => {
    if (item === head || isRebasing(item) || !checksPassed(item)) return;
    note(ctx, item, `Every check passed; queued to merge (number ${n + 1} in line)`);
  });
  if (!head?.pr) return loop;
  if (!checksPassed(head)) {
    if (isUpdating(head))
      note(ctx, head, `Next to merge: updating it with ${baseBranchOf(project)}`);
    return loop;
  }
  if (loop.state === "paused" && head.source !== "revert") {
    note(ctx, head, "Checks passed; waiting while the loop is paused");
    return loop;
  }
  if (!mayMerge(loop.mergesToday, project.factoryLimits)) {
    note(ctx, head, "Checks passed; the daily merge limit is reached");
    return loop;
  }
  let pr: FactoryPr;
  try {
    pr = await ctx.github.prDetails(project.id, head.pr.number);
  } catch (error) {
    note(ctx, head, `Could not read the PR: ${errorMessage(error)}`);
    return loop;
  }
  if (pr.ref.state === "merged" || pr.ref.state === "closed") {
    prDecidedOutside(ctx, head, pr.ref);
    return loop;
  }
  // A new head since the checks ran (or conflicts): the verify step looks at it first.
  const sha = pr.headSha;
  if (!sha || sha !== trackedHead(head) || pr.mergeable !== "mergeable") return loop;
  return mergeOrUpdate(ctx, project, loop, head, pr, sha);
}

async function mergeOrUpdate(
  ctx: FactoryContext,
  project: Project,
  loop: FactoryLoop,
  head: FactoryItem,
  pr: FactoryPr,
  sha: string,
): Promise<FactoryLoop> {
  let behind: number;
  try {
    behind = await ctx.github.behindBy(project.id, pr.ref.number, sha);
  } catch (error) {
    note(ctx, head, `Could not compare it with ${baseBranchOf(project)}: ${errorMessage(error)}`);
    return loop;
  }
  if (behind === 0) {
    const merged = await autoMerge(ctx, project, loop, head, pr, head.checks);
    if (!("refused" in merged)) return merged;
    return refused(ctx, loop, head, sha, "Merge failed", merged.refused);
  }
  const key = `${UPDATE}${sha}`;
  const asked = head.nudges[key];
  // GitHub makes the new head in the background; ask again if none came within the CI grace.
  if (asked && ctx.now().getTime() - Date.parse(asked) < ctx.ciGraceMs) return loop;
  try {
    await ctx.github.updateBranch(project.id, pr.ref.number, sha);
  } catch (error) {
    const doing = `Could not update it with ${baseBranchOf(project)}`;
    return refused(ctx, loop, head, sha, doing, errorMessage(error));
  }
  const at = ctx.now().toISOString();
  ctx.store.updateItem(head.id, (i) => ({
    ...i,
    note: `Next to merge: updating it with ${baseBranchOf(project)} (${behind} commit${behind === 1 ? "" : "s"} behind), then CI runs on the new head`,
    nudges: { ...i.nudges, [key]: at },
  }));
  return loop;
}

/** How many times in a row GitHub refused to merge or update this head of the item's PR. */
function refusals(item: FactoryItem, sha: string): number {
  let n = 0;
  while (item.nudges[`${REFUSED}${sha}_${n + 1}`]) n++;
  return n;
}

/**
 * GitHub refused to merge the head, or to update it with the default branch: counted against
 * that head (a new head starts afresh, `trackHead`). The `MAX_REFUSALS`th refusal takes the PR
 * out of the queue: the item is stuck with what GitHub said (an inbox item, or a recorded
 * decision in a dark factory, and a notice to the PM), and the next PR in line goes ahead.
 */
function refused(
  ctx: FactoryContext,
  loop: FactoryLoop,
  head: FactoryItem,
  sha: string,
  doing: string,
  error: string,
): FactoryLoop {
  const n = refusals(head, sha) + 1;
  const at = ctx.now().toISOString();
  const why = error.replace(/[.\s]+$/, "");
  const current = ctx.store.updateItem(head.id, (i) => ({
    ...i,
    note: `${doing}: ${why} (try ${n} of ${MAX_REFUSALS})`,
    nudges: { ...i.nudges, [`${REFUSED}${sha}_${n}`]: at },
  }));
  if (n < MAX_REFUSALS) return loop;
  ctx.log?.(`factory: ${head.id}: GitHub refused #${head.pr?.number} ${n} times; out of the queue`);
  return markStuck(
    ctx,
    loop,
    leaveQueue(ctx, current),
    `${doing} ${n} times in a row; GitHub said: ${why}`,
    `Look at pull request #${head.pr?.number ?? "?"} on GitHub (branch protection, required checks or reviews, merge settings), then merge it yourself or retry the item. The pull requests queued behind it merge meanwhile.`,
  );
}

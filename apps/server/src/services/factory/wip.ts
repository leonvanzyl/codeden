import type { FactoryItem, FactoryLoop, FactoryWip, Project } from "@codeden/contracts";
import type { FactoryContext } from "./context";
import { repairsMain } from "./overlap";
import { ownedPr } from "./pr-status";
import { recoverable } from "./recover";

/**
 * The work-in-progress limit (§10.1, `maxOpenPrs`): the more factory PRs are open at once, the
 * more each merge leaves the others conflicting (more rebases, more re-reviews, more load on the
 * machine). At or above the limit the factory finishes open work before it starts more: no new
 * build starts from the queue, the scout files nothing, and free agents go to reviews, fixes and
 * rebases. PRs of failed or escalated work wait for a person and don't count, so a PR nobody
 * looks at can't stop the factory; work that failed for a reason outside its code goes back by
 * itself, so its PR does count, and so does a queued rebuild's PR until its replacement opens.
 */

/** The limit in force: `maxOpenPrs`, or the agent limit when that is unset. */
export function wipLimit(project: Project, loop: FactoryLoop): number {
  return loop.tuning.maxOpenPrs ?? project.factoryLimits.maxConcurrentSessions;
}

/** Items whose open PR counts against the limit: work the loop is still taking to a merge. */
export function openPrItems(ctx: FactoryContext, projectId: string): FactoryItem[] {
  const active = ctx.store.items(projectId, ["backlog", "building", "verifying"]);
  // A failure outside its code goes back to verification by itself (`recover.ts`).
  const recovering = ctx.store.items(projectId, ["failed"]).filter(recoverable);
  return [...active, ...recovering].filter((i) => ownedPr(ctx, i) !== null);
}

export function wipOf(ctx: FactoryContext, project: Project, loop: FactoryLoop): FactoryWip {
  const openPrs = openPrItems(ctx, project.id).length;
  const limit = wipLimit(project, loop);
  return { openPrs, limit, holding: openPrs >= limit };
}

/** "Finishing open work (2 of 2 PRs open)". */
export function wipText(wip: FactoryWip): string {
  return `Finishing open work (${wip.openPrs} of ${wip.limit} PRs open)`;
}

/**
 * Whether a queued item may start while the limit holds: repairs of the default branch (every
 * open PR waits on them) and work that already owns an open PR (a rebuild replaces its PR, it
 * adds none).
 */
export function finishesOpenWork(ctx: FactoryContext, item: FactoryItem): boolean {
  return repairsMain(item) || ownedPr(ctx, item) !== null;
}

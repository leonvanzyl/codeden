import type { FactoryItem, FactoryLoop, FactoryWip, Project } from "@codeden/contracts";
import type { FactoryContext } from "./context";
import { repairsMain } from "./overlap";
import { ownedPr } from "./pr-status";
import { awaitedProvider, type ProviderWait, providerWaitText } from "./provider-wait";
import { recoverable } from "./recover";

/**
 * The work-in-progress limit (§10.1, `maxOpenPrs`): the more factory PRs are open at once, the
 * more each merge leaves the others conflicting (more rebases, more re-reviews, more load on the
 * machine). At or above the limit the factory finishes open work before it starts more: no new
 * build starts from the queue, the scout files nothing, and free agents go to reviews, fixes and
 * rebases. PRs of failed or escalated work wait for a person and don't count, so a PR nobody
 * looks at can't stop the factory; work that failed for a reason outside its code goes back by
 * itself, so its PR does count (unless it waits on a provider that is signed out or at its usage
 * limit, `provider-wait.ts`), and so does a queued rebuild's PR until its replacement opens.
 * Builds from the queue that haven't opened their PR yet take room under the limit too, so a
 * tick never starts more builds than there is room for.
 */

/** The limit in force: `maxOpenPrs`, or the agent limit when that is unset. */
export function wipLimit(project: Project, loop: FactoryLoop): number {
  return loop.tuning.maxOpenPrs ?? project.factoryLimits.maxConcurrentSessions;
}

/**
 * Failed work that goes back by itself and owns an open PR: what still counts, and what waits on
 * its provider (which doesn't).
 */
function recovering(
  ctx: FactoryContext,
  projectId: string,
): { counted: FactoryItem[]; waits: ProviderWait[] } {
  const available = ctx.sessions.providers();
  const counted: FactoryItem[] = [];
  const waits: ProviderWait[] = [];
  for (const item of ctx.store.items(projectId, ["failed"])) {
    if (!recoverable(item) || ownedPr(ctx, item) === null) continue;
    const provider = awaitedProvider(ctx, item, available);
    if (provider === undefined) counted.push(item);
    else waits.push({ item, provider });
  }
  return { counted, waits };
}

/**
 * The limit and the open PRs that count against it: work the loop is still taking to a merge,
 * including failures outside their code that go back to verification by themselves.
 */
export function wipOf(ctx: FactoryContext, project: Project, loop: FactoryLoop): FactoryWip {
  const active = ctx.store
    .items(project.id, ["backlog", "building", "verifying"])
    .filter((i) => ownedPr(ctx, i) !== null);
  const { counted, waits } = recovering(ctx, project.id);
  const openPrs = active.length + counted.length;
  const limit = wipLimit(project, loop);
  return {
    openPrs,
    limit,
    holding: openPrs >= limit,
    waitingOnProvider: waits.length,
    note: providerWaitText(ctx, waits),
  };
}

/** "Finishing open work (2 of 2 PRs open)", with builds that will open one: ", 1 more being built". */
export function wipText(wip: FactoryWip, building = 0): string {
  const more = building > 0 ? `, ${building} more being built` : "";
  return `Finishing open work (${wip.openPrs} of ${wip.limit} PRs open${more})`;
}

/**
 * Whether a queued item may start while the limit holds: repairs of the default branch (every
 * open PR waits on them) and work that already owns an open PR (a rebuild replaces its PR, it
 * adds none).
 */
export function finishesOpenWork(ctx: FactoryContext, item: FactoryItem): boolean {
  return repairsMain(item) || ownedPr(ctx, item) !== null;
}

/** Builds from the queue that haven't opened their PR yet: each will, so each takes room. */
export function unopenedBuilds(ctx: FactoryContext, projectId: string): number {
  return ctx.store.items(projectId, ["building"]).filter((i) => !finishesOpenWork(ctx, i)).length;
}

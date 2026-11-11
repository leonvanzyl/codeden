import type { FactoryItem, FactoryLoop, Project } from "@codeden/contracts";
import type { FactoryContext } from "./context";
import type { FactoryPr } from "./github-port";
import { failItem } from "./outcomes";
import { rebasePrompt } from "./prompts";

/**
 * Merge conflicts and the CI clock (§10.1, Review and Merge). When another merge leaves a
 * factory PR conflicting with the default branch, GitHub runs no CI on it and it can't merge.
 * Finishing it is the factory's own work: the builder is asked to rebase (no revise round is
 * spent), and CI is then awaited on the new head, timed from when that head first appeared.
 */

/** Requests to rebase per conflict before the item fails. */
export const MAX_REBASE_ASKS = 3;

const REBASE = "rebase_";
const HEAD = "head_";
const BUSY = new Set(["created", "queued", "starting", "running", "waiting"]);

/** The reason items failed with when their PR got no CI, before conflicts were rebased. */
const LEGACY_NO_CI = "No CI reported on the head commit";

/** The branch factory PRs target. */
export function baseBranchOf(project: Project): string {
  return project.kind === "github"
    ? project.github.defaultBranch
    : (project.defaultBranch ?? "main");
}

/** How many times the builder was asked to rebase during the current conflict. */
export function rebaseAsks(item: FactoryItem): number {
  let n = 0;
  while (item.nudges[`${REBASE}${n + 1}`]) n++;
  return n;
}

/**
 * The item's nudges for this verification pass: when the head was first seen (`head_<sha>`,
 * the start of its CI clock; older heads are dropped), and the rebase requests, which end once
 * GitHub reports the PR mergeable (not while it is still working that out), so the next
 * conflict starts afresh.
 */
export function trackHead(
  nudges: FactoryItem["nudges"],
  pr: Pick<FactoryPr, "headSha" | "mergeable">,
  now: string,
): { nudges: FactoryItem["nudges"]; since: string } {
  const key = `${HEAD}${pr.headSha ?? "unknown"}`;
  const since = nudges[key] ?? now;
  const resolved = pr.mergeable === "mergeable";
  // Keeps the order of what stays, so an unchanged item isn't written again.
  const next: FactoryItem["nudges"] = {};
  for (const [k, v] of Object.entries(nudges)) {
    if (k !== key && (k.startsWith(HEAD) || (resolved && k.startsWith(REBASE)))) continue;
    next[k] = v;
  }
  next[key] = since;
  return { nudges: next, since };
}

/**
 * The PR has merge conflicts and nothing else failed: ask the builder to rebase, wait for its
 * turn, and ask again when the conflicts are still there. After `MAX_REBASE_ASKS` the item
 * fails, saying so.
 */
export async function advanceConflicting(
  ctx: FactoryContext,
  project: Project,
  loop: FactoryLoop,
  item: FactoryItem,
): Promise<FactoryLoop> {
  const branch = baseBranchOf(project);
  const builder = item.builderSessionId ? ctx.repo.find(item.builderSessionId)?.session : undefined;
  if (!builder) {
    return failItem(
      ctx,
      loop,
      item,
      `The pull request has merge conflicts with ${branch} and no builder session to resolve them: rebase it by hand`,
    );
  }
  const asked = rebaseAsks(item);
  const last = asked > 0 ? item.nudges[`${REBASE}${asked}`] : undefined;
  if (last) {
    // Wait until the builder has taken a turn since the last request.
    if (BUSY.has(builder.status) || Date.parse(builder.updatedAt) <= Date.parse(last)) return loop;
    if (asked >= MAX_REBASE_ASKS) {
      return failItem(
        ctx,
        loop,
        item,
        `The pull request still has merge conflicts with ${branch} after ${asked} requests to rebase: resolve them by hand`,
      );
    }
  }
  const at = ctx.now().toISOString();
  ctx.store.updateItem(item.id, (i) => ({
    ...i,
    note: `Merge conflicts with ${branch}: the author is rebasing (not a revise round)`,
    nudges: { ...i.nudges, [`${REBASE}${asked + 1}`]: at },
  }));
  await ctx.sessions.message(builder.id, rebasePrompt(item, branch, asked + 1));
  return loop;
}

/**
 * Items that failed because no CI reported, which is what a PR with merge conflicts gets, go
 * back to verification while their PR is still open: the verify step asks the builder to
 * rebase, or waits for CI on the head and fails with a clear reason if it never starts.
 */
export function recoverNoCiFailures(ctx: FactoryContext, projectId: string): void {
  for (const item of ctx.store.items(projectId, ["failed"])) {
    if (!item.pr || !item.reason?.includes(LEGACY_NO_CI)) continue;
    const state = ctx.github.prRef(projectId, item.pr.number)?.state ?? item.pr.state;
    if (state !== "open" && state !== "draft") continue;
    const at = ctx.now().toISOString();
    ctx.store.updateItem(item.id, (i) => ({
      ...i,
      stage: "verifying",
      reason: null,
      note: "Back in verification: it failed for missing CI, which a PR with merge conflicts never gets",
      finishedAt: null,
      sessionsArchivedAt: null,
      nudges: { ...i.nudges, verifying: at },
    }));
    ctx.log?.(`factory: ${item.id}: back in verification after failing for missing CI`);
  }
}

import type { FactoryItem, FactoryLoop, Project, Session } from "@codeden/contracts";
import { errorMessage } from "../errors";
import type { FactoryContext } from "./context";
import type { FactoryPr } from "./github-port";
import { failItem } from "./outcomes";
import { REBASE_WHY, rebasePrompt } from "./prompts";
import { isBusy } from "./sessions";

/**
 * Merge conflicts and the CI clock (§10.1, Review and Merge). When another merge leaves a
 * factory PR conflicting with the default branch, GitHub runs no CI on it and it can't merge.
 * Finishing it is the factory's own work: the builder is asked to rebase (no revise round is
 * spent), and CI is then awaited on the new head, timed from when that head first appeared.
 * Messaging the builder also brings it and its worktree back when cleanup archived it.
 */

/** Requests to rebase per conflict before the item fails. */
export const MAX_REBASE_ASKS = 3;

const REBASE = "rebase_";
/** Per head commit: when it was first seen (its CI clock) and when its worktree was restored. */
const HEAD = "head_";
const RESTORE = "restore_";

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

/** Whether the audit can run in the builder's worktree: it exists and the builder is between turns. */
export function worktreeSettled(builder: Session): boolean {
  return !builder.worktreeRemovedAt && !isBusy(builder);
}

/**
 * The item's nudges for this verification pass: when the head was first seen (`head_<sha>`,
 * the start of its CI clock) and its worktree restore request (`restore_<sha>`), with older
 * heads' dropped; and the rebase requests, which end once GitHub reports the PR mergeable (not
 * while it is still working that out), so the next conflict starts afresh.
 */
export function trackHead(
  nudges: FactoryItem["nudges"],
  pr: Pick<FactoryPr, "headSha" | "mergeable">,
  now: string,
): { nudges: FactoryItem["nudges"]; since: string } {
  const sha = pr.headSha ?? "unknown";
  const key = `${HEAD}${sha}`;
  const since = nudges[key] ?? now;
  const resolved = pr.mergeable === "mergeable";
  const otherHead = (k: string) =>
    (k.startsWith(HEAD) && k !== key) || (k.startsWith(RESTORE) && k !== `${RESTORE}${sha}`);
  // Keeps the order of what stays, so an unchanged item isn't written again.
  const next: FactoryItem["nudges"] = {};
  for (const [k, v] of Object.entries(nudges)) {
    if (otherHead(k) || (resolved && k.startsWith(REBASE))) continue;
    next[k] = v;
  }
  next[key] = since;
  return { nudges: next, since };
}

/**
 * Ask the builder to rebase, counted as the next request of the current conflict (plus any
 * `also` nudges). Recorded once the message is delivered, so a failed send is retried.
 */
async function askToRebase(
  ctx: FactoryContext,
  project: Project,
  item: FactoryItem,
  builder: Session,
  why: string,
  note: string,
  also: string[] = [],
): Promise<void> {
  const ask = rebaseAsks(item) + 1;
  const at = ctx.now().toISOString();
  await ctx.sessions.message(builder.id, rebasePrompt(item, baseBranchOf(project), why, ask));
  const marks = Object.fromEntries([`${REBASE}${ask}`, ...also].map((k) => [k, at]));
  ctx.store.updateItem(item.id, (i) => ({ ...i, note, nudges: { ...i.nudges, ...marks } }));
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
    if (isBusy(builder) || Date.parse(builder.updatedAt) <= Date.parse(last)) return loop;
    if (asked >= MAX_REBASE_ASKS) {
      return failItem(
        ctx,
        loop,
        item,
        `The pull request still has merge conflicts with ${branch} after ${asked} requests to rebase: resolve them by hand`,
      );
    }
  }
  const note = `Merge conflicts with ${branch}: the author is rebasing (not a revise round)`;
  await askToRebase(ctx, project, item, builder, REBASE_WHY.conflicts(branch), note);
  return loop;
}

/**
 * The audit is required but cleanup removed the builder's worktree (its sessions were archived
 * while the item waited): a message brings the builder and its worktree back, asking it to
 * bring the branch up to date. Once per head; when its turn ends and the worktree is still
 * gone, the item fails, saying so. The audit never runs in a missing directory.
 */
export async function restoreForAudit(
  ctx: FactoryContext,
  project: Project,
  loop: FactoryLoop,
  item: FactoryItem,
  builder: Session,
  headSha: string | null,
): Promise<FactoryLoop> {
  const key = `${RESTORE}${headSha ?? "unknown"}`;
  const asked = item.nudges[key];
  if (!asked) {
    const note = "The builder's worktree was cleaned up: bringing it back for the audit";
    await askToRebase(ctx, project, item, builder, REBASE_WHY.worktree, note, [key]);
    return loop;
  }
  if (isBusy(builder) || Date.parse(builder.updatedAt) <= Date.parse(asked)) return loop;
  return failItem(
    ctx,
    loop,
    item,
    "The builder's worktree was cleaned up and could not be brought back for the audit: message the builder session to restore it, then retry",
  );
}

/**
 * Items that failed because no CI reported, which is what a PR with merge conflicts gets, go
 * back to verification while their PR is still open, and their builder is asked to rebase
 * right away. The message brings an archived builder and its worktree back before anything
 * (the audit) runs there; the verify step then waits for the rebase, or for CI on the head,
 * and fails with a clear reason if CI never starts.
 */
export async function recoverNoCiFailures(ctx: FactoryContext, project: Project): Promise<void> {
  for (const item of ctx.store.items(project.id, ["failed"])) {
    if (!item.pr || !item.reason?.includes(LEGACY_NO_CI)) continue;
    const state = ctx.github.prRef(project.id, item.pr.number)?.state ?? item.pr.state;
    if (state !== "open" && state !== "draft") continue;
    const at = ctx.now().toISOString();
    const reopened = ctx.store.updateItem(item.id, (i) => ({
      ...i,
      stage: "verifying",
      reason: null,
      note: "Back in verification: it failed for missing CI, which a PR with merge conflicts never gets",
      finishedAt: null,
      sessionsArchivedAt: null,
      nudges: { ...i.nudges, verifying: at },
    }));
    ctx.log?.(`factory: ${item.id}: back in verification after failing for missing CI`);
    const builder = item.builderSessionId
      ? ctx.repo.find(item.builderSessionId)?.session
      : undefined;
    if (!builder) continue;
    try {
      const note = `Back in verification after failing for missing CI: the author is rebasing onto ${baseBranchOf(project)}`;
      await askToRebase(ctx, project, reopened, builder, REBASE_WHY.recovered, note);
    } catch (error) {
      // The verify step asks again (conflicts) or restores the worktree (audit) on its own.
      ctx.log?.(`factory: ${item.id}: rebase request: ${errorMessage(error)}`);
    }
  }
}

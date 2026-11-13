import type { FactoryItem, FactoryLoop, Project, Session } from "@codeden/contracts";
import type { FactoryContext } from "./context";
import type { FactoryPr } from "./github-port";
import { failItem } from "./outcomes";
import { REBASE_WHY, rebasePrompt } from "./prompts";
import { type IntegratorTask, integratorPrompt } from "./prompts-integration";
import { rebuild } from "./rebuild";
import { owedRecheck, recheckOf, settleRecheck } from "./recheck";
import { isBusy } from "./sessions";
import { claimSlot } from "./slots";
import { FINISHED_STAGES } from "./store";

/**
 * Merge conflicts and the CI clock (§10.1, Review and Merge). When another merge leaves a
 * factory PR conflicting with the default branch, GitHub runs no CI on it and it can't merge.
 * Finishing it is the factory's own work, whatever the item's stage: the PR's agent is asked
 * to rebase (no revise round is spent), and CI is then awaited on the new head, timed from
 * when that head first appeared. The agent is the builder while its session exists (a message
 * resumes a failed one and brings an archived one and its worktree back): it has the context
 * and owns the PR's branch. Otherwise a fresh integrator session takes over the PR. After
 * `MAX_REBASE_ASKS` requests the work is rebuilt from the default branch instead.
 */

/** Requests to rebase per conflict before the item is rebuilt. */
export const MAX_REBASE_ASKS = 3;

const REBASE = "rebase_";
/** Per head commit: when it was first seen (its CI clock) and when its worktree was restored. */
const HEAD = "head_";
const RESTORE = "restore_";
/** The head a conflict started on (`conflict_from_<sha>`), until the conflict is resolved. */
const CONFLICT_FROM = "conflict_from_";
/** `update_<sha>`: the merge queue asked GitHub to bring that head up to date. */
export const UPDATE = "update_";

/** The branch factory PRs target. */
export function baseBranchOf(project: Project): string {
  return project.kind === "github"
    ? project.github.defaultBranch
    : (project.defaultBranch ?? "main");
}

/** How many times the PR's agent was asked to rebase during the current conflict. */
export function rebaseAsks(item: FactoryItem): number {
  let n = 0;
  while (item.nudges[`${REBASE}${n + 1}`]) n++;
  return n;
}

/** When the last request to rebase was sent; null outside a conflict. */
export function lastRebaseAsk(item: FactoryItem): string | null {
  const n = rebaseAsks(item);
  return n > 0 ? (item.nudges[`${REBASE}${n}`] ?? null) : null;
}

/** Whether the audit can run in the builder's worktree: it exists and the builder is between turns. */
export function worktreeSettled(builder: Session): boolean {
  return !builder.worktreeRemovedAt && !isBusy(builder);
}

/** The head commit the factory last saw on the item's PR (`head_<sha>`), if any. */
export function trackedHead(item: FactoryItem): string | null {
  const key = Object.keys(item.nudges).find((k) => k.startsWith(HEAD));
  return key ? key.slice(HEAD.length) : null;
}

/**
 * The item's nudges for this verification pass: when the head was first seen (`head_<sha>`,
 * the start of its CI clock), its worktree restore request (`restore_<sha>`) and the merge
 * queue's update request (`update_<sha>`), with older heads' dropped; and the rebase requests,
 * which end once GitHub reports the PR mergeable (not while it is still working that out), so
 * the next conflict starts afresh.
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
    (k.startsWith(HEAD) && k !== key) ||
    (k.startsWith(RESTORE) && k !== `${RESTORE}${sha}`) ||
    (k.startsWith(UPDATE) && k !== `${UPDATE}${sha}`);
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
 * The re-check owed on the PR's current head (`recheck.ts`). An approved re-check is settled
 * against it first. Then, once a conflict an agent was asked about is resolved (the PR is
 * mergeable on a new head), the reviewer re-checks the resolution when the item was reviewed
 * already (`reviewed`): the conflict's starting head becomes the one it is compared with,
 * unless a re-check is owed already, which keeps comparing with the last approved head. A
 * conflict that went away by itself needs nothing.
 */
export function settleConflict(
  nudges: FactoryItem["nudges"],
  pr: Pick<FactoryPr, "headSha" | "mergeable">,
  reviewed: boolean,
): FactoryItem["nudges"] {
  const settled = settleRecheck(nudges, pr.headSha);
  if (pr.mergeable !== "mergeable") return settled;
  const key = Object.keys(settled).find((k) => k.startsWith(CONFLICT_FROM));
  if (!key) return settled;
  const old = key.slice(CONFLICT_FROM.length);
  const { [key]: at, ...rest } = settled;
  if (!reviewed || !at || old === (pr.headSha ?? "") || recheckOf({ nudges: rest }) !== null) {
    return rest;
  }
  return { ...rest, ...owedRecheck(old, at) };
}

/**
 * A slot for work on the item's PR by `agent` (a rebase, a revise round, the audit's worktree):
 * an agent mid-turn gets the request after that turn and needs none; one between turns is woken
 * with a free slot left after the reviews waiting for one (`slots.ts`).
 */
export function repairSlot(
  ctx: FactoryContext,
  project: Project,
  item: FactoryItem,
  agent: Session,
): boolean {
  if (isBusy(agent)) return true;
  return claimSlot(ctx, project, "repair", `repair:${item.id}`, { wake: agent.id });
}

/** The session that answers for the item's PR (its builder or integrator), while it exists. */
export function prAgent(ctx: FactoryContext, item: FactoryItem): Session | undefined {
  return item.builderSessionId ? ctx.repo.find(item.builderSessionId)?.session : undefined;
}

/**
 * Ask the PR's agent to rebase, counted as the next request of the current conflict (plus any
 * `also` nudges). Recorded once the message is delivered, so a failed send is retried. The
 * message brings an archived agent back; for finished work cleanup archives it again after.
 */
async function askToRebase(
  ctx: FactoryContext,
  project: Project,
  item: FactoryItem,
  agent: Session,
  why: string,
  note: string,
  also: string[] = [],
): Promise<void> {
  const ask = rebaseAsks(item) + 1;
  const at = ctx.now().toISOString();
  await ctx.sessions.message(agent.id, rebasePrompt(item, baseBranchOf(project), why, ask));
  const marks = Object.fromEntries([`${REBASE}${ask}`, ...also].map((k) => [k, at]));
  ctx.store.updateItem(item.id, (i) => ({
    ...i,
    note,
    nudges: { ...i.nudges, ...marks },
    sessionsArchivedAt:
      agent.archivedAt && FINISHED_STAGES.includes(i.stage) ? null : i.sessionsArchivedAt,
  }));
}

/**
 * A fresh integrator takes over the PR when the session that wrote it is gone: a worktree on
 * the PR's head branch, a brief with the issue, the PR description and the review history.
 * It becomes the item's PR agent, so the PR's later follow-ups (conflicts, CI, the audit, the
 * review's worktree) go to it. Waits for a free agent slot; true once it started. `marks` are
 * nudges recorded when it starts.
 */
export async function startIntegrator(
  ctx: FactoryContext,
  project: Project,
  item: FactoryItem,
  pr: FactoryPr,
  task: IntegratorTask,
  marks: string[],
): Promise<boolean> {
  const base = baseBranchOf(project);
  const what =
    task === "conflicts"
      ? `Merge conflicts with ${base}`
      : "CI never started on its head and its author's session is gone";
  if (!claimSlot(ctx, project, "repair", `repair:${item.id}`)) {
    ctx.store.updateItem(item.id, (i) => ({
      ...i,
      note: `${what}: waiting for a free agent to take the pull request over`,
    }));
    return false;
  }
  const res = await ctx.sessions.startIntegrator(
    item,
    { number: pr.ref.number, headBranch: pr.headBranch },
    integratorPrompt(
      item,
      { number: pr.ref.number, url: pr.ref.url, body: pr.body, headBranch: pr.headBranch },
      base,
      task,
    ),
  );
  if (res.status !== "started") {
    ctx.store.updateItem(item.id, (i) => ({
      ...i,
      note: `${what}: the integrator could not start (${res.status})`,
    }));
    return false;
  }
  const session = ctx.repo.find(res.sessionId)?.session;
  const at = ctx.now().toISOString();
  ctx.store.updateItem(item.id, (i) => ({
    ...i,
    builderSessionId: res.sessionId,
    builderProvider: session?.provider ?? i.builderProvider,
    note: `${what}: an integrator took the pull request over`,
    nudges: { ...i.nudges, ...Object.fromEntries(marks.map((k) => [k, at])) },
    // Finished work's integrator is archived again once its turn is over.
    sessionsArchivedAt: FINISHED_STAGES.includes(i.stage) ? null : i.sessionsArchivedAt,
  }));
  return true;
}

/**
 * The PR has merge conflicts and nothing else failed: ask its agent to rebase (or start an
 * integrator), wait for that turn, and ask again while the conflicts remain. After
 * `MAX_REBASE_ASKS` requests the item is rebuilt from the default branch instead of failing;
 * an item that already used its rebuild is stuck.
 */
export async function advanceConflicting(
  ctx: FactoryContext,
  project: Project,
  loop: FactoryLoop,
  item: FactoryItem,
  pr: FactoryPr,
): Promise<FactoryLoop> {
  const branch = baseBranchOf(project);
  const agent = prAgent(ctx, item);
  const asked = rebaseAsks(item);
  const last = lastRebaseAsk(item);
  // Wait until the agent has taken a turn since the last request.
  if (last && agent && (isBusy(agent) || Date.parse(agent.updatedAt) <= Date.parse(last))) {
    return loop;
  }
  if (asked >= MAX_REBASE_ASKS) {
    return rebuild(
      ctx,
      project,
      loop,
      item,
      `still had merge conflicts with ${branch} after ${asked} requests to rebase`,
    );
  }
  // The head the conflict started on, for the reviewer's re-check once it is resolved.
  const from = asked === 0 && item.stage === "verifying" && pr.headSha;
  const also = from ? [`${CONFLICT_FROM}${pr.headSha}`] : [];
  if (!agent) {
    await startIntegrator(ctx, project, item, pr, "conflicts", [`${REBASE}${asked + 1}`, ...also]);
    return loop;
  }
  // A request to an agent between turns starts a turn: it waits for a free agent, after the
  // reviews (`slots.ts`). One mid-turn gets it after that turn.
  if (!repairSlot(ctx, project, item, agent)) {
    const waiting = `Merge conflicts with ${branch}: waiting for a free agent to rebase it`;
    ctx.store.updateItem(item.id, (i) => ({ ...i, note: waiting }), { touch: false });
    return loop;
  }
  const note = `Merge conflicts with ${branch}: the author is rebasing (not a revise round)`;
  await askToRebase(ctx, project, item, agent, REBASE_WHY.conflicts(branch), note, also);
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
    if (!repairSlot(ctx, project, item, builder)) {
      const waiting =
        "The builder's worktree was cleaned up: waiting for a free agent to bring it back for the audit";
      ctx.store.updateItem(item.id, (i) => ({ ...i, note: waiting }), { touch: false });
      return loop;
    }
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

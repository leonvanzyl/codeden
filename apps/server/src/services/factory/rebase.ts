import type { FactoryItem, FactoryLoop, Project, Session } from "@codeden/contracts";
import { baseBranchOf, type FactoryContext } from "./context";
import type { FactoryPr } from "./github-port";
import { startIntegrator } from "./integrator";
import { awaitingStart, awaitingStartNote } from "./late-start";
import { failItem } from "./outcomes";
import { prGone } from "./pr-gone";
import { REBASE_WHY, rebasePrompt } from "./prompts";
import { providerFailure, providerWide } from "./provider-failure";
import { rebuild } from "./rebuild";
import { owedRecheck, recheckOf, settleRecheck } from "./recheck";
import { revertBlocked } from "./revert-blocked";
import { isBusy, neverRanTurn } from "./sessions";
import { claimSlot } from "./slots";
import { FINISHED_STAGES } from "./store";

/**
 * Merge conflicts and the CI clock (§10.1, Review and Merge). When another merge leaves a
 * factory PR conflicting with the default branch, GitHub runs no CI on it and it can't merge.
 * Finishing it is the factory's own work, whatever the item's stage: the PR's agent is asked
 * to rebase (no revise round is spent), and CI is then awaited on the new head, timed from
 * when that head first appeared. The agent is the builder while its session exists (a message
 * resumes a failed one and brings an archived one and its worktree back): it has the context
 * and owns the PR's branch. Otherwise, or when the agent's start never reached its provider, a
 * fresh integrator session takes over the PR (`integrator.ts`). After `MAX_REBASE_ASKS`
 * requests the work is rebuilt from the default branch instead (a revert, which has nothing to
 * rebuild, goes to the user: `revert-blocked.ts`).
 */

/** Requests to rebase per conflict before the item is rebuilt. */
export const MAX_REBASE_ASKS = 3;

const REBASE = "rebase_";
/** `rebase_start_<n>`: the n-th request to rebase was an integrator's brief (it started with it). */
const REBASE_START = "rebase_start_";
/** Per head commit: when it was first seen (its CI clock) and when its worktree was restored. */
const HEAD = "head_";
const RESTORE = "restore_";
/** The head a conflict started on (`conflict_from_<sha>`), until the conflict is resolved. */
const CONFLICT_FROM = "conflict_from_";
/**
 * `update_<sha>`: the factory asked GitHub to bring that head up to date (the merge queue, or a
 * PR that waited for the default branch: `inherited-ci.ts`).
 */
export const UPDATE = "update_";
/**
 * `main_red_<sha>`: that head's red CI fails only what fails on the default branch
 * (`inherited-ci.ts`).
 */
export const MAIN_RED = "main_red_";
/** `refused_<sha>_<n>`: the n-th time GitHub refused to merge or update that head (`queue.ts`). */
export const REFUSED = "refused_";
/** `strict_<sha>`: GitHub refused to merge that head on its own CI; it takes the strict path. */
export const STRICT = "strict_";
/** When the merge queue last brought the PR up to date (any head): it merges as `retested`. */
export const QUEUE_UPDATED = "queue_updated";

export { baseBranchOf };

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
export function trackedHead(item: Pick<FactoryItem, "nudges">): string | null {
  const key = Object.keys(item.nudges).find((k) => k.startsWith(HEAD));
  return key ? key.slice(HEAD.length) : null;
}

/** When the factory first saw `sha` as the PR's head (`head_<sha>`); null when it didn't. */
export function headSeenAt(item: Pick<FactoryItem, "nudges">, sha: string): string | null {
  return item.nudges[`${HEAD}${sha}`] ?? null;
}

/**
 * The item's nudges for this verification pass: when the head was first seen (`head_<sha>`,
 * the start of its CI clock), its worktree restore request (`restore_<sha>`), the factory's
 * update request (`update_<sha>`), red CI that is the default branch's (`main_red_<sha>`), a
 * refused fast merge (`strict_<sha>`) and GitHub's
 * refusals to merge or update it (`refused_<sha>_<n>`), with older heads' dropped; and the rebase requests,
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
    (k.startsWith(UPDATE) && k !== `${UPDATE}${sha}`) ||
    (k.startsWith(MAIN_RED) && k !== `${MAIN_RED}${sha}`) ||
    (k.startsWith(STRICT) && k !== `${STRICT}${sha}`) ||
    (k.startsWith(REFUSED) && !k.startsWith(`${REFUSED}${sha}_`));
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

/** The PR's agent as a request can use it (`usablePrAgent`), or until when its start is awaited. */
export type UsablePrAgent = { agent: Session | undefined; refused: boolean } | { awaiting: string };

/**
 * The PR's agent, when a rebase or CI request can go to it (§10.1, PR agent). One whose start
 * never reached its provider (it failed without running a turn) never got its brief: a request
 * would be its first and only instruction, on the provider that refused it. It is let go
 * (`letGoPrAgent`) and the caller starts a fresh integrator with its brief in the same tick.
 * `refused`: its provider refused to open it (signed out, a CLI too old), which backs that
 * provider off once (`backOffRefused`). One whose start the runner left unanswered is waited
 * for while the factory still expects it to start (`awaiting`, `late-start.ts`).
 */
export function usablePrAgent(ctx: FactoryContext, item: FactoryItem): UsablePrAgent {
  const agent = prAgent(ctx, item);
  if (agent?.status !== "failed" || !neverRanTurn(ctx.repo, agent)) {
    return { agent, refused: false };
  }
  const until = awaitingStart(ctx, agent);
  if (until) return { awaiting: until };
  const refused = backOffRefused(ctx, agent);
  ctx.store.updateItem(item.id, (i) =>
    i.builderSessionId === agent.id ? { ...i, ...letGoPrAgent(i, agent.id, refused) } : i,
  );
  ctx.log?.(`factory: ${item.id}: its PR agent ${agent.id} never started; let go`);
  return { agent: undefined, refused };
}

/**
 * Whether its provider refused to open `s` (signed out, a CLI too old). New work then keeps off
 * that provider, as after a builder's refused start (`progress.ts`), unless the factory learned
 * something about the provider since `s` failed: it backed it off already, or a person asked to
 * check it again or signed in (`FactorySessions.providerFailed`).
 */
export function backOffRefused(ctx: FactoryContext, s: Session): boolean {
  const cause = providerFailure(ctx.repo, ctx.inbox, s);
  if (!cause || !providerWide(cause)) return false;
  ctx.sessions.providerFailed(s.provider, cause, s.updatedAt);
  return true;
}

/**
 * The item once its PR agent `sessionId` is let go: it has none, and the session becomes an
 * earlier one (cleanup archives it; one that opens late is stopped, `late-start.ts`). When its
 * provider refused it (`refused`), the request to rebase it was started with doesn't count
 * toward `MAX_REBASE_ASKS`: refused starts never rebuild the work.
 */
export function letGoPrAgent(
  item: FactoryItem,
  sessionId: string,
  refused: boolean,
): Pick<FactoryItem, "builderSessionId" | "earlierSessionIds" | "nudges"> {
  const n = rebaseAsks(item);
  const start = `${REBASE_START}${n}`;
  const { [`${REBASE}${n}`]: _ask, [start]: _start, ...uncounted } = item.nudges;
  return {
    builderSessionId: null,
    earlierSessionIds: [...new Set([...item.earlierSessionIds, sessionId])],
    nudges: refused && item.nudges[start] ? uncounted : item.nudges,
  };
}

/**
 * Ask the PR's agent to rebase, counted as the next request of the current conflict (plus any
 * `also` nudges). Recorded once the message is delivered, so a failed send is retried. The
 * message brings an archived agent back; for finished work cleanup archives it again after.
 * Nothing is sent for a PR that merged or closed since the step read it (`pr-gone.ts`).
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
  if (prGone(ctx, item)) return;
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
 * The PR has merge conflicts and nothing else failed: ask its agent to rebase (or start an
 * integrator), wait for that turn, and ask again while the conflicts remain. An agent whose
 * start never reached its provider gets no request: a fresh integrator with its brief takes
 * over (`usablePrAgent`). After `MAX_REBASE_ASKS` requests the item is rebuilt from the default
 * branch instead of failing; an item that already used its rebuild is stuck.
 */
export async function advanceConflicting(
  ctx: FactoryContext,
  project: Project,
  loop: FactoryLoop,
  item: FactoryItem,
  pr: FactoryPr,
): Promise<FactoryLoop> {
  const branch = baseBranchOf(project);
  const usable = usablePrAgent(ctx, item);
  if ("awaiting" in usable) {
    const note = awaitingStartNote("integrator", usable.awaiting);
    if (item.note !== note) {
      ctx.store.updateItem(item.id, (i) => ({ ...i, note }), { touch: false });
    }
    return loop;
  }
  const agent = usable.agent;
  // Read again: an agent let go just now took a refused start's request with it.
  item = ctx.store.item(item.id) ?? item;
  const asked = rebaseAsks(item);
  const last = lastRebaseAsk(item);
  // Wait until the agent has taken a turn since the last request.
  if (last && agent && (isBusy(agent) || Date.parse(agent.updatedAt) <= Date.parse(last))) {
    return loop;
  }
  if (asked >= MAX_REBASE_ASKS) {
    // A revert isn't rebuilt: the default branch stays red, and a person hears it once.
    if (item.source === "revert") {
      const why = `it still conflicts with ${branch} after ${asked} requests to resolve them`;
      return revertBlocked(ctx, project, loop, item, why);
    }
    return rebuild(
      ctx,
      project,
      loop,
      item,
      `still had merge conflicts with ${branch} after ${asked} requests to rebase`,
    );
  }
  // The head the conflict started on, for the reviewer's re-check once it is resolved (kept as
  // first recorded when a refused integrator's request didn't count).
  const fromKey = `${CONFLICT_FROM}${pr.headSha}`;
  const from = asked === 0 && item.stage === "verifying" && pr.headSha && !item.nudges[fromKey];
  const also = from ? [fromKey] : [];
  if (!agent) {
    const ask = asked + 1;
    const marks = [`${REBASE}${ask}`, `${REBASE_START}${ask}`, ...also];
    await startIntegrator(ctx, project, loop, item, pr, "conflicts", marks);
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

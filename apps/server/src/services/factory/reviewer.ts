import type { FactoryItem, FactoryLoop, Project, Session } from "@codeden/contracts";
import { type Unavailable, unavailableText } from "./availability";
import type { FactoryContext } from "./context";
import { failReview } from "./failures";
import type { FactoryPr } from "./github-port";
import { stoppedSinceNudge } from "./idle";
import { failItem } from "./outcomes";
import { freeSlots } from "./policy";
import { REVIEWER_NUDGE, reReviewPrompt } from "./prompts";
import { recheckPrompt } from "./prompts-integration";
import {
  MAX_PROVIDER_RESTARTS,
  providerFailure,
  providerRestarts,
  skipProvider,
  skippedProviders,
} from "./provider-failure";
import { baseBranchOf, recheckOf } from "./rebase";
import { pickReviewer, type ReviewerChoice, type ReviewerWait } from "./reviewer-choice";
import { mayAutoMerge } from "./trust";

/**
 * The independent reviewer (§10.1, Review): started on another provider when one is
 * available, asked to look again after a revise round, and asked to re-check only a conflict
 * resolution an agent made after it approved. A reviewer session that can't take messages any
 * more is replaced by a fresh one, which gets the same scoped job (the earlier verdict stays).
 */

const ENDED = new Set(["idle", "interrupted", "completed", "failed", "stopped"]);

/** Times a reviewer session that died is replaced before the item fails (infrastructure). */
const MAX_REVIEWER_RESTARTS = 3;

/** The re-check request was sent to the current reviewer. */
const RECHECK_SENT = "recheck_sent";

/** The nudges without the "re-check sent" mark: a fresh reviewer gets the re-check again. */
function resendRecheck(nudges: FactoryItem["nudges"]): FactoryItem["nudges"] {
  const { [RECHECK_SENT]: _sent, ...rest } = nudges;
  return rest;
}

/**
 * Where a new reviewer works: in the PR agent's worktree while it is there (offline, on the
 * PR branch), otherwise in a fresh worktree on the PR's head, fetched by CodeDen (a revert PR
 * opened through the API, an author whose session is gone, a worktree cleanup removed).
 */
function reviewHead(
  ctx: FactoryContext,
  project: Project,
  item: FactoryItem,
  pr: FactoryPr,
): { headBranch: string; baseBranch: string } | null {
  const builder = item.builderSessionId ? ctx.repo.find(item.builderSessionId)?.session : undefined;
  if (builder?.worktreePath && !builder.worktreeRemovedAt) return null;
  return { headBranch: pr.headBranch, baseBranch: baseBranchOf(project) };
}

/**
 * Where the item's next review runs: the settings' reviewer among the providers available now
 * (and not skipped for this item after a provider failure), or its fallback, or waiting.
 */
function chooseReviewer(
  ctx: FactoryContext,
  loop: FactoryLoop,
  item: FactoryItem,
): ReviewerChoice | ReviewerWait {
  const skipped = skippedProviders(item, ctx.now());
  const builder = item.builderSessionId ? ctx.repo.find(item.builderSessionId)?.session : undefined;
  return pickReviewer({
    author: {
      provider: item.builderProvider ?? builder?.provider ?? null,
      model: builder?.model ?? null,
    },
    tuning: loop.tuning,
    available: ctx.sessions.providers().filter((p) => !skipped.some((s) => s.provider === p)),
    unavailable: [...ctx.sessions.unavailable(), ...skipped],
    name: (id) => ctx.sessions.displayName(id),
  });
}

/** Start a reviewer session for the item (the whole review, or the brief given). */
async function startReviewer(
  ctx: FactoryContext,
  project: Project,
  loop: FactoryLoop,
  item: FactoryItem,
  vision: string,
  pr: FactoryPr,
  text?: string,
): Promise<
  | { sessionId: string; provider: string; note: string | null }
  | { status: string }
  | { waiting: string }
> {
  const choice = chooseReviewer(ctx, loop, item);
  if (choice.wait) return { waiting: choice.note };
  const res = await ctx.sessions.startReviewer(
    item,
    vision,
    choice,
    choice.note,
    reviewHead(ctx, project, item, pr),
    mayAutoMerge(item, project.factoryLimits),
    text,
  );
  if (res.status !== "started") return { status: res.status };
  return { sessionId: res.sessionId, provider: choice.provider, note: choice.note };
}

const noFreeAgent = (ctx: FactoryContext, project: Project) =>
  freeSlots(ctx.sessions.activeCount(project.id), project.factoryLimits) === 0;

/**
 * Start the independent reviewer (another provider when possible), ask it to look again, or
 * ask it to re-check only a conflict resolution an agent made since it approved.
 */
export async function ensureReviewer(
  ctx: FactoryContext,
  project: Project,
  loop: FactoryLoop,
  item: FactoryItem,
  vision: string,
  pr: FactoryPr,
): Promise<FactoryItem> {
  const old = recheckOf(item);
  if (item.review && old) return requestRecheck(ctx, project, loop, item, vision, pr, old);
  if (item.review) return item;
  if (item.reviewerSessionId) {
    if (!item.nudges.rereview_pending) return item;
    await ctx.sessions.message(item.reviewerSessionId, reReviewPrompt(item));
    return ctx.store.updateItem(item.id, (i) => {
      const { rereview_pending: _p, ...rest } = i.nudges;
      return { ...i, nudges: { ...rest, rereview_sent: ctx.now().toISOString() } };
    });
  }
  if (noFreeAgent(ctx, project)) {
    return ctx.store.updateItem(item.id, (i) => ({
      ...i,
      note: "Waiting for a free agent for the review",
    }));
  }
  const res = await startReviewer(ctx, project, loop, item, vision, pr);
  if ("waiting" in res) return ctx.store.updateItem(item.id, (i) => ({ ...i, note: res.waiting }));
  if ("status" in res) {
    return ctx.store.updateItem(item.id, (i) => ({
      ...i,
      note: `Review not started (${res.status})`,
    }));
  }
  return ctx.store.updateItem(item.id, (i) => ({
    ...i,
    reviewerSessionId: res.sessionId,
    reviewerProvider: res.provider,
    reviewerNote: res.note,
    note: null,
  }));
}

/**
 * An agent rebased the PR to resolve conflicts after the reviewer approved: the reviewer
 * re-checks only the resolution (`git range-diff`). When the reviewer session can't take the
 * message any more, a fresh reviewer does that same re-check, told what was approved; the
 * earlier verdict stands if it approves.
 */
async function requestRecheck(
  ctx: FactoryContext,
  project: Project,
  loop: FactoryLoop,
  item: FactoryItem,
  vision: string,
  pr: FactoryPr,
  oldHead: string,
): Promise<FactoryItem> {
  if (item.nudges[RECHECK_SENT]) return item;
  const newHead = pr.headSha ?? "HEAD";
  const base = baseBranchOf(project);
  const reviewer = item.reviewerSessionId
    ? ctx.repo.find(item.reviewerSessionId)?.session
    : undefined;
  const at = ctx.now().toISOString();
  if (reviewer && reviewer.status !== "failed" && !reviewer.archivedAt) {
    await ctx.sessions.message(reviewer.id, recheckPrompt(item, oldHead, newHead, base));
    return ctx.store.updateItem(item.id, (i) => {
      const { reviewer: _nudged, ...nudges } = i.nudges;
      return {
        ...i,
        note: "Rebased after the review: the reviewer re-checks the conflict resolution",
        nudges: { ...nudges, [RECHECK_SENT]: at },
      };
    });
  }
  if (noFreeAgent(ctx, project)) {
    return ctx.store.updateItem(item.id, (i) => ({
      ...i,
      note: "Rebased after the review: waiting for a free agent to re-check the resolution",
    }));
  }
  const text = recheckPrompt(item, oldHead, newHead, base, true);
  const res = await startReviewer(ctx, project, loop, item, vision, pr, text);
  if ("waiting" in res) {
    return ctx.store.updateItem(item.id, (i) => ({
      ...i,
      note: `Rebased after the review: ${res.waiting.replace(/^Waiting/, "waiting")}`,
    }));
  }
  if ("status" in res) {
    return ctx.store.updateItem(item.id, (i) => ({
      ...i,
      note: `Re-check of the conflict resolution not started (${res.status})`,
    }));
  }
  return ctx.store.updateItem(item.id, (i) => {
    const { reviewer: _nudged, ...nudges } = i.nudges;
    return {
      ...i,
      reviewerSessionId: res.sessionId,
      reviewerProvider: res.provider,
      reviewerNote: res.note,
      note: "Rebased after the review: a fresh reviewer re-checks the conflict resolution",
      nudges: { ...nudges, [RECHECK_SENT]: at },
    };
  });
}

/**
 * While checks are pending: nudge a reviewer that ended its turn without a verdict (or without
 * its re-check), and fail the review once it ends again without one and stays idle past the
 * grace period. A reviewer session that died is replaced, up to `MAX_REVIEWER_RESTARTS` times;
 * a pending re-check stays a re-check for the replacement.
 */
export async function reviewerStalled(
  ctx: FactoryContext,
  project: Project,
  loop: FactoryLoop,
  item: FactoryItem,
): Promise<FactoryLoop> {
  const rechecking = Boolean(item.review && recheckOf(item) && item.nudges[RECHECK_SENT]);
  if ((item.review && !rechecking) || !item.reviewerSessionId || item.nudges.rereview_pending)
    return loop;
  const s = ctx.repo.find(item.reviewerSessionId)?.session;
  if (!s || !ENDED.has(s.status)) return loop;
  const cause =
    providerRestarts(item) < MAX_PROVIDER_RESTARTS ? providerFailure(ctx.repo, ctx.inbox, s) : null;
  if (cause) return reviewerProviderFailed(ctx, loop, item, s, cause);
  if (s.status === "failed") return reviewerDied(ctx, loop, item);
  if (s.status === "stopped") {
    if (item.nudges.reviewer_restarted)
      return failReview(ctx, project, loop, item, "The reviewer session stopped");
    ctx.store.updateItem(item.id, (i) => ({
      ...i,
      reviewerSessionId: null,
      nudges: { ...resendRecheck(i.nudges), reviewer_restarted: ctx.now().toISOString() },
    }));
    return loop;
  }
  const nudged = item.nudges.reviewer;
  if (!nudged) {
    const at = ctx.now().toISOString();
    ctx.store.updateItem(item.id, (i) => ({ ...i, nudges: { ...i.nudges, reviewer: at } }));
    await ctx.sessions.message(s.id, REVIEWER_NUDGE);
    return loop;
  }
  if (stoppedSinceNudge(s, nudged, ctx.now(), loop.tuning)) {
    return failReview(ctx, project, loop, item, "The reviewer ended without a verdict");
  }
  return loop;
}

/**
 * The reviewer failed because of its provider (usage limit, sign-in, never started), not the
 * work: a fresh reviewer starts on the fallback, never the same provider, and the failure uses
 * neither a revise round nor the reviewer's restarts. A usage limit or sign-in problem also keeps
 * other factory work off that provider for a while. Its session, which may be waiting to retry
 * after the limit resets, is stopped.
 */
async function reviewerProviderFailed(
  ctx: FactoryContext,
  loop: FactoryLoop,
  item: FactoryItem,
  s: Session,
  cause: Unavailable,
): Promise<FactoryLoop> {
  if (cause.reason !== "failing to start") {
    ctx.sessions.providerFailed(s.provider, cause.reason, cause.until);
  }
  if (s.status === "idle") await ctx.sessions.stop(s.id);
  const name = ctx.sessions.displayName(s.provider);
  ctx.log?.(`factory: ${item.id}: reviewer on ${s.provider} failed (${cause.reason})`);
  ctx.store.updateItem(item.id, (i) => ({
    ...i,
    reviewerSessionId: null,
    note: `The reviewer stopped: ${unavailableText(name, cause)}. A fresh reviewer starts on an available provider.`,
    nudges: skipProvider(resendRecheck(i.nudges), s.provider, cause.until, ctx.now()),
  }));
  return loop;
}

/**
 * The reviewer session died (an error, not a verdict): a fresh reviewer takes over, without a
 * revise round, with the same job (a pending re-check stays a re-check, the earlier verdict
 * stays). After `MAX_REVIEWER_RESTARTS` the item fails as an infrastructure failure.
 */
function reviewerDied(ctx: FactoryContext, loop: FactoryLoop, item: FactoryItem): FactoryLoop {
  let n = 0;
  while (item.nudges[`reviewer_failed_${n + 1}`]) n++;
  if (n >= MAX_REVIEWER_RESTARTS) {
    return failItem(ctx, loop, item, `The reviewer session failed ${n + 1} times`, {
      kind: "infrastructure",
    });
  }
  const at = ctx.now().toISOString();
  ctx.store.updateItem(item.id, (i) => ({
    ...i,
    reviewerSessionId: null,
    nudges: { ...resendRecheck(i.nudges), [`reviewer_failed_${n + 1}`]: at },
  }));
  return loop;
}

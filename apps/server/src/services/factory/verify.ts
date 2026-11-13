import {
  type FactoryItem,
  type FactoryLoop,
  isFactoryMode,
  type Project,
} from "@codeden/contracts";
import { errorMessage } from "../errors";
import { codeFiles, evaluateChecks, hasTestResults, sameChecks } from "./checks";
import { type FactoryContext, visionOf } from "./context";
import { failReview, handleFailure } from "./failures";
import type { FactoryPr, PrEvidence } from "./github-port";
import { stoppedSinceNudge } from "./idle";
import { prDecidedOutside, readyForYou } from "./merge";
import { escalate, failItem, runAudit } from "./outcomes";
import { isUiFile, pickReviewer } from "./policy";
import { REVIEWER_NUDGE, reReviewPrompt } from "./prompts";
import { recheckPrompt } from "./prompts-integration";
import { joinQueue, leaveQueue } from "./queue";
import {
  advanceConflicting,
  baseBranchOf,
  recheckOf,
  restoreForAudit,
  settleConflict,
  trackedHead,
  trackHead,
  UPDATE,
  withoutRecheck,
  worktreeSettled,
} from "./rebase";
import { adoptAgentPr, closeReplaced } from "./rebuild";
import { mayAutoMerge } from "./trust";

const ENDED = new Set(["idle", "interrupted", "completed", "failed", "stopped"]);

/** Times a reviewer session that died is replaced before the item fails (infrastructure). */
const MAX_REVIEWER_RESTARTS = 3;

/** Audit results per item and head commit (re-run after a restart is fine). */
const auditCache = new Map<string, { ok: boolean; detail: string }>();
/** Evidence found per item and head commit (only what was found; misses are looked up again). */
const evidenceCache = new Map<string, PrEvidence>();

/** How often a PR that is ready for a person is read from GitHub again (new commits, CI). */
export const READY_RECHECK_MS = 5 * 60_000;

/**
 * One verification step for an item with a PR (§10.1, Review and Merge): gather the inputs,
 * record the merge checks, start or nudge the independent reviewer, then queue it to merge
 * (auto-merge on, trusted work; `queue.ts` merges) or hand it to the user to merge, start a
 * revise round, fail or escalate.
 */
export async function advanceVerifying(
  ctx: FactoryContext,
  project: Project,
  loop: FactoryLoop,
  item: FactoryItem,
): Promise<FactoryLoop> {
  if (!item.pr) return failItem(ctx, loop, item, "The item has no pull request");
  await closeReplaced(ctx, project, item);
  item = await adoptAgentPr(ctx, project, item);
  if (!item.pr) return loop;
  // Ready and waiting for a person: the synced PR says when they merge or close it; GitHub
  // itself is asked again only every few minutes (new commits, CI, conflicts).
  if (item.nudges.ready && !mayAutoMerge(item, project.factoryLimits)) {
    const ref = ctx.github.prRef(project.id, item.pr.number);
    if (ref && (ref.state === "merged" || ref.state === "closed")) {
      prDecidedOutside(ctx, item, ref);
      return loop;
    }
    const last = Date.parse(item.nudges.ready_checked ?? item.nudges.ready);
    if (ctx.now().getTime() - last < READY_RECHECK_MS) return loop;
    const at = ctx.now().toISOString();
    ctx.store.updateItem(item.id, (i) => ({ ...i, nudges: { ...i.nudges, ready_checked: at } }));
  }
  let pr: FactoryPr;
  try {
    pr = await ctx.github.prDetails(project.id, item.pr.number);
  } catch (error) {
    ctx.store.updateItem(item.id, (i) => ({
      ...i,
      note: `Could not read the PR: ${errorMessage(error)}`,
    }));
    return loop;
  }
  if (pr.ref.state === "merged" || pr.ref.state === "closed") {
    prDecidedOutside(ctx, item, pr.ref);
    return loop;
  }

  const vision = visionOf(project);
  const now = ctx.now();
  const conflicting = pr.mergeable === "conflicting";
  const builder = item.builderSessionId ? ctx.repo.find(item.builderSessionId)?.session : undefined;
  const worktree = builder?.worktreePath ?? null;
  const auditConfigured = Boolean(loop.tuning.auditCommand && worktree);
  const headKey = `${item.id}:${pr.headSha ?? ""}`;
  carryAuditOver(item, pr, headKey);
  // The audit runs in the builder's settled worktree: not once cleanup removed it, not while
  // the builder is mid-turn, and not on a head a rebase is about to replace. Until then it is
  // pending (still required before a merge), never skipped.
  const auditable = builder !== undefined && worktreeSettled(builder) && !conflicting;
  if (auditable && worktree && loop.tuning.auditCommand && !auditCache.has(headKey)) {
    auditCache.set(headKey, await runAudit(ctx, loop.tuning.auditCommand, worktree));
  }
  const evidence = await gatherEvidence(ctx, project, item, pr, headKey);
  // CI gets its time from when this head first appeared, not from when verification began.
  const nudgesFor = (n: FactoryItem["nudges"], reviewed: boolean) =>
    settleConflict(trackHead(n, pr, now.toISOString()).nudges, pr, reviewed);
  const head = trackHead(item.nudges, pr, now.toISOString());
  const recheck = recheckOf({ ...item, nudges: nudgesFor(item.nudges, Boolean(item.review)) });
  const { checks, outcome } = evaluateChecks({
    pr,
    issueTitle: item.issue?.title ?? item.title,
    review: item.review,
    recheck: recheck !== null,
    reviewer: item.reviewerProvider,
    type: item.type,
    evidence: evidence.screenshots,
    testOutput: evidence.testOutput,
    audit: auditCache.get(headKey) ?? null,
    auditConfigured,
    ciTimedOut: now.getTime() - Date.parse(head.since) > ctx.ciGraceMs,
    limits: project.factoryLimits,
    tuning: loop.tuning,
    largeChange: item.largeChange ?? null,
    areas: vision.parsed.protectedAreas,
    now: now.toISOString(),
  });
  let current = ctx.store.updateItem(item.id, (i) => ({
    ...i,
    pr: pr.ref,
    checks: sameChecks(i.checks, checks) ? i.checks : checks,
    nudges: nudgesFor(i.nudges, Boolean(i.review)),
  }));

  if (outcome === "escalate") return escalate(ctx, loop, current, checks);
  if (outcome === "fail") {
    return handleFailure(ctx, project, loop, current, conflicting ? baseBranchOf(project) : null);
  }
  if (outcome === "pending") {
    // Merge conflicts (another merge came first): the PR's agent rebases, then CI runs again.
    // A review in progress still counts; a new one waits for the rebased head.
    if (conflicting) return advanceConflicting(ctx, project, loop, current, pr);
    // The audit is due but cleanup removed the builder's worktree: bring it back first.
    if (auditConfigured && builder?.worktreeRemovedAt && !auditCache.has(headKey)) {
      return restoreForAudit(ctx, project, loop, current, builder, pr.headSha);
    }
    const reviewed = checks.find((c) => c.name === "review")?.state !== "skipped";
    if (!reviewed) return loop;
    current = await ensureReviewer(ctx, project, current, vision.text, pr);
    return reviewerStalled(ctx, project, loop, current);
  }

  // Every check passed: the merge queue merges it in its turn, or a person does.
  if (!mayAutoMerge(current, project.factoryLimits) || !isFactoryMode(project.autonomyMode)) {
    current = leaveQueue(ctx, current);
    await readyForYou(ctx, project, current);
    return loop;
  }
  joinQueue(ctx, current);
  return loop;
}

/**
 * A head the merge queue made with GitHub's update-branch only merged the default branch in:
 * the audit result of the head before it still holds (it ran in the builder's worktree).
 */
function carryAuditOver(item: FactoryItem, pr: FactoryPr, headKey: string): void {
  const prev = trackedHead(item);
  if (!prev || prev === pr.headSha || !item.nudges[`${UPDATE}${prev}`]) return;
  const was = auditCache.get(`${item.id}:${prev}`);
  if (was && !auditCache.has(headKey)) auditCache.set(headKey, was);
}

/** Screenshots (UI changes) and test output (code changes), cached once found. */
async function gatherEvidence(
  ctx: FactoryContext,
  project: Project,
  item: FactoryItem,
  pr: FactoryPr,
  headKey: string,
): Promise<{ screenshots: boolean | null; testOutput: boolean | null }> {
  const wantScreens = pr.files.some(isUiFile);
  const wantTests = codeFiles(pr.files).length > 0 && !hasTestResults(pr.body);
  if (!wantScreens && !wantTests) return { screenshots: null, testOutput: null };
  let found = evidenceCache.get(headKey);
  if (!found || (wantScreens && !found.screenshots) || (wantTests && !found.testOutput)) {
    const looked = await ctx.github
      .evidence(project.id, pr.ref.number, item.issue?.number ?? null)
      .catch(() => null);
    if (!looked) return { screenshots: null, testOutput: null };
    found = looked;
    if (found.screenshots || found.testOutput) evidenceCache.set(headKey, found);
  }
  return {
    screenshots: wantScreens ? found.screenshots : null,
    testOutput: wantTests ? found.testOutput : false,
  };
}

/**
 * Start the independent reviewer (another provider when possible), ask it to look again, or
 * ask it to re-check only a conflict resolution an agent made since it approved.
 */
async function ensureReviewer(
  ctx: FactoryContext,
  project: Project,
  item: FactoryItem,
  vision: string,
  pr: FactoryPr,
): Promise<FactoryItem> {
  const old = recheckOf(item);
  if (item.review && old) return requestRecheck(ctx, project, item, old, pr.headSha ?? "HEAD");
  if (item.review) return item;
  if (item.reviewerSessionId) {
    if (!item.nudges.rereview_pending) return item;
    await ctx.sessions.message(item.reviewerSessionId, reReviewPrompt(item));
    return ctx.store.updateItem(item.id, (i) => {
      const { rereview_pending: _p, ...rest } = i.nudges;
      return { ...i, nudges: { ...rest, rereview_sent: ctx.now().toISOString() } };
    });
  }
  if (ctx.sessions.activeCount(item.projectId) >= project.factoryLimits.maxConcurrentSessions) {
    return ctx.store.updateItem(item.id, (i) => ({
      ...i,
      note: "Waiting for a free agent for the review",
    }));
  }
  const choice = pickReviewer(item.builderProvider, ctx.sessions.providers());
  // No builder worktree (a revert PR opened through the API): review the PR's head locally.
  const head = item.builderSessionId
    ? null
    : { headBranch: pr.headBranch, baseBranch: project.defaultBranch ?? "main" };
  const res = await ctx.sessions.startReviewer(
    item,
    vision,
    choice.provider,
    choice.note,
    head,
    mayAutoMerge(item, project.factoryLimits),
  );
  if (res.status !== "started") {
    return ctx.store.updateItem(item.id, (i) => ({
      ...i,
      note: `Review not started (${res.status})`,
    }));
  }
  return ctx.store.updateItem(item.id, (i) => ({
    ...i,
    reviewerSessionId: res.sessionId,
    reviewerProvider: choice.provider,
    reviewerNote: choice.note,
    note: null,
  }));
}

/**
 * An agent rebased the PR to resolve conflicts after the reviewer approved: the reviewer
 * re-checks only the resolution (`git range-diff`). When the reviewer session can't take the
 * message any more, a fresh reviewer reviews the whole PR instead.
 */
async function requestRecheck(
  ctx: FactoryContext,
  project: Project,
  item: FactoryItem,
  oldHead: string,
  newHead: string,
): Promise<FactoryItem> {
  if (item.nudges.recheck_sent) return item;
  const reviewer = item.reviewerSessionId
    ? ctx.repo.find(item.reviewerSessionId)?.session
    : undefined;
  if (!reviewer || reviewer.status === "failed" || reviewer.archivedAt) {
    return ctx.store.updateItem(item.id, (i) => ({
      ...i,
      review: null,
      reviewerSessionId: null,
      note: "Rebased after the review, and the reviewer is gone: a fresh review follows",
      nudges: withoutRecheck(i.nudges),
    }));
  }
  await ctx.sessions.message(
    reviewer.id,
    recheckPrompt(item, oldHead, newHead, baseBranchOf(project)),
  );
  const at = ctx.now().toISOString();
  return ctx.store.updateItem(item.id, (i) => {
    const { reviewer: _nudged, ...nudges } = i.nudges;
    return {
      ...i,
      note: "Rebased after the review: the reviewer re-checks the conflict resolution",
      nudges: { ...nudges, recheck_sent: at },
    };
  });
}

/**
 * While checks are pending: nudge a reviewer that ended its turn without a verdict (or without
 * its re-check), and fail the review once it ends again without one and stays idle past the
 * grace period. A reviewer session that died is replaced, up to `MAX_REVIEWER_RESTARTS` times.
 */
async function reviewerStalled(
  ctx: FactoryContext,
  project: Project,
  loop: FactoryLoop,
  item: FactoryItem,
): Promise<FactoryLoop> {
  const rechecking = Boolean(item.review && recheckOf(item) && item.nudges.recheck_sent);
  if ((item.review && !rechecking) || !item.reviewerSessionId || item.nudges.rereview_pending)
    return loop;
  const s = ctx.repo.find(item.reviewerSessionId)?.session;
  if (!s || !ENDED.has(s.status)) return loop;
  if (s.status === "failed") return reviewerDied(ctx, loop, item);
  if (s.status === "stopped") {
    if (item.nudges.reviewer_restarted)
      return failReview(ctx, project, loop, item, "The reviewer session stopped");
    ctx.store.updateItem(item.id, (i) => ({
      ...i,
      reviewerSessionId: null,
      nudges: { ...withoutRecheck(i.nudges), reviewer_restarted: ctx.now().toISOString() },
      review: rechecking ? null : i.review,
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
 * The reviewer session died (an error, not a verdict): a fresh reviewer takes over, without a
 * revise round. After `MAX_REVIEWER_RESTARTS` the item fails as an infrastructure failure.
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
    // A re-check falls back to a whole review by the fresh reviewer.
    review: recheckOf(i) ? null : i.review,
    nudges: { ...withoutRecheck(i.nudges), [`reviewer_failed_${n + 1}`]: at },
  }));
  return loop;
}

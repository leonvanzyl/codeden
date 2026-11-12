import {
  type FactoryItem,
  type FactoryLoop,
  isFactoryMode,
  type Project,
} from "@codeden/contracts";
import { errorMessage } from "../errors";
import {
  codeFiles,
  evaluateChecks,
  failedChecks,
  hasTestResults,
  notAuthorFixable,
  sameChecks,
} from "./checks";
import { type FactoryContext, factoryNotice, visionOf } from "./context";
import type { FactoryPr, PrEvidence } from "./github-port";
import { stoppedSinceNudge } from "./idle";
import { autoMerge, prDecidedOutside, readyForYou } from "./merge";
import { escalate, failItem, runAudit } from "./outcomes";
import { isUiFile, mayMerge, pickReviewer } from "./policy";
import { fixPrompt, REVIEWER_NUDGE, reReviewPrompt, tooLargePrompt } from "./prompts";
import {
  advanceConflicting,
  baseBranchOf,
  restoreForAudit,
  trackHead,
  worktreeSettled,
} from "./rebase";
import { mayAutoMerge } from "./trust";

const ENDED = new Set(["idle", "interrupted", "completed", "failed", "stopped"]);

/** Audit results per item and head commit (re-run after a restart is fine). */
const auditCache = new Map<string, { ok: boolean; detail: string }>();
/** Evidence found per item and head commit (only what was found; misses are looked up again). */
const evidenceCache = new Map<string, PrEvidence>();

/** How often a PR that is ready for a person is read from GitHub again (new commits, CI). */
export const READY_RECHECK_MS = 5 * 60_000;

/**
 * One verification step for an item with a PR (§10.1, Review and Merge): gather the inputs,
 * record the merge checks, start or nudge the independent reviewer, then merge (auto-merge on,
 * trusted work) or hand it to the user to merge, start a revise round, fail or escalate.
 */
export async function advanceVerifying(
  ctx: FactoryContext,
  project: Project,
  loop: FactoryLoop,
  item: FactoryItem,
): Promise<FactoryLoop> {
  if (!item.pr) return failItem(ctx, loop, item, "The item has no pull request");
  // Ready and waiting for a person: the synced PR says when they merge or close it; GitHub
  // itself is asked again only every few minutes (new commits, CI), or when auto-merge may act.
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
  // The audit runs in the builder's settled worktree: not once cleanup removed it, not while
  // the builder is mid-turn, and not on a head a rebase is about to replace. Until then it is
  // pending (still required before a merge), never skipped.
  const auditable = builder !== undefined && worktreeSettled(builder) && !conflicting;
  if (auditable && worktree && loop.tuning.auditCommand && !auditCache.has(headKey)) {
    auditCache.set(headKey, await runAudit(ctx, loop.tuning.auditCommand, worktree));
  }
  const evidence = await gatherEvidence(ctx, project, item, pr, headKey);
  // CI gets its time from when this head first appeared, not from when verification began.
  const head = trackHead(item.nudges, pr, now.toISOString());
  const { checks, outcome } = evaluateChecks({
    pr,
    issueTitle: item.issue?.title ?? item.title,
    review: item.review,
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
    nudges: trackHead(i.nudges, pr, now.toISOString()).nudges,
  }));

  if (outcome === "escalate") return escalate(ctx, loop, current, checks);
  if (outcome === "fail") {
    return handleFailure(ctx, project, loop, current, conflicting ? baseBranchOf(project) : null);
  }
  if (outcome === "pending") {
    // Merge conflicts (another merge came first): the builder rebases, then CI runs again.
    // A review in progress still counts; a new one waits for the rebased head.
    if (conflicting) return advanceConflicting(ctx, project, loop, current);
    // The audit is due but cleanup removed the builder's worktree: bring it back first.
    if (auditConfigured && builder?.worktreeRemovedAt && !auditCache.has(headKey)) {
      return restoreForAudit(ctx, project, loop, current, builder, pr.headSha);
    }
    const reviewed = checks.find((c) => c.name === "review")?.state !== "skipped";
    if (!reviewed) return loop;
    current = await ensureReviewer(ctx, current, vision.text);
    return reviewerStalled(ctx, project, loop, current);
  }

  // Every check passed.
  if (!mayAutoMerge(current, project.factoryLimits) || !isFactoryMode(project.autonomyMode)) {
    await readyForYou(ctx, project, current);
    return loop;
  }
  if (loop.state === "paused" && current.source !== "revert") {
    ctx.store.updateItem(current.id, (i) => ({
      ...i,
      note: "Checks passed; waiting while the loop is paused",
    }));
    return loop;
  }
  if (!mayMerge(loop.mergesToday, project.factoryLimits)) {
    ctx.store.updateItem(current.id, (i) => ({
      ...i,
      note: "Checks passed; the daily merge limit is reached",
    }));
    return loop;
  }
  return autoMerge(ctx, project, loop, current, pr, checks);
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

/** Start the independent reviewer (another provider when possible), or ask it to look again. */
async function ensureReviewer(
  ctx: FactoryContext,
  item: FactoryItem,
  vision: string,
): Promise<FactoryItem> {
  if (item.review) return item;
  if (item.reviewerSessionId) {
    if (!item.nudges.rereview_pending) return item;
    await ctx.sessions.message(item.reviewerSessionId, reReviewPrompt(item));
    return ctx.store.updateItem(item.id, (i) => {
      const { rereview_pending: _p, ...rest } = i.nudges;
      return { ...i, nudges: { ...rest, rereview_sent: ctx.now().toISOString() } };
    });
  }
  const project = ctx.projects.get(item.projectId);
  if (ctx.sessions.activeCount(item.projectId) >= project.factoryLimits.maxConcurrentSessions) {
    return ctx.store.updateItem(item.id, (i) => ({
      ...i,
      note: "Waiting for a free agent for the review",
    }));
  }
  const choice = pickReviewer(item.builderProvider, ctx.sessions.providers());
  // No builder worktree (a revert PR opened through the API): review the PR's head locally.
  let head: { headBranch: string; baseBranch: string } | null = null;
  if (!item.builderSessionId && item.pr) {
    const details = await ctx.github.prDetails(project.id, item.pr.number).catch(() => null);
    if (details) {
      head = { headBranch: details.headBranch, baseBranch: project.defaultBranch ?? "main" };
    }
  }
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
 * While checks are pending: nudge a reviewer that ended its turn without a verdict, and fail
 * the review once it ends again without one and stays idle past the grace period.
 */
async function reviewerStalled(
  ctx: FactoryContext,
  project: Project,
  loop: FactoryLoop,
  item: FactoryItem,
): Promise<FactoryLoop> {
  if (item.review || !item.reviewerSessionId || item.nudges.rereview_pending) return loop;
  const s = ctx.repo.find(item.reviewerSessionId)?.session;
  if (!s || !ENDED.has(s.status)) return loop;
  if (s.status === "failed" || s.status === "stopped") {
    if (item.nudges.reviewer_restarted)
      return failReview(ctx, project, loop, item, `The reviewer session ${s.status}`);
    ctx.store.updateItem(item.id, (i) => ({
      ...i,
      reviewerSessionId: null,
      nudges: { ...i.nudges, reviewer_restarted: ctx.now().toISOString() },
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

function failReview(
  ctx: FactoryContext,
  project: Project,
  loop: FactoryLoop,
  item: FactoryItem,
  reason: string,
): Promise<FactoryLoop> {
  const at = ctx.now().toISOString();
  const current = ctx.store.updateItem(item.id, (i) => ({
    ...i,
    checks: i.checks.map((c) =>
      c.name === "review" ? { ...c, state: "fail" as const, detail: reason, at } : c,
    ),
  }));
  return handleFailure(ctx, project, loop, current);
}

/**
 * Failed checks: a revise round if allowed, otherwise the item fails (and may pause). CI that
 * never started is no code problem, so it alone fails the item without a revise round.
 */
async function handleFailure(
  ctx: FactoryContext,
  project: Project,
  loop: FactoryLoop,
  item: FactoryItem,
  /** The base branch, when the PR also has merge conflicts with it. */
  conflictsWith: string | null = null,
): Promise<FactoryLoop> {
  const failed = failedChecks(item.checks);
  // A revise round can't make work smaller without cutting scope: the PM splits or allows it.
  if (failed.some((c) => c.name === "size")) return tooLarge(ctx, project, loop, item);
  const builder = item.builderSessionId ? ctx.repo.find(item.builderSessionId)?.session : undefined;
  const fixable =
    failed.some((c) => !notAuthorFixable(c)) &&
    item.attempts < loop.tuning.maxFixAttempts &&
    builder !== undefined &&
    builder.status !== "failed" &&
    builder.status !== "stopped" &&
    item.review?.verdict !== "reject";
  if (fixable && builder) {
    const at = ctx.now().toISOString();
    ctx.store.updateItem(item.id, (i) => {
      const { ready: _ready, ...nudges } = i.nudges;
      return {
        ...i,
        stage: "building",
        attempts: i.attempts + 1,
        review: null,
        note: `Revise round ${i.attempts + 1}: ${failed.map((c) => c.name).join(", ")}`,
        nudges: {
          ...nudges,
          [`fix_${i.attempts + 1}`]: at,
          ...(i.reviewerSessionId ? { rereview_pending: at } : {}),
        },
      };
    });
    await ctx.sessions.message(builder.id, fixPrompt(item, failed, conflictsWith));
    return loop;
  }
  const reason =
    failed.map((c) => `${c.name}: ${c.detail ?? "failed"}`).join("; ") || "Merge checks failed";
  const next = failItem(ctx, loop, item, reason);
  if (item.pr) {
    await ctx.github
      .comment(
        project.id,
        item.pr.number,
        `The CodeDen factory's checks failed, so this PR is left for a human:\n\n${failed.map((c) => `- **${c.name}**: ${c.detail ?? "failed"}`).join("\n")}`,
      )
      .catch((error: unknown) => ctx.log?.(`factory: comment: ${errorMessage(error)}`));
  }
  return next;
}

/**
 * The size check failed. That isn't a quality failure, so it doesn't count towards pausing
 * the loop, and no revise round runs. The PM is woken to split the work into smaller issues
 * or, when it can't be split, to allow it with `factory_allow_large_change`. The PR stays open.
 */
async function tooLarge(
  ctx: FactoryContext,
  project: Project,
  loop: FactoryLoop,
  item: FactoryItem,
): Promise<FactoryLoop> {
  const failed = failedChecks(item.checks);
  const size = failed.find((c) => c.name === "size");
  const reason = failed.map((c) => `${c.name}: ${c.detail ?? "failed"}`).join("; ");
  const next = failItem(ctx, loop, item, reason, { countsAsFailure: false, notify: false });
  factoryNotice(ctx, {
    id: `factory.too-large:${item.id}:${item.pr?.number ?? ""}`,
    projectId: item.projectId,
    target: "pm",
    event: "failed",
    title: `Too large for the factory: ${item.title}`,
    text: tooLargePrompt(item, size?.detail ?? "over the size limit", failed),
    itemIds: [item.id],
  });
  if (item.pr) {
    await ctx.github
      .comment(
        project.id,
        item.pr.number,
        `This PR is larger than the CodeDen factory's size limit (${size?.detail ?? "over the limit"}). The project manager will split the work into smaller issues or allow it as one change.`,
      )
      .catch((error: unknown) => ctx.log?.(`factory: comment: ${errorMessage(error)}`));
  }
  return next;
}

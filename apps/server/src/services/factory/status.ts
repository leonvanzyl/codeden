import {
  type FactoryItem,
  type FactoryItemCost,
  type FactoryLoop,
  type FactoryMergeChecks,
  type FactoryStatus,
  type FactoryWorkItem,
  type GitHubPrRef,
  isFactoryMode,
  LESSONS_IN_BRIEF,
  type Project,
  pipelineStep,
  type ScoutStatus,
} from "@codeden/contracts";
import { budgetSpend, type FactoryContext, visionOf } from "./context";
import { drainStatus } from "./drain";
import { heldFollowUps } from "./follow-ups-held";
import { heldIssues, itemHeld } from "./hold";
import { itemCosts } from "./item-cost";
import { lessonsInForce } from "./lessons";
import { localDay, queueOrder } from "./policy";
import { decidedPr } from "./pr-gone";
import { ownedPr, pullRequests } from "./pr-status";
import { recoverable } from "./recover";
import { scoutNowBlocker, scoutNowFacts } from "./scout";
import { isBusy } from "./sessions";
import { spotCheckStatus } from "./spot-checks";
import { factoryStats, viewRecentItems, viewWindow } from "./stats";
import { ACTIVE_STAGES, DONE_STAGES, VIEW_ITEMS, WAITING_STAGES } from "./store";
import { wipOf } from "./wip";

/**
 * A work item for the panel and the pipeline diagram; `owned` is the open PR the factory still
 * owns for it (`ownedPr`), `cost` what it cost so far (`item-cost.ts`).
 */
export function workItem(
  i: FactoryItem,
  owned: GitHubPrRef | null = null,
  cost: FactoryItemCost | null = null,
): FactoryWorkItem {
  const step = pipelineStep(i);
  return {
    id: i.id,
    title: i.title,
    workKey: i.workKey,
    issue: i.issue,
    pr: i.pr,
    score: i.score,
    sessionId: i.builderSessionId,
    reviewerSessionId: i.reviewerSessionId,
    activeSessionId:
      step === "review" && i.reviewerSessionId ? i.reviewerSessionId : i.builderSessionId,
    stage: i.stage,
    step,
    type: i.type,
    trust: i.trust,
    author: i.author,
    source: i.source,
    specApproval: i.specApproval?.state ?? null,
    attempts: i.attempts,
    reason: i.reason,
    note: i.note,
    failureKind: i.failureKind,
    stepSince: i.stepSince,
    mergedAt: i.mergedAt,
    finishedAt: i.finishedAt,
    ownedPr: owned,
    recovering: recoverable(i),
    checks:
      i.checks.length === 0
        ? null
        : {
            passed: i.checks.filter((c) => c.state === "pass" || c.state === "skipped").length,
            failed: i.checks.filter((c) => c.state === "fail").length,
            total: i.checks.length,
          },
    cost,
    updatedAt: i.updatedAt,
  };
}

/**
 * A PR the panel still has CI to wait on. A PR whose GitHub state already settled - merged or
 * closed, by a person or by the merge queue - decides nothing the factory can act on, so it does
 * not gate here either: `pullRequests` has already left it out and the two views have to agree.
 * The item keeps the checks it recorded (`workItem`), and nothing about it reopens or retries.
 */
function mergeChecks(ctx: FactoryContext, i: FactoryItem): FactoryMergeChecks | null {
  if (!i.pr || i.checks.length === 0) return null;
  if (decidedPr(ctx, i)) return null;
  return {
    itemId: i.id,
    prNumber: i.pr.number,
    title: i.title,
    checks: i.checks,
    reviewerProvider: i.reviewerProvider,
    reviewerNote: i.reviewerNote,
    verdict: i.review?.verdict ?? null,
  };
}

/** `GET /api/projects/:id/factory`: everything the factory panel shows (§10.1 visibility). */
export async function buildStatus(ctx: FactoryContext, projectId: string): Promise<FactoryStatus> {
  const project = ctx.projects.get(projectId);
  const loop = ctx.store.loopOrNew(projectId, ctx.now());
  const all = ctx.store.items(projectId, undefined, { limit: VIEW_ITEMS });
  // In the order free agents take them; parked ones are listed as held instead (`hold.ts`).
  const waiting = all
    .filter((i) => WAITING_STAGES.includes(i.stage) && !itemHeld(ctx, i))
    .sort(queueOrder);
  const active = all.filter((i) => ACTIVE_STAGES.includes(i.stage));
  const done = all.filter((i) => DONE_STAGES.includes(i.stage)).slice(0, 30);
  const ignored = all.filter((i) => i.stage === "ignored").slice(0, 30);
  const owned = (i: FactoryItem) => ownedPr(ctx, i);
  const { failedSince, mergedSince } = viewWindow(ctx.now());
  // Not capped like `recent` (nor by the view's item limit): an older escalation or
  // open failure still reaches the view.
  const viewRecent = viewRecentItems(
    ctx.store.viewCandidates(projectId, failedSince, mergedSince),
    ctx.now(),
    (i) => owned(i) !== null,
  );
  // What each listed item cost so far, from one read of the ledger (ignored issues never ran).
  const costs = await itemCosts(ctx, projectId, project.factoryLimits, [
    ...new Map([...waiting, ...active, ...done, ...viewRecent].map((i) => [i.id, i])).values(),
  ]);
  const toWork = (i: FactoryItem) => workItem(i, owned(i), costs.get(i.id) ?? null);
  const spend = budgetSpend(ctx, projectId, localDay(ctx.now()), project.factoryLimits);
  const globalKill = ctx.settings.get().factory.killSwitch;
  const githubLogin = isFactoryMode(project.autonomyMode)
    ? await ctx.github.viewerLogin().catch(() => null)
    : null;
  return {
    projectId,
    mode: project.autonomyMode,
    experimental: isFactoryMode(project.autonomyMode),
    loopState: project.killSwitch || globalKill ? "stopped" : loop.state,
    pausedReason: loop.pausedReason,
    killSwitch: project.killSwitch,
    globalKillSwitch: globalKill,
    drain: drainStatus(ctx, projectId, loop),
    limits: project.factoryLimits,
    tuning: loop.tuning,
    spendToday: { usd: Math.round(spend.usd * 10_000) / 10_000, tokens: spend.tokens },
    mergesToday: loop.day === localDay(ctx.now()) ? loop.mergesToday : 0,
    stats: factoryStats(all, ctx.now()),
    consecutiveFailures: loop.consecutiveFailures,
    activeSessions: ctx.sessions.activeCount(projectId),
    wip: wipOf(ctx, project, loop),
    backlog: waiting.map(toWork),
    inProgress: active.map(toWork),
    mergeChecks: [...active, ...done].flatMap((i) => mergeChecks(ctx, i) ?? []).slice(0, 20),
    pullRequests: pullRequests(ctx, project, all),
    recent: done.map(toWork),
    viewRecent: viewRecent.map(toWork),
    ignored: ignored.map((i) => workItem(i)),
    held: heldIssues(ctx, projectId, loop, all),
    githubLogin,
    scout: project.autonomyMode === "dark_factory" ? scoutStatus(ctx, project, loop, spend) : null,
    visionExists: visionOf(project).exists,
    lessons: lessonsInForce(ctx, projectId).slice(0, LESSONS_IN_BRIEF),
    spotChecks: spotCheckStatus(ctx, project, loop),
    lastDigest: ctx.store.digests(projectId, 1)[0] ?? null,
    // Kept in memory: an idle tick saves nothing (`FactoryStore.saveTick`).
    lastTickAt: ctx.store.lastTick(projectId) ?? loop.lastTickAt,
  };
}

/** The scout as the dashboard shows it (`spend`: today's, against the budget). */
function scoutStatus(
  ctx: FactoryContext,
  project: Project,
  loop: FactoryLoop,
  spend: { usd: number; tokens: number },
): ScoutStatus {
  const { scout, tuning } = loop;
  const round = scout.round;
  const active = (id: string) => {
    const s = ctx.repo.find(id)?.session;
    return s !== undefined && isBusy(s);
  };
  return {
    phase: round?.phase ?? "idle",
    sessionId: scout.sessionId,
    lenses: (round?.lenses ?? []).map((l) => ({
      area: l.area,
      sessionId: l.sessionId,
      reported: l.reported,
      active: active(l.sessionId),
    })),
    waiting: round?.plan?.pending ?? [],
    findings: round?.findings.length ?? 0,
    filed: round?.filed ?? 0,
    lastRoundAt: scout.lastRoundAt,
    lastRoundNote: scout.lastRoundNote,
    nextRoundAt:
      round || !scout.lastRoundAt || tuning.minBacklog === 0
        ? null
        : new Date(
            Date.parse(scout.lastRoundAt) + tuning.discoveryIntervalMin * 60_000,
          ).toISOString(),
    rounds: scout.rounds,
    runNowBlockedBy: scoutNowBlocker(project, loop, scoutNowFacts(ctx, project, loop, spend)),
    heldFollowUps: heldFollowUps(ctx, project.id),
  };
}

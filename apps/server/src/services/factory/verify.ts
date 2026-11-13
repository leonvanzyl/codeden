import {
  type FactoryItem,
  type FactoryLoop,
  isFactoryMode,
  type Project,
} from "@codeden/contracts";
import { errorMessage } from "../errors";
import { codeFiles, evaluateChecks, hasTestResults, sameChecks } from "./checks";
import { kickCi } from "./ci-kick";
import { type FactoryContext, visionOf } from "./context";
import { handleFailure } from "./failures";
import type { FactoryPr, PrEvidence } from "./github-port";
import { prDecidedOutside, readyForYou } from "./merge";
import { escalate, failItem, runAudit } from "./outcomes";
import { isUiFile } from "./policy";
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
  worktreeSettled,
} from "./rebase";
import { adoptAgentPr } from "./rebuild";
import { ensureReviewer, reviewerStalled } from "./reviewer";
import { mayAutoMerge } from "./trust";

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
  item = adoptAgentPr(ctx, project, item);
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
  // CI that never started is started again (by its agent, or an integrator that takes the PR
  // over when the author's session is gone); its clock waits until that happened.
  const kicking = await kickCi(ctx, project, item, pr);
  item = ctx.store.item(item.id) ?? item;

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
    ciTimedOut: !kicking && now.getTime() - Date.parse(head.since) > ctx.ciGraceMs,
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

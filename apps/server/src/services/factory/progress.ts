import type { FactoryItem, FactoryLoop, Project } from "@codeden/contracts";
import { errorMessage } from "../errors";
import { type FactoryContext, factoryNotice, pauseLoop, raiseInbox } from "./context";
import { failItem } from "./outcomes";
import { ANALYZE_NUDGE, BUILDER_NUDGE, REPRODUCE_NUDGE } from "./prompts";

const BUSY = new Set(["created", "queued", "starting", "running", "waiting"]);

/**
 * Building (§10.1): wait for the builder's turn to end with its first step reported (bugs and
 * features) and then an open PR; nudge it once when it ends without, fail the item when the
 * session dies or ends again without.
 */
export async function advanceBuilding(
  ctx: FactoryContext,
  project: Project,
  loop: FactoryLoop,
  item: FactoryItem,
): Promise<FactoryLoop> {
  const s = item.builderSessionId ? ctx.repo.find(item.builderSessionId)?.session : undefined;
  if (!s) return failItem(ctx, loop, item, "The builder session is gone");
  if (BUSY.has(s.status)) return loop;
  const fixAt = item.attempts > 0 ? item.nudges[`fix_${item.attempts}`] : undefined;
  // After a fix request, wait until the builder has taken a turn since.
  if (fixAt && Date.parse(s.updatedAt) <= Date.parse(fixAt) && s.status === "idle") return loop;
  const pr = s.pr ?? ctx.github.prForSession(project.id, s.id, s.branch);
  if (pr && pr.state !== "closed" && pr.state !== "merged") {
    const at = ctx.now().toISOString();
    ctx.store.updateItem(item.id, (i) => ({
      ...i,
      stage: "verifying",
      pr,
      note: null,
      nudges: { ...i.nudges, verifying: at },
    }));
    return loop;
  }
  if (s.status === "failed" || s.status === "stopped") {
    return failItem(ctx, loop, item, `The builder session ${s.status} without a pull request`);
  }
  const investigating = !item.investigation && (item.type === "bug" || item.type === "feature");
  if (investigating) {
    const step = item.type === "bug" ? "reproduction" : "analysis";
    const asked = item.nudges.builder_investigate;
    if (!asked) {
      const at = ctx.now().toISOString();
      ctx.store.updateItem(item.id, (i) => ({
        ...i,
        nudges: { ...i.nudges, builder_investigate: at },
      }));
      await ctx.sessions.message(s.id, item.type === "bug" ? REPRODUCE_NUDGE : ANALYZE_NUDGE);
      return loop;
    }
    if (Date.parse(s.updatedAt) > Date.parse(asked)) {
      return failItem(ctx, loop, item, `The builder ended without reporting its ${step}`);
    }
    return loop;
  }
  const nudged = item.nudges.builder_no_pr;
  if (!nudged) {
    const at = ctx.now().toISOString();
    ctx.store.updateItem(item.id, (i) => ({ ...i, nudges: { ...i.nudges, builder_no_pr: at } }));
    await ctx.sessions.message(s.id, BUILDER_NUDGE);
    return loop;
  }
  if (Date.parse(s.updatedAt) > Date.parse(nudged)) {
    const why = s.result ? `${s.result.outcome}: ${s.result.summary}` : "no pull request";
    return failItem(ctx, loop, item, `The builder finished without a pull request (${why})`);
  }
  return loop;
}

/**
 * Watching (§10.1 step 6): after a merge, CI on the default branch decides. A regression opens
 * an automatic revert PR (through the same merge checks), pauses the loop and asks the user.
 */
export async function advanceWatching(
  ctx: FactoryContext,
  project: Project,
  loop: FactoryLoop,
  item: FactoryItem,
): Promise<FactoryLoop> {
  const done = (note: string | null) => {
    ctx.store.updateItem(item.id, (i) => ({
      ...i,
      stage: "merged",
      note,
      finishedAt: ctx.now().toISOString(),
    }));
    return loop;
  };
  if (!item.mergeSha) return done("Merged (no merge commit reported)");
  let state: Awaited<ReturnType<typeof ctx.github.commitChecks>>;
  try {
    state = await ctx.github.commitChecks(project.id, item.mergeSha);
  } catch (error) {
    ctx.store.updateItem(item.id, (i) => ({
      ...i,
      note: `Could not read main CI: ${errorMessage(error)}`,
    }));
    return loop;
  }
  const age = ctx.now().getTime() - Date.parse(item.mergedAt ?? item.updatedAt);
  const timedOut = age > loop.tuning.watchTimeoutMin * 60_000;
  if (state === "success") return done(null);
  if (state === "none")
    return age > ctx.ciGraceMs || !loop.tuning.requireCi
      ? done("No CI ran on the default branch")
      : loop;
  if (state === "pending")
    return timedOut
      ? done(`Main CI did not finish within ${loop.tuning.watchTimeoutMin} minutes`)
      : loop;
  return regression(ctx, project, loop, item);
}

async function regression(
  ctx: FactoryContext,
  project: Project,
  loop: FactoryLoop,
  item: FactoryItem,
): Promise<FactoryLoop> {
  const sha = item.mergeSha ?? "";
  const prNumber = item.pr?.number ?? 0;
  const branch =
    project.kind === "github" ? project.github.defaultBranch : (project.defaultBranch ?? "main");
  const at = ctx.now().toISOString();
  let next = { ...loop, consecutiveFailures: loop.consecutiveFailures + 1 };
  if (item.source === "revert") {
    ctx.store.updateItem(item.id, (i) => ({
      ...i,
      stage: "merged",
      note: "CI still fails after the revert",
      finishedAt: at,
    }));
    return pauseLoop(
      ctx,
      next,
      `CI on ${branch} still fails after the automatic revert #${prNumber}`,
    );
  }
  const revertPr = await ctx.github
    .revertMerge(project.id, { sha, prNumber, title: item.title })
    .catch((error: unknown) => {
      ctx.log?.(`factory: revert via API: ${errorMessage(error)}`);
      return null;
    });
  const base = {
    projectId: project.id,
    workKey: `factory:revert:${sha.slice(0, 7) || item.id.slice(0, 7)}`,
    title: `Revert "${item.title}"`.slice(0, 200),
    summary: `CI on ${branch} failed after #${prNumber} was merged (${sha}).`,
    source: "revert" as const,
    area: item.area,
    type: "bug" as const,
    investigation: {
      kind: "reproduction" as const,
      outcome: "reproduced" as const,
      summary: `CI on ${branch} failed after #${prNumber} was merged.`,
      details: null,
      testPath: null,
      at,
    },
    acceptanceCriteria: [
      `Restores ${branch} to its state before #${prNumber}`,
      `CI on ${branch} is green again`,
    ],
    issue: item.issue,
    revertOf: item.id,
  };
  let revertNote: string;
  if (revertPr) {
    ctx.store.createItem({ ...base, stage: "verifying", pr: revertPr, nudges: { verifying: at } });
    revertNote = `revert PR #${revertPr.number} is open`;
  } else {
    const res = await ctx.sessions.startRevert(project.id, { sha, prNumber, title: item.title });
    const sessionId = res.status === "started" ? res.sessionId : null;
    ctx.store.createItem({
      ...base,
      stage: sessionId ? "building" : "failed",
      builderSessionId: sessionId,
      note: sessionId ? "An agent is writing the revert" : null,
      reason: sessionId ? null : `Could not start the revert session (${res.status})`,
    });
    revertNote = sessionId
      ? "an agent is writing the revert PR"
      : "the revert could not be started";
  }
  ctx.store.updateItem(item.id, (i) => ({
    ...i,
    stage: "reverted",
    reason: `CI on ${branch} failed after the merge`,
    note: revertNote,
    finishedAt: at,
  }));
  raiseInbox(ctx, {
    id: `inbox:factory-regression:${item.id}`,
    kind: "run_failed",
    notify: "failure",
    priority: "high",
    projectId: project.id,
    issue: item.issue,
    pr: revertPr ?? item.pr,
    title: `Factory regression on ${branch}: ${item.title}`,
    body: `CI on ${branch} failed after merging #${prNumber} (${sha}); ${revertNote}. The factory loop is paused until you resume it.`,
  });
  factoryNotice(ctx, {
    id: `factory.regression:${item.id}`,
    projectId: project.id,
    target: "pm",
    event: "regression",
    title: `Regression after #${prNumber}; loop paused`,
    text: `CI on ${branch} failed after merging #${prNumber}; ${revertNote}.`,
    itemIds: [item.id],
    wake: false,
  });
  next = pauseLoop(ctx, next, `CI on ${branch} failed after merging #${prNumber}; ${revertNote}`, {
    inbox: false,
  });
  return next;
}

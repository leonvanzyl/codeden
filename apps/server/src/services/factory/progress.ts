import {
  type FactoryItem,
  type FactoryLoop,
  isActiveSession,
  type Project,
  specHeld,
} from "@codeden/contracts";
import { errorMessage } from "../errors";
import { type FactoryContext, factoryNotice, pauseLoop, raiseInbox } from "./context";
import { stoppedSinceNudge } from "./idle";
import { awaitingStart, awaitingStartNote } from "./late-start";
import { MERGED_AFTER } from "./merge";
import { failItem } from "./outcomes";
import { ANALYZE_NUDGE, BUILDER_NUDGE, REPRODUCE_NUDGE } from "./prompts";
import { providerFailure, providerWide } from "./provider-failure";
import { baseBranchOf } from "./rebase";
import { rebuildFailed, unreplacedOriginal } from "./rebuild";
import { recordMainFailure, revertLanded } from "./revert";
import { regressionInboxId, regressionPausePrefix, revertBlocked } from "./revert-blocked";
import {
  revertAgent,
  revertSessionFailure,
  revertStartFailed,
  startRevertAgent,
} from "./revert-start";
import { awaitRevertCi, revertStillRed } from "./revert-watch";
import { advanceSpec } from "./spec-approval";
import { builderOpenPr, holdEarlyPr } from "./spec-early-pr";
import { REVERTED_AT, revertedAt } from "./stats";
import { endStopped, stoppedOnPurpose } from "./stops";
import { awaitTurnRaceResume, BUILDER_FAILED_REASON } from "./turn-race";

/**
 * Building (§10.1): wait for the builder's turn to end with its first step reported (bugs and
 * features) and then an open PR; nudge it once when it ends without, fail the item when it ends
 * again without and stays idle past the grace period (`idleGraceMin`). A builder session that
 * dies or is gone fails it as an infrastructure failure, which the loop recovers by itself; one
 * whose start the runner didn't answer is waited for a while first (`late-start.ts`). A
 * feature's spec that waits for a person's approval holds it at Analyze, with no nudge or failure.
 */
export async function advanceBuilding(
  ctx: FactoryContext,
  project: Project,
  loop: FactoryLoop,
  item: FactoryItem,
): Promise<FactoryLoop> {
  const s = item.builderSessionId ? ctx.repo.find(item.builderSessionId)?.session : undefined;
  // Outside the work's code: the loop puts it back by itself (`recover.ts`).
  const infra = { kind: "infrastructure" } as const;
  // A rebuild that ends without its new PR leaves the PR it was replacing stuck with the user.
  const original = unreplacedOriginal(ctx, item);
  const revert = item.source === "revert";
  const fail = (reason: string) => {
    if (original) return rebuildFailed(ctx, loop, item, original, reason);
    // The agent writing a revert gave up: the default branch stays red, and the user hears it.
    if (revert) return revertBlocked(ctx, project, loop, item, lowerFirst(reason));
    return failItem(ctx, loop, item, reason);
  };
  // Its builder stopped on purpose, with a reason: that call, never a failure (`stops.ts`).
  if (stoppedOnPurpose(ctx, item)) return endStopped(ctx, loop, item);
  // A spec waiting for a person, or their decision on its way to the builder (`spec-approval.ts`).
  const held = await advanceSpec(ctx, project, loop, item, s);
  if (held) return held;
  // The agent writing a revert couldn't start or carry on: it starts again (`revert-start.ts`).
  if (!s && revert) return revertStartFailed(ctx, project, loop, item, "its session is gone");
  if (!s) return failItem(ctx, loop, item, "The builder session is gone", infra);
  if (isActiveSession(s)) return loop;
  // The runner didn't answer its start: it may have started all the same (`late-start.ts`).
  const until = awaitingStart(ctx, s);
  if (until) {
    const note = awaitingStartNote("builder", until);
    if (item.note !== note)
      ctx.store.updateItem(item.id, (i) => ({ ...i, note }), { touch: false });
    return loop;
  }
  const fixAt = item.attempts > 0 ? item.nudges[`fix_${item.attempts}`] : undefined;
  // After a fix request, wait until the builder has taken a turn since.
  if (fixAt && Date.parse(s.updatedAt) <= Date.parse(fixAt) && s.status === "idle") return loop;
  const pr = builderOpenPr(ctx, project.id, s);
  // Opened while the spec is being revised: it waits for the approval (`spec-early-pr.ts`).
  if (pr && specHeld(item)) item = await holdEarlyPr(ctx, item, pr);
  else if (pr) {
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
    // Failed only because a message raced its turn: told to carry on instead.
    if (await awaitTurnRaceResume(ctx, project, loop, item, s)) return loop;
    // A session that died otherwise (an error, a runner restart) is no fault of the work
    // either; one a person stopped is their call. One its provider refused to open (a CLI too
    // old, signed out) also keeps new work off the provider, so the retry starts elsewhere.
    if (s.status === "failed") {
      const cause = providerFailure(ctx.repo, ctx.inbox, s);
      if (cause && providerWide(cause)) ctx.sessions.providerFailed(s.provider, cause);
      if (revert) return revertStartFailed(ctx, project, loop, item, revertSessionFailure(ctx, s));
      return failItem(ctx, loop, item, BUILDER_FAILED_REASON, infra);
    }
    return fail("The builder session stopped without a pull request");
  }
  // Its first step isn't reported yet, or a person asked for changes to the spec. A revert has
  // none: the agent writing it only reverts the merge.
  const revising = item.specApproval?.state === "changes_requested";
  const investigating =
    !revert &&
    (!item.investigation || revising) &&
    (item.type === "bug" || item.type === "feature");
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
    if (stoppedSinceNudge(s, asked, ctx.now(), loop.tuning)) {
      return fail(`The builder ended without reporting its ${step}`);
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
  if (stoppedSinceNudge(s, nudged, ctx.now(), loop.tuning)) {
    const why = s.result ? `${s.result.outcome}: ${s.result.summary}` : "no pull request";
    return fail(`The builder finished without a pull request (${why})`);
  }
  return loop;
}

/**
 * Watched merges in the order they landed, so each is judged after the ones before it on the
 * same tick. Merges made on one pass of the queue can share a timestamp: the later one carries
 * more `merged_after_` marks (one per merge still watched when it landed).
 */
export function inMergeOrder(items: FactoryItem[]): FactoryItem[] {
  const stacked = (i: FactoryItem) =>
    Object.keys(i.nudges).filter((k) => k.startsWith(MERGED_AFTER)).length;
  return [...items].sort(
    (a, b) => (a.mergedAt ?? "").localeCompare(b.mergedAt ?? "") || stacked(a) - stacked(b),
  );
}

/**
 * Watching (§10.1 step 6): after a merge, CI on the default branch decides. A regression opens
 * an automatic revert PR (through the same merge checks), pauses the loop, holds fast merges
 * until CI on the default branch is green again, and asks the user. Merges that stacked on an
 * unverified main (fast merges while CI still ran) are judged in order: a failure waits for the
 * verdict on the merges before it, and isn't blamed on this one when one of those was reverted.
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
  // A revert whose merge is green ends the regression: the loop resumes (`revert.ts`).
  const landed = () => {
    done(null);
    return item.source === "revert" ? revertLanded(ctx, project, loop, item) : loop;
  };
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
  if (state === "success") return landed();
  // Only a green run ends a regression: a revert waits for one, and the user hears when it doesn't come.
  if (item.source === "revert" && (state === "none" || state === "pending"))
    return awaitRevertCi(ctx, project, loop, item, state, age);
  if (state === "none")
    return age > ctx.ciGraceMs || !loop.tuning.requireCi
      ? done("No CI ran on the default branch")
      : loop;
  if (state === "pending")
    return timedOut
      ? done(`Main CI did not finish within ${loop.tuning.watchTimeoutMin} minutes`)
      : loop;
  // A merge that landed while earlier merges were still being watched is judged after them.
  const earlier = Object.keys(item.nudges)
    .filter((k) => k.startsWith(MERGED_AFTER))
    .flatMap((k) => ctx.store.item(k.slice(MERGED_AFTER.length)) ?? []);
  const branch = baseBranchOf(project);
  const open = earlier.find((i) => i.stage === "watching");
  if (open) {
    const text = `CI on ${branch} failed; waiting for the verdict on #${open.pr?.number ?? "?"}, merged before it`;
    if (item.note !== text) ctx.store.updateItem(item.id, (i) => ({ ...i, note: text }));
    return loop;
  }
  // Reverted after this one merged: its revert may have landed and sent it back to its builder.
  const culprit = earlier.find((i) => {
    const at = revertedAt(i);
    return at !== null && at >= (item.nudges[`${MERGED_AFTER}${i.id}`] ?? "");
  });
  if (culprit)
    return done(
      `CI on ${branch} failed, but #${culprit.pr?.number ?? "?"} merged before it, broke it and is being reverted, so this one is not`,
    );
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
  const branch = baseBranchOf(project);
  const at = ctx.now().toISOString();
  // Fast merges wait until CI on the default branch is green again (`fast-merge.ts`).
  const next: FactoryLoop = {
    ...loop,
    consecutiveFailures: loop.consecutiveFailures + 1,
    fastMergeHold: `CI on ${branch} failed after #${prNumber} merged`,
  };
  if (item.source === "revert") return revertStillRed(ctx, project, next, item);
  // What failed on the merge goes back to the builder with its revise round (`revert.ts`).
  const failed = await recordMainFailure(ctx, project, item);
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
  /** The revert item when no agent could start to write it, and why: it is started again. */
  let unstarted: { revert: FactoryItem; why: string } | null = null;
  if (revertPr) {
    ctx.store.createItem({ ...base, stage: "verifying", pr: revertPr, nudges: { verifying: at } });
    revertNote = `revert PR #${revertPr.number} is open`;
  } else {
    // On the builder's provider for a bug, or another available one (`revert-start.ts`). With
    // none available it waits in the queue, which starts it once one is: no failed start counts.
    const agent = revertAgent(ctx, project, loop);
    const merge = { sha, prNumber, title: item.title };
    const started =
      "waiting" in agent ? agent : await startRevertAgent(ctx, project.id, merge, agent);
    const sessionId = "sessionId" in started ? started.sessionId : null;
    const revert = ctx.store.createItem({
      ...base,
      stage: sessionId ? "building" : "backlog",
      builderSessionId: sessionId,
      builderProvider: "sessionId" in started ? started.provider : null,
      note: sessionId
        ? "An agent is writing the revert"
        : "waiting" in started
          ? started.waiting
          : null,
    });
    if ("why" in started) unstarted = { revert, why: started.why };
    revertNote = sessionId
      ? "an agent is writing the revert PR"
      : "waiting" in started
        ? "no provider is available to write the revert yet: it starts as soon as one is"
        : "the revert couldn't start yet: it starts again on the next free agent";
  }
  ctx.store.updateItem(item.id, (i) => ({
    ...i,
    stage: "reverted",
    reason: `CI on ${branch} failed after the merge${failed.length ? ` (${failed.join(", ")})` : ""}`,
    note: revertNote,
    finishedAt: at,
    nudges: { ...i.nudges, [REVERTED_AT]: at },
  }));
  raiseInbox(ctx, {
    id: regressionInboxId(item.id),
    kind: "run_failed",
    notify: "failure",
    priority: "high",
    projectId: project.id,
    issue: item.issue,
    pr: revertPr ?? item.pr,
    title: `Factory regression on ${branch}: ${item.title}`,
    body: `CI on ${branch} failed after merging #${prNumber} (${sha}); ${revertNote}. The factory loop is paused: it resumes by itself once the revert merged and CI on ${branch} is green again, and the work goes back to its builder.`,
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
  // The regression pauses the loop (and resumes it once the revert landed, `revert.ts`). A pause
  // the user must lift (a failure streak, a revert that can't merge) stays as it is; the budget's
  // gives way, so a new day doesn't lift it while the default branch is red.
  const prefix = regressionPausePrefix(branch);
  const held = loop.pausedReason ?? "";
  const keep = loop.state === "paused" && !held.startsWith(prefix) && !held.startsWith("daily");
  const reason = `${prefix}${prNumber}; ${revertNote}`;
  const paused = keep ? next : pauseLoop(ctx, next, reason, { inbox: false });
  if (!unstarted) return paused;
  return revertStartFailed(ctx, project, paused, unstarted.revert, unstarted.why);
}

/** "The builder ..." as the middle of a sentence. */
function lowerFirst(text: string): string {
  return text.charAt(0).toLowerCase() + text.slice(1);
}

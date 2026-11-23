import {
  type FactoryItem,
  type FactoryLoop,
  type Project,
  type Session,
  specHeld,
} from "@codeden/contracts";
import { errorMessage } from "../errors";
import { isTransientRunnerError, isTurnRunningError } from "../sessions/outbox-holds";
import { CI_KICK_NUDGE } from "./ci-kick";
import { letGoReviewer } from "./cleanup";
import type { FactoryContext } from "./context";
import { markStuck } from "./outcomes";
import { continuePrompt } from "./prompts-integration";
import { awaitedProvider, noteProviderWaits, type ProviderWait } from "./provider-wait";
import { backOffRefused, letGoPrAgent, prAgent } from "./rebase";
import { isRecheckObligation } from "./recheck";
import { isReReviewRecord } from "./rereview";
import { CLEAN_REVIEW } from "./review-environment";
import { isBusy, neverRanTurn } from "./sessions";
import { claimSlot } from "./slots";
import { builderOpenPr, isEarlyPrRecord } from "./spec-early-pr";
import { ownsTurnRaceFailure } from "./turn-race";

/**
 * Infrastructure failures don't strand work (§10.1). An item that failed for a reason outside
 * its code (its builder or reviewer session died, the builder is gone, CI never started while
 * Actions can run) goes back by itself on the next tick after the cause is gone: to
 * verification when its PR is open (the PR is picked up again, not redone; a PR agent that is
 * gone or never started is let go, and a fresh integrator takes the PR over when it needs one),
 * to building with a "continue" message otherwise, or to the queue for a fresh builder when the
 * old one is gone or never started (it never ran a turn, so its brief never reached the provider).
 * At most `MAX_RECOVERIES` times per item. Failures recorded before `failureKind` existed are
 * recognised by their reason.
 */

export const MAX_RECOVERIES = 3;

const RECOVERED = "infra_";

/** Reasons of infrastructure failures recorded before `failureKind` existed. */
const LEGACY_REASONS = [
  /^The builder session (failed|is gone)/,
  /No CI reported on the head commit/,
  /CI never started on /,
];

/** CI that never reported on the PR's head (the legacy reason included). */
const NO_CI = /CI never started on |No CI reported on the head commit/;

/** Whether the item failed for a reason outside its code. */
export function isInfraFailure(item: FactoryItem): boolean {
  if (item.stage !== "failed") return false;
  if (item.failureKind) return item.failureKind === "infrastructure";
  return LEGACY_REASONS.some((re) => re.test(item.reason ?? ""));
}

/** How many times the loop already put the item back after an infrastructure failure. */
export function recoveries(item: FactoryItem): number {
  let n = 0;
  while (item.nudges[`${RECOVERED}${n + 1}`]) n++;
  return n;
}

/** An infrastructure failure the loop will still put back by itself. */
export function recoverable(item: FactoryItem): boolean {
  return isInfraFailure(item) && recoveries(item) < MAX_RECOVERIES;
}

/**
 * The item's open PR: its own, or one its builder opened (found by session or branch). Not one
 * opened while its spec is held: that waits for the approval (`spec-early-pr.ts`).
 */
function openPr(ctx: FactoryContext, project: Project, item: FactoryItem, builder?: Session) {
  if (item.pr) {
    const ref = ctx.github.prRef(project.id, item.pr.number) ?? item.pr;
    return ref.state === "open" || ref.state === "draft" ? ref : null;
  }
  if (!builder || specHeld(item)) return null;
  return builderOpenPr(ctx, project.id, builder);
}

/**
 * The nudges a recovered item starts from: the earlier attempt's waits and reminders are
 * dropped (they would stop the fresh one at once), but every obligation it still owes is kept:
 * its recoveries, revise rounds and rebase requests, a conflict resolution the reviewer still
 * has to re-check (`recheck.ts`; asked again of whichever reviewer takes it), PRs still to
 * be closed, and the heads its verdicts and automatic re-reviews covered (`rereview.ts`).
 */
function freshNudges(nudges: FactoryItem["nudges"], at: string): FactoryItem["nudges"] {
  const keep = Object.entries(nudges).filter(
    ([k]) =>
      k.startsWith(RECOVERED) ||
      k.startsWith("fix_") ||
      k.startsWith("rebase_") ||
      k.startsWith("conflict_from_") ||
      isRecheckObligation(k) ||
      k.startsWith("supersede_") ||
      isEarlyPrRecord(k) ||
      isReReviewRecord(k) ||
      k === CLEAN_REVIEW,
  );
  return {
    ...Object.fromEntries(keep),
    [`${RECOVERED}${recoveries({ nudges } as FactoryItem) + 1}`]: at,
  };
}

/**
 * Put back what failed for a reason outside its code. The tick runs it twice: first with
 * `resume` off, which only moves items (back to verification or to the queue, no agent turn),
 * so the verify step sees them in the same tick; then, after reviews, fixes and rebases had
 * their turn at the free agents, with `resume` on and `only` the items that were failed when
 * the tick began, which tells their builders to carry on (`resume` in the slot order,
 * `slots.ts`). Work that fails during a tick goes back on the next one.
 */
export async function recoverInfraFailures(
  ctx: FactoryContext,
  project: Project,
  loop: FactoryLoop,
  opts: { resume: boolean; only?: ReadonlySet<string> } = { resume: true },
): Promise<FactoryLoop> {
  // A paused loop (budget, failures in a row) starts no agent turns; resuming it recovers. Reverts
  // are the exception: a regression's pause waits on them.
  const paused = loop.state === "paused";
  let next = loop;
  const providers = ctx.sessions.providers();
  const waits: ProviderWait[] = [];
  for (const item of ctx.store.items(project.id, ["failed"])) {
    if (paused && item.source !== "revert") continue;
    if (!recoverable(item) || (opts.only && !opts.only.has(item.id))) continue;
    // A builder that lost a message race to its own turn is told to carry on by `turn-race.ts`.
    if (ownsTurnRaceFailure(ctx, item)) continue;
    // A person merged or closed its PR meanwhile: ownership finishes the item instead.
    const state = item.pr ? (ctx.github.prRef(project.id, item.pr.number) ?? item.pr).state : null;
    if (state === "merged" || state === "closed") continue;
    // The cause is gone only once the runner offers the builder's provider (`provider-wait.ts`).
    const provider = awaitedProvider(ctx, item, providers);
    if (provider !== undefined) {
      waits.push({ item, provider });
      continue;
    }
    try {
      next = await recoverOne(ctx, project, next, item, opts.resume);
    } catch (error) {
      ctx.log?.(`factory: ${item.id}: recovery: ${errorMessage(error)}`);
    }
  }
  // Once per tick (the pass that only moves items): how long work waited, and the PM's notice.
  if (!opts.resume) noteProviderWaits(ctx, project, waits);
  return next;
}

async function recoverOne(
  ctx: FactoryContext,
  project: Project,
  loop: FactoryLoop,
  item: FactoryItem,
  resume: boolean,
): Promise<FactoryLoop> {
  const builder = prAgent(ctx, item);
  // The cause is gone (its provider can take work, see above), and nothing of it is busy.
  if (builder && isBusy(builder)) return loop;
  const noCi = NO_CI.test(item.reason ?? "");
  if (noCi && (await ctx.github.actionsAvailable(project.id)) === false) {
    return markStuck(
      ctx,
      loop,
      item,
      "CI can never run on this repository: GitHub Actions are turned off, or no workflow is active",
      'Turn GitHub Actions (or the workflow) on and retry the item, or turn off "Require CI" in the factory settings.',
    );
  }
  const pr = openPr(ctx, project, item, builder);
  const at = ctx.now().toISOString();
  const reviewer = item.reviewerSessionId
    ? ctx.repo.find(item.reviewerSessionId)?.session
    : undefined;
  const reviewerDead = !reviewer || reviewer.status === "failed";
  const base = {
    reason: null,
    failureKind: null,
    finishedAt: null,
    // Cleanup archived its sessions; they are needed again (a message brings them back).
    sessionsArchivedAt: null,
  } as const;
  // A PR agent (an integrator) whose start never reached its provider never got its brief: a
  // rebase or CI request would be its first and only instruction, so it counts as gone.
  const lost = builder !== undefined && neverRanTurn(ctx.repo, builder);
  if (pr) {
    // One its provider refused to open (signed out, a CLI too old) also keeps new work off that
    // provider, as a builder's refused start does (`progress.ts`), so its successor starts on
    // another provider; not when the factory learned something about the provider since that
    // refusal (it backed it off already, a person rechecked it or signed in: `backOffRefused`).
    const refused = Boolean(builder && lost && backOffRefused(ctx, builder));
    ctx.store.updateItem(item.id, (i) => {
      // A dead reviewer is let go; a fresh one takes whatever review is still owed (the
      // whole review, or only a pending re-check, with the earlier verdict kept). The dead one
      // is archived once the fresh one has started (`cleanup.ts`).
      const reviewers = reviewerDead ? letGoReviewer(i) : i;
      // A builder that is gone (or never started) is no PR agent any more: conflicts and CI
      // go to a fresh integrator, with its brief, on a provider that can take work. One that
      // never started becomes an earlier session, archived by cleanup; one that opens late
      // after all is stopped and archived as replaced (`late-start.ts`). A refused start's
      // request to rebase doesn't count (`letGoPrAgent`).
      const agent =
        builder && lost
          ? letGoPrAgent({ ...i, ...reviewers }, builder.id, refused)
          : {
              builderSessionId: builder ? i.builderSessionId : null,
              earlierSessionIds: reviewers.earlierSessionIds,
              nudges: i.nudges,
            };
      return {
        ...i,
        ...base,
        stage: "verifying",
        pr,
        builderSessionId: agent.builderSessionId,
        reviewerSessionId: reviewers.reviewerSessionId,
        earlierSessionIds: agent.earlierSessionIds,
        note: "Back in verification after a failure outside its code",
        // A fresh CI clock: the head is timed again from now. CI that never started is started
        // again by the verify step (`ci-kick.ts`).
        nudges: {
          ...freshNudges(agent.nudges, at),
          verifying: at,
          ...(noCi ? { [CI_KICK_NUDGE]: at } : {}),
        },
      };
    });
    ctx.log?.(`factory: ${item.id}: back in verification after an infrastructure failure`);
    return loop;
  }
  // A builder that never ran a turn never got its brief: a "continue" message would be its
  // first and only instruction, so it counts as gone.
  if (builder && builder.status !== "stopped" && !lost) {
    return resume ? resumeBuilder(ctx, project, loop, item, builder) : loop;
  }
  // The builder is gone (or never started): a fresh one picks the work up from the queue with
  // the current brief, on whichever provider can take it. Its reviewer is let go with it; both
  // become earlier sessions, archived once none of them is busy (`cleanup.ts`). One that opens
  // late after all is stopped and archived as replaced (`late-start.ts`).
  ctx.store.updateItem(item.id, (i) => {
    const { reviewerSessionId, earlierSessionIds } = letGoReviewer(i);
    return {
      ...i,
      ...base,
      stage: "backlog",
      builderSessionId: null,
      reviewerSessionId,
      review: null,
      checks: [],
      note: "Back in the queue after a failure outside its code: its builder is gone",
      nudges: freshNudges(i.nudges, at),
      earlierSessionIds: [...new Set([...earlierSessionIds, ...(builder ? [builder.id] : [])])],
    };
  });
  return loop;
}

/**
 * Back to building with a "continue" message to its builder. That starts an agent turn, so it
 * waits for a free agent, and the turn starts now or not at all (`startTurn` never queues past
 * the agent limit). The item is in building before the turn starts (the builder's factory tools
 * are offered to the builder of an item in building); when the turn doesn't start it goes back
 * to failed as it was, counting the attempt unless the runner was only away or busy.
 */
async function resumeBuilder(
  ctx: FactoryContext,
  project: Project,
  loop: FactoryLoop,
  item: FactoryItem,
  builder: Session,
): Promise<FactoryLoop> {
  // After the reviews, fixes and rebases waiting for an agent, before new builds (`slots.ts`).
  if (!claimSlot(ctx, project, "resume", `build:${item.id}`, { wake: builder.id })) {
    ctx.store.updateItem(item.id, (i) => ({ ...i, note: WAITING_FOR_AGENT }), { touch: false });
    return loop;
  }
  const at = ctx.now().toISOString();
  ctx.store.updateItem(item.id, (i) => ({
    ...i,
    reason: null,
    failureKind: null,
    finishedAt: null,
    sessionsArchivedAt: null,
    stage: "building",
    note: "Building again after a failure outside its code",
    nudges: freshNudges(i.nudges, at),
  }));
  try {
    await ctx.sessions.startTurn(builder.id, continuePrompt(item));
  } catch (error) {
    const passing = isTransientRunnerError(error) || isTurnRunningError(error);
    ctx.store.updateItem(item.id, (i) =>
      i.stage !== "building" || i.builderSessionId !== builder.id
        ? i
        : {
            ...item,
            note: `Could not resume its builder: ${errorMessage(error)}`,
            // A real error uses up a recovery; a runner that was away or busy doesn't.
            nudges: passing
              ? item.nudges
              : { ...item.nudges, [`${RECOVERED}${recoveries(item) + 1}`]: at },
          },
    );
    return loop;
  }
  ctx.log?.(`factory: ${item.id}: builder resumed after an infrastructure failure`);
  return loop;
}

const WAITING_FOR_AGENT =
  "Failed for a reason outside its code: its builder carries on when an agent is free";

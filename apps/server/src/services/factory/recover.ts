import type { FactoryItem, FactoryLoop, GitHubPrRef, Project, Session } from "@codeden/contracts";
import { errorMessage } from "../errors";
import { isTransientRunnerError, isTurnRunningError } from "../sessions/outbox-holds";
import { CI_KICK_NUDGE } from "./ci-kick";
import type { FactoryContext } from "./context";
import { markStuck } from "./outcomes";
import { continuePrompt } from "./prompts-integration";
import { prAgent } from "./rebase";
import { isRecheckObligation } from "./recheck";
import { isBusy } from "./sessions";
import { claimSlot } from "./slots";
import { ownsTurnRaceFailure } from "./turn-race";

/**
 * Infrastructure failures don't strand work (§10.1). An item that failed for a reason outside
 * its code (its builder or reviewer session died, the builder is gone, CI never started while
 * Actions can run) goes back by itself on the next tick after the cause is gone: to
 * verification when its PR is open (the PR is picked up again, not redone), to building with
 * a "continue" message otherwise, or to the queue for a fresh builder when the old one is gone.
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

/** The item's open PR: its own, or one its builder opened (found by session or branch). */
function openPr(ctx: FactoryContext, project: Project, item: FactoryItem, builder?: Session) {
  const open = (ref: GitHubPrRef | null | undefined) =>
    ref && (ref.state === "open" || ref.state === "draft") ? ref : null;
  if (item.pr) return open(ctx.github.prRef(project.id, item.pr.number) ?? item.pr);
  if (!builder) return null;
  return open(builder.pr ?? ctx.github.prForSession(project.id, builder.id, builder.branch));
}

/**
 * The nudges a recovered item starts from: the earlier attempt's waits and reminders are
 * dropped (they would stop the fresh one at once), but every obligation it still owes is kept:
 * its recoveries, revise rounds and rebase requests, a conflict resolution the reviewer still
 * has to re-check (`recheck.ts`; asked again of whichever reviewer takes it), and PRs still to
 * be closed.
 */
function freshNudges(nudges: FactoryItem["nudges"], at: string): FactoryItem["nudges"] {
  const keep = Object.entries(nudges).filter(
    ([k]) =>
      k.startsWith(RECOVERED) ||
      k.startsWith("fix_") ||
      k.startsWith("rebase_") ||
      k.startsWith("conflict_from_") ||
      isRecheckObligation(k) ||
      k.startsWith("supersede_"),
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
 * the tick began, which tells their builders to carry on (a build in the slot order,
 * `slots.ts`). Work that fails during a tick goes back on the next one.
 */
export async function recoverInfraFailures(
  ctx: FactoryContext,
  project: Project,
  loop: FactoryLoop,
  opts: { resume: boolean; only?: ReadonlySet<string> } = { resume: true },
): Promise<FactoryLoop> {
  // A paused loop (budget, failures in a row) starts no agent turns; resuming it recovers.
  if (loop.state === "paused") return loop;
  let next = loop;
  const providers = ctx.sessions.providers();
  for (const item of ctx.store.items(project.id, ["failed"])) {
    if (!recoverable(item) || (opts.only && !opts.only.has(item.id))) continue;
    // A builder that lost a message race to its own turn is told to carry on by `turn-race.ts`.
    if (ownsTurnRaceFailure(ctx, item)) continue;
    // A person merged or closed its PR meanwhile: ownership finishes the item instead.
    const state = item.pr ? (ctx.github.prRef(project.id, item.pr.number) ?? item.pr).state : null;
    if (state === "merged" || state === "closed") continue;
    try {
      next = await recoverOne(ctx, project, next, item, providers, opts.resume);
    } catch (error) {
      ctx.log?.(`factory: ${item.id}: recovery: ${errorMessage(error)}`);
    }
  }
  return next;
}

async function recoverOne(
  ctx: FactoryContext,
  project: Project,
  loop: FactoryLoop,
  item: FactoryItem,
  providers: string[],
  resume: boolean,
): Promise<FactoryLoop> {
  const builder = prAgent(ctx, item);
  // The cause is gone: the runner offers the builder's provider, and nothing of it is busy.
  if (providers.length === 0) return loop;
  if (builder && (isBusy(builder) || !providers.includes(builder.provider))) return loop;
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
  if (pr) {
    ctx.store.updateItem(item.id, (i) => ({
      ...i,
      ...base,
      stage: "verifying",
      pr,
      // A builder that is gone is no PR agent any more: conflicts and CI go to an integrator.
      builderSessionId: builder ? i.builderSessionId : null,
      // A dead reviewer is let go; a fresh one takes whatever review is still owed (the
      // whole review, or only a pending re-check, with the earlier verdict kept).
      reviewerSessionId: reviewerDead ? null : i.reviewerSessionId,
      note: "Back in verification after a failure outside its code",
      // A fresh CI clock: the head is timed again from now. CI that never started is started
      // again by the verify step (`ci-kick.ts`).
      nudges: {
        ...freshNudges(i.nudges, at),
        verifying: at,
        ...(noCi ? { [CI_KICK_NUDGE]: at } : {}),
      },
    }));
    ctx.log?.(`factory: ${item.id}: back in verification after an infrastructure failure`);
    return loop;
  }
  if (builder && builder.status !== "stopped") {
    return resume ? resumeBuilder(ctx, project, loop, item, builder) : loop;
  }
  // The builder is gone: a fresh one picks the work up from the queue.
  ctx.store.updateItem(item.id, (i) => ({
    ...i,
    ...base,
    stage: "backlog",
    builderSessionId: null,
    reviewerSessionId: null,
    review: null,
    checks: [],
    note: "Back in the queue after a failure outside its code: its builder is gone",
    nudges: freshNudges(i.nudges, at),
    earlierSessionIds: [...new Set([...i.earlierSessionIds, ...(builder ? [builder.id] : [])])],
  }));
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
  // A build: after the reviews, fixes and rebases waiting for an agent (`slots.ts`).
  if (!claimSlot(ctx, project, "build", `build:${item.id}`, builder.id)) {
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

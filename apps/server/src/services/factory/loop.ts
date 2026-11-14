import {
  type FactoryItem,
  type FactoryLoop,
  type FactoryLoopState,
  isFactoryMode,
  type Project,
} from "@codeden/contracts";
import { errorMessage } from "../errors";
import { earliestUntil, untilText } from "./availability";
import { archiveFinished } from "./cleanup";
import { settleClosedIssues } from "./closed-issues";
import { budgetSpend, type FactoryContext, visionOf } from "./context";
import { classifyPending, intakeFailedChecks, intakeIssues } from "./intake";
import { openPrFiles, scheduleOrder } from "./overlap";
import { advanceOwned } from "./owned";
import { budgetExceeded, localDay, mayBuild, queueOrder } from "./policy";
import { advanceBuilding, advanceWatching } from "./progress";
import { advanceQueue } from "./queue";
import { closeReplacedPrs } from "./rebuild";
import { recoverInfraFailures } from "./recover";
import { advanceScout } from "./scout";
import { claimSlot } from "./slots";
import { OWNED_STAGES } from "./store";
import { mayAutoMerge } from "./trust";
import { recoverTurnRaceFailures } from "./turn-race";
import { advanceVerifying } from "./verify";
import { finishesOpenWork, unopenedBuilds, wipOf, wipText } from "./wip";

export { FACTORY_LABEL } from "./intake";

/** What a tick needs besides the context: the daily digest hook. */
export interface TickHooks {
  /** Write the digest for `day` (called once when the day rolls over). */
  digest(project: Project, loop: FactoryLoop, day: string): Promise<unknown>;
}

/**
 * One step of a project's factory loop (§10.1). The server drives the state machine and
 * enforces the limits; agents only do the judgement. Safe to call at any time and after a
 * restart: every step reads the persisted state and moves it forward.
 *
 * Order: work in flight moves first (watch, build, verify), finished work's sessions are
 * archived, then intake (new issues, failed checks on main), Identify type, the free agents
 * take the queue, and last the dark factory's scout gets whatever agents are still free. Who
 * gets a free agent is decided by `slots.ts` (reviews, then fixes and rebases, then builds,
 * then the scout), whatever the order the steps run in.
 */
export async function runTick(
  ctx: FactoryContext,
  projectId: string,
  hooks: TickHooks,
): Promise<FactoryLoop> {
  const project = ctx.projects.get(projectId);
  const now = ctx.now();
  let loop = ctx.store.loopOrNew(projectId, now);
  const killed = project.killSwitch || ctx.settings.get().factory.killSwitch;
  if (!isFactoryMode(project.autonomyMode) || project.archivedAt) {
    if (loop.state !== "idle" && loop.state !== "stopped") loop = { ...loop, state: "idle" };
    return save(ctx, loop, now);
  }
  if (killed) return save(ctx, { ...loop, state: "stopped" }, now);
  if (loop.state === "stopped") loop = { ...loop, state: "idle" };

  // Day rollover: digest for the day that ended, fresh counters; a budget pause ends.
  const today = localDay(now);
  if (loop.day !== today) {
    if (loop.lastDigestDay !== loop.day) {
      await hooks.digest(project, loop, loop.day);
      loop = { ...loop, lastDigestDay: loop.day };
    }
    loop = { ...loop, day: today, mergesToday: 0 };
    if (loop.state === "paused" && loop.pausedReason?.startsWith("daily")) {
      loop = { ...loop, state: "idle", pausedReason: null };
    }
  }

  // Who is installed and signed in: detected again in the background every few minutes.
  ctx.sessions.refreshAvailability();
  // Work that waited for an agent on the last tick gets the free slots first (`slots.ts`).
  ctx.slots.beginTick(projectId);
  // Failed items whose issue was closed on GitHub have nothing left to decide: they settle
  // first, so none of them is put back or waits on a person.
  settleClosedIssues(ctx, project);
  // Items that failed for a reason outside their code go back by themselves (builders that
  // must carry on wait until after the reviews, fixes and rebases, below).
  const failedAtStart = new Set(ctx.store.items(projectId, ["failed"]).map((i) => i.id));
  loop = await recoverInfraFailures(ctx, project, loop, { resume: false });
  // Items already in flight move on even while paused (merges stay blocked, reverts excepted).
  // Watch merges first, then builds, then verification, so a PR found while building is
  // verified in the same step and a fresh merge is watched from the next one. Then the merge
  // queue takes one step (at most one merge per tick), and the PRs of failed and escalated
  // items, which wait for a person, are kept free of conflicts.
  for (const stage of ["watching", "building", "verifying", ...OWNED_STAGES] as const) {
    for (const item of ctx.store.items(projectId, [stage])) {
      loop = await step(ctx, item, loop, () => {
        if (stage === "building") return advanceBuilding(ctx, project, loop, item);
        if (stage === "verifying") return advanceVerifying(ctx, project, loop, item);
        if (stage === "watching") return advanceWatching(ctx, project, loop, item);
        return advanceOwned(ctx, project, loop, item);
      });
    }
    if (stage === "verifying") loop = await advanceQueue(ctx, project, loop);
  }
  // PRs a rebuild or an integrator replaced are closed, whatever their item's stage by now.
  await closeReplacedPrs(ctx, project).catch((error: unknown) =>
    ctx.log?.(`factory: closing replaced PRs: ${errorMessage(error)}`),
  );
  // Finished work gives back its sessions and worktrees, also while paused.
  archiveFinished(ctx, projectId);

  if (loop.state !== "paused") {
    const spend = budgetSpend(ctx, projectId, today, project.factoryLimits);
    const over = budgetExceeded(spend, project.factoryLimits);
    if (over) loop = { ...loop, state: "paused", pausedReason: over };
  }
  if (loop.state === "paused") return save(ctx, loop, now);

  loop = await intakeIssues(ctx, project, loop);
  loop = await intakeFailedChecks(ctx, project, loop);
  await classifyPending(ctx, project);
  // Builders of work that failed for a reason outside its code, or whose builder was marked
  // failed by a message racing its turn, carry on: ahead of new work for the free agents.
  loop = await recoverInfraFailures(ctx, project, loop, { resume: true, only: failedAtStart });
  await recoverTurnRaceFailures(ctx, project, loop);
  await assignAgents(ctx, project, loop);
  if (project.autonomyMode === "dark_factory") loop = await advanceScout(ctx, project, loop);
  return save(ctx, { ...loop, state: deriveState(ctx, projectId, loop) }, now);
}

/** One item's step: an error is noted on the item and never stops the tick. */
async function step(
  ctx: FactoryContext,
  item: FactoryItem,
  loop: FactoryLoop,
  run: () => Promise<FactoryLoop>,
): Promise<FactoryLoop> {
  try {
    return await run();
  } catch (error) {
    ctx.log?.(`factory: ${item.id}: ${errorMessage(error)}`);
    ctx.store.updateItem(item.id, (i) => ({ ...i, note: `Loop error: ${errorMessage(error)}` }));
    return loop;
  }
}

/** Ticks that change nothing append nothing (the status shows the tick time from memory). */
function save(ctx: FactoryContext, loop: FactoryLoop, now: Date): FactoryLoop {
  return ctx.store.saveTick(loop, now.toISOString());
}

/** The loop state the panel shows: the most advanced stage with work in it. */
function deriveState(ctx: FactoryContext, projectId: string, loop: FactoryLoop): FactoryLoopState {
  const active = ctx.store.items(projectId, ["building", "verifying", "watching"]);
  if (active.some((i) => i.stage === "verifying" || i.stage === "watching")) return "verifying";
  if (active.some((i) => i.stage === "building")) return "building";
  if (loop.scout.round) return "discovering";
  return "idle";
}

/** Notes the scheduler writes on queued items (replaced or cleared as things change). */
const HOLD_NOTE = /^(Waiting: finishing open work|Deferred: likely overlaps)/;

/** Say why a queued item waits (`note`), or clear such a note once it no longer holds (null). */
function scheduleNote(ctx: FactoryContext, itemId: string, note: string | null): void {
  ctx.store.updateItem(
    itemId,
    (i) => {
      if (note) return { ...i, note };
      return i.note && HOLD_NOTE.test(i.note) ? { ...i, note: null } : i;
    },
    { touch: false },
  );
}

/** While auto-merge is on: merges today plus work in flight stay under the daily merge cap. */
function underMergeCap(
  ctx: FactoryContext,
  project: Project,
  loop: FactoryLoop,
  item: FactoryItem,
) {
  if (!mayAutoMerge(item, project.factoryLimits)) return true;
  const inFlight = ctx.store
    .items(project.id, ["building", "verifying"])
    .filter((i) => mayAutoMerge(i, project.factoryLimits)).length;
  return mayBuild(loop.mergesToday, inFlight, project.factoryLimits);
}

/**
 * The orchestrator of the swarm: give queued items to free agents, within the agent limit (new
 * builds come after reviews, fixes and rebases, `slots.ts`), the work-in-progress limit
 * (`wip.ts`) and, while auto-merge is on, the daily merge cap. Items that clearly overlap an open
 * PR wait behind those that don't (`overlap.ts`). An item whose issue was closed meanwhile stops.
 * Every build that will open a PR takes room under the work-in-progress limit, those started
 * earlier and those this tick starts, so the limit is never overshot.
 */
async function assignAgents(ctx: FactoryContext, project: Project, loop: FactoryLoop) {
  const wip = wipOf(ctx, project, loop);
  let building = unopenedBuilds(ctx, project.id);
  const queue = scheduleOrder(
    ctx.store.items(project.id, ["backlog"]).sort(queueOrder),
    openPrFiles(ctx, project),
  );
  const vision = visionOf(project).text;
  let full = false;
  for (const { item, overlap } of queue) {
    if (item.issue && ctx.github.issue(project.id, item.issue.number)?.state === "closed") {
      ctx.store.updateItem(item.id, (i) => ({
        ...i,
        stage: "rejected",
        reason: "The issue was closed on GitHub",
        finishedAt: ctx.now().toISOString(),
      }));
      continue;
    }
    const takesRoom = !finishesOpenWork(ctx, item);
    if (takesRoom && wip.openPrs + building >= wip.limit) {
      scheduleNote(ctx, item.id, `Waiting: ${wipText(wip, building).replace(/^F/, "f")}`);
      continue;
    }
    if (!full && underMergeCap(ctx, project, loop, item)) {
      if (claimSlot(ctx, project, "build", `build:${item.id}`, { ordered: true })) {
        const started = await startBuilder(ctx, project, item, vision, loop);
        if (started && takesRoom) building++;
        continue;
      }
      full = true;
    }
    const deferred =
      overlap && `Deferred: likely overlaps open PR #${overlap.pr} (${overlap.path})`;
    scheduleNote(ctx, item.id, deferred || null);
  }
}

/**
 * The builder's provider and model (§10.1, Provider availability): `builderProvider` and
 * `builderModel` when that provider is available; otherwise another available provider (the
 * project's, then the agent default, then any), with its default model. `auto` stays `auto`
 * while every provider is available. Nothing available: the build waits.
 */
function chooseBuilder(
  ctx: FactoryContext,
  project: Project,
  loop: FactoryLoop,
): { provider: string; model: string | null } | { waiting: string } {
  const wanted = loop.tuning.builderProvider;
  const available = ctx.sessions.providers();
  const blocked = ctx.sessions.unavailable();
  if (blocked.length === 0) {
    return { provider: wanted, model: wanted === "auto" ? null : loop.tuning.builderModel };
  }
  if (available.length === 0) {
    return { waiting: `Waiting: no build provider available${untilText(earliestUntil(blocked))}` };
  }
  if (wanted !== "auto" && available.includes(wanted)) {
    return { provider: wanted, model: loop.tuning.builderModel };
  }
  const roleDefault = ctx.settings.get().providers.agent.provider;
  const order = [wanted, project.defaultProvider, roleDefault, ...available];
  const provider = order.find((p): p is string => Boolean(p) && available.includes(p as string));
  return { provider: provider ?? (available[0] as string), model: null };
}

/** Start a builder for a queued item; true when the item is building. */
async function startBuilder(
  ctx: FactoryContext,
  project: Project,
  item: FactoryItem,
  vision: string,
  loop: FactoryLoop,
): Promise<boolean> {
  const choice = chooseBuilder(ctx, project, loop);
  if ("waiting" in choice) {
    ctx.store.updateItem(item.id, (i) => ({ ...i, note: choice.waiting }));
    return false;
  }
  const { provider, model } = choice;
  try {
    const res = await ctx.sessions.startBuilder(item, vision, provider, model);
    if (res.status === "conflict") {
      const other = res.existing.map((w) => w.workKey).join(", ");
      ctx.store.updateItem(item.id, (i) => ({
        ...i,
        note: `Waiting: overlaps running work (${other})`,
      }));
      return false;
    }
    if (res.status !== "started" && res.status !== "queued") return false;
    const session = ctx.repo.find(res.sessionId)?.session;
    ctx.store.updateItem(item.id, (i) => ({
      ...i,
      stage: "building",
      builderSessionId: res.sessionId,
      builderProvider: session?.provider ?? (provider === "auto" ? null : provider),
      note: null,
    }));
    return true;
  } catch (error) {
    ctx.store.updateItem(item.id, (i) => ({
      ...i,
      note: `Build not started: ${errorMessage(error)}`,
    }));
    return false;
  }
}

import {
  type FactoryItem,
  type FactoryLoop,
  type FactoryLoopState,
  isFactoryMode,
  type Project,
} from "@codeden/contracts";
import { errorMessage } from "../errors";
import { archiveFinished } from "./cleanup";
import { budgetSpend, type FactoryContext, visionOf } from "./context";
import { classifyPending, intakeFailedChecks, intakeIssues } from "./intake";
import { advanceEscalated } from "./merge";
import { budgetExceeded, freeSlots, localDay, mayBuild, queueOrder } from "./policy";
import { advanceBuilding, advanceWatching } from "./progress";
import { recoverNoCiFailures } from "./rebase";
import { advanceScout } from "./scout";
import { mayAutoMerge } from "./trust";
import { advanceVerifying } from "./verify";

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
 * take the queue, and last the dark factory's scout gets whatever agents are still free.
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

  // Items that failed only because their conflicting PR got no CI go back to verification.
  recoverNoCiFailures(ctx, projectId);
  // Items already in flight move on even while paused (merges stay blocked, reverts excepted).
  // Watch merges first, then builds, then verification, so a PR found while building is
  // verified in the same step and a fresh merge is watched from the next one.
  for (const stage of ["watching", "building", "verifying"] as const) {
    for (const item of ctx.store.items(projectId, [stage])) {
      try {
        if (stage === "building") loop = await advanceBuilding(ctx, project, loop, item);
        else if (stage === "verifying") loop = await advanceVerifying(ctx, project, loop, item);
        else loop = await advanceWatching(ctx, project, loop, item);
      } catch (error) {
        ctx.log?.(`factory: ${item.id}: ${errorMessage(error)}`);
        ctx.store.updateItem(item.id, (i) => ({
          ...i,
          note: `Loop error: ${errorMessage(error)}`,
        }));
      }
    }
  }
  for (const item of ctx.store.items(projectId, ["escalated"]))
    advanceEscalated(ctx, project, item);
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
  await assignAgents(ctx, project, loop);
  if (project.autonomyMode === "dark_factory") loop = await advanceScout(ctx, project, loop);
  return save(ctx, { ...loop, state: deriveState(ctx, projectId, loop) }, now);
}

function save(ctx: FactoryContext, loop: FactoryLoop, now: Date): FactoryLoop {
  return ctx.store.saveLoop({ ...loop, lastTickAt: now.toISOString() });
}

/** The loop state the panel shows: the most advanced stage with work in it. */
function deriveState(ctx: FactoryContext, projectId: string, loop: FactoryLoop): FactoryLoopState {
  const active = ctx.store.items(projectId, ["building", "verifying", "watching"]);
  if (active.some((i) => i.stage === "verifying" || i.stage === "watching")) return "verifying";
  if (active.some((i) => i.stage === "building")) return "building";
  if (loop.scout.round) return "discovering";
  return "idle";
}

/**
 * The orchestrator of the swarm: give queued items to free agents, within the agent limit and,
 * while auto-merge is on, the daily merge cap. An item whose issue was closed meanwhile stops.
 */
async function assignAgents(ctx: FactoryContext, project: Project, loop: FactoryLoop) {
  const queue = ctx.store.items(project.id, ["backlog"]).sort(queueOrder);
  const vision = visionOf(project).text;
  for (const item of queue) {
    if (freeSlots(ctx.sessions.activeCount(project.id), project.factoryLimits) === 0) break;
    if (item.issue && ctx.github.issue(project.id, item.issue.number)?.state === "closed") {
      ctx.store.updateItem(item.id, (i) => ({
        ...i,
        stage: "rejected",
        reason: "The issue was closed on GitHub",
        finishedAt: ctx.now().toISOString(),
      }));
      continue;
    }
    if (mayAutoMerge(item, project.factoryLimits)) {
      const inFlight = ctx.store
        .items(project.id, ["building", "verifying"])
        .filter((i) => mayAutoMerge(i, project.factoryLimits)).length;
      if (!mayBuild(loop.mergesToday, inFlight, project.factoryLimits)) continue;
    }
    await startBuilder(ctx, item, vision, loop);
  }
}

async function startBuilder(
  ctx: FactoryContext,
  item: FactoryItem,
  vision: string,
  loop: FactoryLoop,
): Promise<void> {
  const provider = loop.tuning.builderProvider;
  try {
    const res = await ctx.sessions.startBuilder(item, vision, provider);
    if (res.status === "conflict") {
      const other = res.existing.map((w) => w.workKey).join(", ");
      ctx.store.updateItem(item.id, (i) => ({
        ...i,
        note: `Waiting: overlaps running work (${other})`,
      }));
      return;
    }
    if (res.status !== "started" && res.status !== "queued") return;
    const session = ctx.repo.find(res.sessionId)?.session;
    ctx.store.updateItem(item.id, (i) => ({
      ...i,
      stage: "building",
      builderSessionId: res.sessionId,
      builderProvider: session?.provider ?? (provider === "auto" ? null : provider),
      note: null,
    }));
  } catch (error) {
    ctx.store.updateItem(item.id, (i) => ({
      ...i,
      note: `Build not started: ${errorMessage(error)}`,
    }));
  }
}

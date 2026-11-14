import { randomUUID } from "node:crypto";
import {
  type FactoryLoop,
  type FactoryWip,
  type Project,
  SCOUT_UNAVAILABLE,
  type ScoutRound,
  type ScoutState,
  type ScoutStatus,
  type Session,
} from "@codeden/contracts";
import { conflict, errorMessage } from "../errors";
import { budgetSpend, type FactoryContext, visionOf } from "./context";
import { budgetExceeded, freeSlots, localDay } from "./policy";
import {
  LENS_NUDGE,
  SCOUT_PLAN_NUDGE,
  scoutFilePrompt,
  scoutPlanPrompt,
  scoutSelfReviewPrompt,
} from "./prompts-scout";
import { isBusy } from "./sessions";
import { busySlots, claimSlot } from "./slots";
import { ACTIVE_STAGES, WAITING_STAGES } from "./store";
import { wipOf, wipText } from "./wip";

/**
 * The dark factory's scout (§10.1). When the queue runs low (fewer than `minBacklog` items
 * waiting) and `discoveryIntervalMin` has passed, one round runs:
 *
 * 1. planning: the scout (one long-lived session per project) looks at the app and asks for at
 *    most `discoveryPerRound` review areas with `factory_plan_round`;
 * 2. reviewing: each area reviewer (a "lens" in the code: one long-lived session per area,
 *    reused round after round) reviews its area and reports findings with
 *    `factory_report_findings`;
 * 3. filing: the scout files at most `maxIssuesPerRound` issues with `factory_file_issue`,
 *    which enter the pipelines like any trusted issue.
 *
 * The scout and its lenses hold agent slots like builders, and everything else comes first
 * (`slots.ts`): a round only starts with a free slot no review, fix, rebase or build is waiting
 * for, and lenses only get the slots that are left. At the work-in-progress limit (`wip.ts`) no
 * round starts, and a running round's filing waits until a PR merges.
 *
 * `minBacklog` 0 turns scheduled rounds off. "Run scout now" (`runScoutNow`) starts a round on
 * demand, skipping the interval and the backlog threshold but nothing else.
 */

/** The scout's claim on an agent slot (`slots.ts`): its rounds and their area reviewers. */
export const SCOUT_SLOT = "scout";

/** Why the scout does nothing while the factory drains (`drain.ts`). */
export const DRAINING_TEXT =
  "The factory is draining: it finishes the work in flight, then stops, and takes on nothing new.";

/** A round that runs longer than this is closed (a stuck scout or lens). */
export const ROUND_TIMEOUT_MS = 3 * 3_600_000;

/** Whether the session's turn ended after `since` (it was sent work then). */
function turnEnded(s: Session, since: string): boolean {
  return !isBusy(s) && Date.parse(s.updatedAt) > Date.parse(since);
}

/** Titles of work open or done recently, so the scout and lenses don't repeat it. */
export function knownTitles(ctx: FactoryContext, projectId: string): string[] {
  const open = ctx.store.items(projectId, [...WAITING_STAGES, ...ACTIVE_STAGES, "escalated"]);
  const done = ctx.store.items(projectId, ["merged", "rejected", "failed"]).slice(0, 20);
  return [...open, ...done].map((i) => i.title).slice(0, 60);
}

/** Whether a new round is due (never with `minBacklog` 0: scheduled rounds are off). */
export function scoutDue(loop: FactoryLoop, waiting: number, now: number): boolean {
  if (loop.scout.round) return false;
  if (waiting >= loop.tuning.minBacklog) return false;
  if (!loop.scout.lastRoundAt) return true;
  return now - Date.parse(loop.scout.lastRoundAt) >= loop.tuning.discoveryIntervalMin * 60_000;
}

/** One scout step per tick: start a round when due, or move the running one on. */
export async function advanceScout(
  ctx: FactoryContext,
  project: Project,
  loop: FactoryLoop,
): Promise<FactoryLoop> {
  const now = ctx.now();
  if (loop.scout.round) return { ...loop, scout: await advanceRound(ctx, project, loop, now) };
  const waiting = ctx.store.items(project.id, WAITING_STAGES).length;
  if (!scoutDue(loop, waiting, now.getTime())) return loop;
  // At the work-in-progress limit the factory finishes open work before it finds more.
  if (wipOf(ctx, project, loop).holding) return loop;
  // The scout comes last for a free agent: after reviews, fixes, rebases and builds.
  const reuse = ctx.sessions.reusable(loop.scout.sessionId);
  if (!claimSlot(ctx, project, "scout", SCOUT_SLOT, { wake: reuse?.id })) return loop;
  try {
    return { ...loop, scout: await startRound(ctx, project, loop, now) };
  } catch (error) {
    ctx.log?.(`factory: scout round: ${errorMessage(error)}`);
    return loop;
  }
}

/** What decides whether "Run scout now" may start a round, besides the project and loop. */
export interface ScoutNowFacts {
  globalKillSwitch: boolean;
  /** Factory sessions in a turn (they hold agent slots). */
  activeSessions: number;
  /** Why today's budget is spent (`budgetExceeded`), or null. */
  overBudget: string | null;
  /** Reviews, fixes, rebases and builds waiting for an agent: they get free ones first. */
  waitingForAgent?: number;
  /** The work-in-progress limit (`wip.ts`); a round waits while it holds. */
  wip?: FactoryWip | null;
}

/**
 * Why "Run scout now" can't start a round right now, in plain words, or null when it can. A
 * manual round skips the interval and the backlog threshold, never the kill switch, a pause, the
 * budget, a running round, the work-in-progress limit or the agent limit.
 */
export function scoutNowBlocker(
  project: Pick<Project, "autonomyMode" | "archivedAt" | "killSwitch" | "factoryLimits">,
  loop: Pick<FactoryLoop, "state" | "pausedReason" | "scout"> & Partial<Pick<FactoryLoop, "drain">>,
  facts: ScoutNowFacts,
): string | null {
  if (project.autonomyMode !== "dark_factory") return "Only a dark factory has a scout.";
  if (project.archivedAt) return "The project is archived.";
  if (facts.globalKillSwitch) return "The global kill switch is on.";
  if (project.killSwitch) return "The kill switch is on.";
  if (loop.drain) return DRAINING_TEXT;
  if (loop.state === "paused")
    return `The loop is paused${loop.pausedReason ? `: ${loop.pausedReason}` : ""}.`;
  if (facts.overBudget)
    return `${facts.overBudget.charAt(0).toUpperCase()}${facts.overBudget.slice(1)}.`;
  if (loop.scout.round) return "A scout round is already running.";
  if (facts.wip?.holding) {
    return `${wipText(facts.wip)}: the scout finds new work once open pull requests merge.`;
  }
  const free = freeSlots(facts.activeSessions, project.factoryLimits);
  if (free === 0) {
    const max = project.factoryLimits.maxConcurrentSessions;
    return `No free agent: all ${max} ${max === 1 ? "is" : "are"} working (Agents at once).`;
  }
  if (free <= (facts.waitingForAgent ?? 0)) {
    return "No free agent: reviews, fixes and builds waiting for one come first.";
  }
  return null;
}

/** The facts `scoutNowBlocker` needs, read now. */
export function scoutNowFacts(
  ctx: FactoryContext,
  project: Project,
  loop: FactoryLoop,
  spend = budgetSpend(ctx, project.id, localDay(ctx.now()), project.factoryLimits),
): ScoutNowFacts {
  return {
    globalKillSwitch: ctx.settings.get().factory.killSwitch,
    activeSessions: busySlots(ctx, project.id),
    overBudget: budgetExceeded(spend, project.factoryLimits),
    waitingForAgent: ctx.slots.ahead(project.id, "scout", SCOUT_SLOT),
    wip: wipOf(ctx, project, loop),
  };
}

/**
 * "Run scout now": start a round right away, skipping the interval and the backlog threshold.
 * Throws `scout_unavailable` (409) with the reason when no round can start.
 */
export async function runScoutNow(
  ctx: FactoryContext,
  project: Project,
  loop: FactoryLoop,
): Promise<FactoryLoop> {
  const blocked = scoutNowBlocker(project, loop, scoutNowFacts(ctx, project, loop));
  if (blocked) throw conflict(blocked, SCOUT_UNAVAILABLE);
  const scout = await startRound(ctx, project, loop, ctx.now());
  if (!scout.round) throw conflict("The scout's session couldn't start.", SCOUT_UNAVAILABLE);
  // As the next tick derives it: a round with nothing further along is "discovering".
  return { ...loop, scout, state: loop.state === "idle" ? "discovering" : loop.state };
}

async function startRound(
  ctx: FactoryContext,
  project: Project,
  loop: FactoryLoop,
  now: Date,
): Promise<ScoutState> {
  const scout = loop.scout;
  const reuse = ctx.sessions.reusable(scout.sessionId);
  const text = scoutPlanPrompt({
    round: scout.rounds + 1,
    vision: visionOf(project).text,
    defaultBranch: defaultBranch(project),
    areas: loop.tuning.areas,
    maxLenses: loop.tuning.discoveryPerRound,
    maxIssues: loop.tuning.maxIssuesPerRound,
    known: knownTitles(ctx, project.id),
    firstRound: !reuse,
  });
  let sessionId: string;
  if (reuse) {
    await ctx.sessions.message(reuse.id, text);
    sessionId = reuse.id;
  } else {
    const res = await ctx.sessions.startScout(project.id, text);
    if (res.status !== "started" && res.status !== "queued") return scout;
    sessionId = res.sessionId;
  }
  const at = now.toISOString();
  return {
    ...scout,
    sessionId,
    rounds: scout.rounds + 1,
    round: {
      id: randomUUID(),
      phase: "planning",
      startedAt: at,
      sentAt: at,
      nudgedAt: null,
      lenses: [],
      findings: [],
      filed: 0,
      heldSince: null,
      heldMs: 0,
    },
  };
}

function endRound(scout: ScoutState, now: Date): ScoutState {
  return { ...scout, round: null, lastRoundAt: now.toISOString() };
}

async function advanceRound(
  ctx: FactoryContext,
  project: Project,
  loop: FactoryLoop,
  now: Date,
): Promise<ScoutState> {
  const scout = loop.scout;
  const round = scout.round;
  if (!round) return scout;
  // Every area reviewer reported (or the scout reviews by itself), but the work-in-progress
  // limit holds: filing waits, with the findings kept, until a PR merges. Nothing runs
  // meanwhile, so the held time doesn't count against the round's timeout.
  const holding = () => wipOf(ctx, project, loop).holding;
  if (round.phase === "reviewing" && round.lenses.every((l) => l.reported) && holding()) {
    return { ...scout, round: holdRound(round, now) };
  }
  if (roundRunMs(round, now) > ROUND_TIMEOUT_MS) return endRound(scout, now);
  const s = scout.sessionId ? ctx.repo.find(scout.sessionId)?.session : undefined;
  if (!s || s.status === "failed") return endRound(scout, now);
  const at = now.toISOString();

  if (round.phase === "planning" || round.phase === "filing") {
    if (!turnEnded(s, round.sentAt)) return scout;
    // Filing done, or the scout filed by itself without planning lenses.
    if (round.phase === "filing" || round.filed > 0) return endRound(scout, now);
    if (round.nudgedAt) return endRound(scout, now);
    await ctx.sessions.message(s.id, SCOUT_PLAN_NUDGE);
    return { ...scout, round: { ...round, nudgedAt: at, sentAt: at } };
  }

  // Reviewing: wait for every lens; remind one that ends its turn without reporting, once.
  const lenses = [];
  for (const lens of round.lenses) {
    if (lens.reported) {
      lenses.push(lens);
      continue;
    }
    const ls = ctx.repo.find(lens.sessionId)?.session;
    if (!ls || ls.status === "failed" || ls.status === "stopped") {
      lenses.push({ ...lens, reported: true });
    } else if (!turnEnded(ls, lens.sentAt)) {
      lenses.push(lens);
    } else if (!lens.nudgedAt) {
      await ctx.sessions.message(ls.id, LENS_NUDGE);
      lenses.push({ ...lens, nudgedAt: at, sentAt: at });
    } else {
      lenses.push({ ...lens, reported: true });
    }
  }
  if (lenses.some((l) => !l.reported)) return { ...scout, round: { ...round, lenses } };
  // Filing is the scout's next turn: it waits at the work-in-progress limit, and for a free
  // agent after everything else waiting for one (`slots.ts`), held either way.
  if (holding() || !claimSlot(ctx, project, "scout", SCOUT_SLOT, { wake: s.id })) {
    return { ...scout, round: holdRound({ ...round, lenses }, now) };
  }
  const maxIssues = Math.max(0, loop.tuning.maxIssuesPerRound - round.filed);
  const known = knownTitles(ctx, project.id);
  // A round planned without area reviewers while the limit held: the scout reviews by itself now.
  await ctx.sessions.message(
    s.id,
    lenses.length === 0
      ? scoutSelfReviewPrompt({ maxIssues, known })
      : scoutFilePrompt({ findings: round.findings, maxIssues, known }),
  );
  const released = releaseRound({ ...round, lenses }, now);
  return { ...scout, round: { ...released, phase: "filing", sentAt: at } };
}

/** Time the round has been running, not counting the time it was held waiting to file. */
export function roundRunMs(round: ScoutRound, now: Date): number {
  const held = round.heldSince ? now.getTime() - Date.parse(round.heldSince) : 0;
  return now.getTime() - Date.parse(round.startedAt) - round.heldMs - held;
}

/** The round waits to file, at the WIP limit or for an agent (from now, unless it already was). */
function holdRound(round: ScoutRound, now: Date): ScoutRound {
  return round.heldSince ? round : { ...round, heldSince: now.toISOString() };
}

/** The hold is over: its time is added to the round's held time. */
function releaseRound(round: ScoutRound, now: Date): ScoutRound {
  if (!round.heldSince) return round;
  const held = Math.max(0, now.getTime() - Date.parse(round.heldSince));
  return { ...round, heldSince: null, heldMs: round.heldMs + held };
}

export function defaultBranch(project: Project): string {
  return project.kind === "github"
    ? project.github.defaultBranch
    : (project.defaultBranch ?? "main");
}

/** The scout as the dashboard shows it (`spend`: today's, against the budget). */
export function scoutStatus(
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
    findings: round?.findings.length ?? 0,
    filed: round?.filed ?? 0,
    lastRoundAt: scout.lastRoundAt,
    nextRoundAt:
      round || !scout.lastRoundAt || tuning.minBacklog === 0
        ? null
        : new Date(
            Date.parse(scout.lastRoundAt) + tuning.discoveryIntervalMin * 60_000,
          ).toISOString(),
    rounds: scout.rounds,
    runNowBlockedBy: scoutNowBlocker(project, loop, scoutNowFacts(ctx, project, loop, spend)),
  };
}

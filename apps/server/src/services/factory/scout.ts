import { randomUUID } from "node:crypto";
import type { FactoryLoop, Project, ScoutState, ScoutStatus, Session } from "@codeden/contracts";
import { errorMessage } from "../errors";
import { type FactoryContext, visionOf } from "./context";
import { freeSlots } from "./policy";
import { LENS_NUDGE, SCOUT_PLAN_NUDGE, scoutFilePrompt, scoutPlanPrompt } from "./prompts-scout";
import { isBusy } from "./sessions";
import { ACTIVE_STAGES, WAITING_STAGES } from "./store";

/**
 * The dark factory's scout (§10.1). When the queue runs low (fewer than `minBacklog` items
 * waiting) and `discoveryIntervalMin` has passed, one round runs:
 *
 * 1. planning: the scout (one long-lived session per project) looks at the app and asks for at
 *    most `discoveryPerRound` lenses with `factory_plan_round`;
 * 2. reviewing: each lens (one long-lived session per area, reused round after round) reviews
 *    its area and reports findings with `factory_report_findings`;
 * 3. filing: the scout files at most `maxIssuesPerRound` issues with `factory_file_issue`,
 *    which enter the pipelines like any trusted issue.
 *
 * The scout and its lenses hold agent slots like builders, and builders come first: a round
 * only starts with a free slot, and lenses only get the slots that are free.
 */

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

/** Whether a new round is due. */
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
  if (freeSlots(ctx.sessions.activeCount(project.id), project.factoryLimits) === 0) return loop;
  try {
    return { ...loop, scout: await startRound(ctx, project, loop, now) };
  } catch (error) {
    ctx.log?.(`factory: scout round: ${errorMessage(error)}`);
    return loop;
  }
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
  if (now.getTime() - Date.parse(round.startedAt) > ROUND_TIMEOUT_MS) return endRound(scout, now);
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
  await ctx.sessions.message(
    s.id,
    scoutFilePrompt({
      findings: round.findings,
      maxIssues: Math.max(0, loop.tuning.maxIssuesPerRound - round.filed),
      known: knownTitles(ctx, project.id),
    }),
  );
  return { ...scout, round: { ...round, lenses, phase: "filing", sentAt: at } };
}

export function defaultBranch(project: Project): string {
  return project.kind === "github"
    ? project.github.defaultBranch
    : (project.defaultBranch ?? "main");
}

/** The scout as the dashboard shows it. */
export function scoutStatus(ctx: FactoryContext, loop: FactoryLoop): ScoutStatus {
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
      round || !scout.lastRoundAt
        ? null
        : new Date(
            Date.parse(scout.lastRoundAt) + tuning.discoveryIntervalMin * 60_000,
          ).toISOString(),
    rounds: scout.rounds,
  };
}

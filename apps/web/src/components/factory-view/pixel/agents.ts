import type { DiscoveryArea, FactoryStatus, ScoutStatus } from "@codeden/contracts";
import { AREA_LABEL } from "@/components/factory/meta";
import type { SessionInfo, ViewCard, ViewPipeline } from "../stages";

/**
 * Pixel mode's agents (#264): who works on the factory floor right now, in which role, on which
 * step and in which state. One agent per live work item (its builder, reviewer, or the agent
 * rebasing its pull request), plus the PM and, in a dark factory, the scout and its area
 * reviewers. Pure, so the mapping is unit-tested; the floor plan seats them and `draw*.ts`
 * paints them.
 */

export type AgentRole = "builder" | "reviewer" | "rebaser" | "integrator" | "scout" | "area" | "pm";

/** The step of an agent that works on an item. */
export type AgentStep =
  | "reproducing"
  | "analyzing"
  | "implementing"
  | "revising"
  | "reviewing"
  | "rebasing"
  | "merging"
  | "watching_ci";

/**
 * - `working`: its session runs and reported progress during this step;
 * - `thinking`: its session is starting, or runs without a progress line yet in this step;
 * - `approval`: its agent waits on a person (a question or an approval);
 * - `blocked`: the item waits on CI, conflicts, a free agent, its turn or a person, or the
 *   session failed or was cut off;
 * - `done`: merged;
 * - `idle`: the PM between messages, the scout between rounds.
 */
export type AgentStatus = "working" | "thinking" | "approval" | "blocked" | "done" | "idle";

/** What a blocked agent waits on. */
export type BlockedOn = "ci" | "conflicts" | "agent" | "turn" | "person" | "failed" | "cut_off";

export interface SceneAgent {
  /**
   * Stable across refreshes and whatever its sessions do: `item:<id>:<role>` for an item's agent
   * (two items can name the same session), else `pm`, `scout` or `area:<area>`.
   */
  key: string;
  role: AgentRole;
  sessionId: string | null;
  /** The work item it works on; null for the PM, the scout and area reviewers. */
  card: ViewCard | null;
  step: AgentStep | null;
  /** What an agent without an item does, e.g. "Reviewing Security". */
  activity: string | null;
  status: AgentStatus;
  blockedOn: BlockedOn | null;
  /** Its session failed, or its item did: drawn slumped. */
  failed: boolean;
  provider: string | null;
  model: string | null;
  progress: string | null;
  /** Since when it is in its current step. */
  since: string | null;
  /** Seeds its look (palette, hair, hat): its session id, so it stays recognisable. */
  seed: string;
  area: DiscoveryArea | null;
}

/** PR states where an agent (or the factory) brings the pull request up to date. */
const REBASE_STATES = new Set(["rebasing", "updating"]);

function roleOf(card: ViewCard, session: SessionInfo | undefined): AgentRole {
  const workKey = session?.workKey ?? "";
  const w = card.item;
  if (workKey.startsWith("factory:integrate:")) return "integrator";
  const prState = card.pr?.state;
  // A rebuild redoes the work from the first step: that is a builder's job.
  if (
    prState &&
    (REBASE_STATES.has(prState) || (prState === "rebuilding" && w.stage !== "building"))
  )
    return "rebaser";
  if (workKey.startsWith("factory:review:")) return "reviewer";
  if (w.stage === "building" || (w.stage === "failed" && card.place === "building"))
    return "builder";
  return "reviewer";
}

function stepOf(card: ViewCard, role: AgentRole): AgentStep {
  const w = card.item;
  if (role === "rebaser" || role === "integrator") return "rebasing";
  if (role === "builder") {
    if (w.step === "reproduce") return "reproducing";
    if (w.step === "analyze") return "analyzing";
    return w.attempts > 0 ? "revising" : "implementing";
  }
  if (w.stage === "watching" || card.pr?.state === "waiting_ci") return "watching_ci";
  return w.step === "merge" ? "merging" : "reviewing";
}

/** Whether it reported progress since its step began. */
function reportedSince(session: SessionInfo, since: string | null): boolean {
  if (!session.progress || !session.progressAt) return false;
  return since === null || Date.parse(session.progressAt) >= Date.parse(since);
}

/** A running or starting session's state: working once it reported progress in this step. */
function liveStatus(session: SessionInfo, since: string | null): AgentStatus | null {
  if (session.status === "starting") return "thinking";
  if (session.status !== "running") return null;
  return reportedSince(session, since) ? "working" : "thinking";
}

function itemStatus(
  card: ViewCard,
  session: SessionInfo | undefined,
): { status: AgentStatus; blockedOn: BlockedOn | null } {
  const w = card.item;
  const blocked = (on: BlockedOn) => ({ status: "blocked" as const, blockedOn: on });
  if (w.stage === "merged" || w.stage === "watching") return { status: "done", blockedOn: null };
  if (session?.status === "waiting") return { status: "approval", blockedOn: null };
  if (card.state === "failed" || session?.status === "failed") return blocked("failed");
  if (session?.status === "interrupted") return blocked("cut_off");
  if (card.state === "person") return blocked("person");
  const pr = card.pr?.state;
  if (pr === "waiting_ci") return blocked("ci");
  const live = session ? liveStatus(session, card.since) : null;
  if (live) return { status: live, blockedOn: null };
  if (pr === "updating") return { status: "working", blockedOn: null };
  if (pr === "rebasing" || pr === "rebuilding") return blocked("conflicts");
  if (pr === "queued") return blocked("turn");
  return blocked("agent");
}

/** The session an item's agent in `role` speaks for, if the view knows it. */
function sessionIdOf(card: ViewCard, role: AgentRole, sessions: ReadonlyMap<string, SessionInfo>) {
  const w = card.item;
  if (role !== "reviewer") return card.sessionId;
  // A reviewer: the item's reviewer session, else the active one when it is a review.
  if (w.reviewerSessionId) return w.reviewerSessionId;
  const active = card.sessionId ? sessions.get(card.sessionId) : undefined;
  if (w.step === "review" || active?.workKey?.startsWith("factory:review:")) return card.sessionId;
  return null;
}

/**
 * The cards with an agent at a station: live work, and agents waiting on a person's answer. A
 * stuck pull request waits in the repair bay instead.
 */
function cardsOnFloor(p: ViewPipeline): ViewCard[] {
  const watching = p.stages.merged.filter((c) => c.item.stage === "watching");
  const asking = p.needsYou.filter((c) => c.need?.kind === "answer");
  return [
    ...p.stages.building,
    ...p.stages.reviewing,
    ...p.stages.merge,
    ...watching,
    ...asking,
  ].filter((c) => c.pr?.state !== "stuck");
}

const SCOUT_ACTIVITY: Record<ScoutStatus["phase"], string> = {
  idle: "Between rounds",
  planning: "Planning the round",
  reviewing: "Reviewing the areas",
  filing: "Filing issues",
};

/** At most this many area reviewers sit in the control room. */
export const AREA_SEATS = 4;

export interface AgentInputs {
  f: FactoryStatus;
  pipeline: ViewPipeline;
  sessions: ReadonlyMap<string, SessionInfo>;
  /** The project's PM session, when there is one. */
  pmSessionId: string | null;
}

/** Every agent on the floor, in pipeline order, then the PM, the scout and its area reviewers. */
export function sceneAgents({ f, pipeline, sessions, pmSessionId }: AgentInputs): SceneAgent[] {
  const out: SceneAgent[] = [];
  const facts = (sid: string | null) => {
    const s = sid ? sessions.get(sid) : undefined;
    return {
      session: s,
      provider: s?.provider ?? null,
      model: s?.model ?? null,
      progress: s?.progress ?? null,
    };
  };

  for (const card of cardsOnFloor(pipeline)) {
    const active = card.sessionId ? sessions.get(card.sessionId) : undefined;
    const role = roleOf(card, active);
    const sid = sessionIdOf(card, role, sessions);
    const { session, ...about } = facts(sid);
    const key = `item:${card.item.id}:${role}`;
    out.push({
      key,
      role,
      sessionId: sid,
      card,
      step: stepOf(card, role),
      activity: null,
      ...itemStatus(card, session),
      failed: card.state === "failed" || session?.status === "failed",
      ...about,
      since: card.since,
      seed: sid ?? key,
      area: null,
    });
  }

  const pm = facts(pmSessionId);
  const pmLive = pm.session ? liveStatus(pm.session, null) : null;
  out.push({
    key: "pm",
    role: "pm",
    sessionId: pmSessionId,
    card: null,
    step: null,
    activity: pmLive ? "Answering" : "Listening",
    status: pm.session?.status === "waiting" ? "approval" : pmLive ? "working" : "idle",
    blockedOn: null,
    failed: pm.session?.status === "failed",
    provider: pm.provider,
    model: pm.model,
    progress: pm.progress,
    since: null,
    seed: pmSessionId ?? "pm",
    area: null,
  });

  const scout = f.mode === "dark_factory" ? f.scout : null;
  if (!scout) return out;
  const sc = facts(scout.sessionId);
  const scoutLive = sc.session ? liveStatus(sc.session, null) : null;
  out.push({
    key: "scout",
    role: "scout",
    sessionId: scout.sessionId,
    card: null,
    step: null,
    activity: `${SCOUT_ACTIVITY[scout.phase]} (round ${scout.rounds})`,
    status: scout.phase === "idle" ? "idle" : (scoutLive ?? "working"),
    blockedOn: null,
    failed: false,
    provider: sc.provider,
    model: sc.model,
    progress: sc.progress,
    since: scout.lastRoundAt,
    seed: scout.sessionId ?? "scout",
    area: null,
  });
  for (const lens of scout.lenses.slice(0, AREA_SEATS)) {
    const a = facts(lens.sessionId);
    const live = a.session ? liveStatus(a.session, null) : null;
    out.push({
      key: `area:${lens.area}`,
      role: "area",
      sessionId: lens.sessionId,
      card: null,
      step: null,
      activity: `Reviewing ${AREA_LABEL[lens.area]}`,
      status: lens.reported ? "done" : lens.active ? (live ?? "working") : "blocked",
      blockedOn: lens.reported || lens.active ? null : "agent",
      failed: false,
      provider: a.provider,
      model: a.model,
      progress: a.progress,
      since: null,
      seed: lens.sessionId,
      area: lens.area,
    });
  }
  return out;
}

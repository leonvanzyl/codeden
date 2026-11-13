import type {
  FactoryPrEntry,
  FactoryStatus,
  FactoryWorkItem,
  SessionStatus,
} from "@codeden/contracts";
import { stepLabel } from "@/components/factory/meta";

/**
 * The Factory view's pipeline (§10.1): every work item of `factory_status` placed on one stage
 * of a left-to-right flow, with what it is doing and whether it waits on a person. Pure, so the
 * mapping is unit-tested and the view only draws it.
 */

/** The stages, left to right. */
export const VIEW_STAGES = [
  {
    id: "intake",
    label: "Intake",
    hint: "New issues from trusted authors (and the scout in a dark factory), before their type is known.",
  },
  {
    id: "type",
    label: "Identify type",
    hint: "Sorted into bug, feature or docs, and waiting for a free agent, in the order agents take them.",
  },
  {
    id: "building",
    label: "Building",
    hint: "An agent reproduces the bug or analyzes the feature, then implements it and opens a pull request.",
  },
  {
    id: "reviewing",
    label: "Reviewing",
    hint: "The independent reviewer, the merge checks and CI.",
  },
  {
    id: "merge",
    label: "Merge queue",
    hint: "Every check passed. With auto-merge on they merge one at a time, in this order; otherwise they wait for you.",
  },
  {
    id: "merged",
    label: "Merged",
    hint: "Merged today. Right after an automatic merge, CI on the default branch is watched.",
  },
] as const;

export type ViewStageId = (typeof VIEW_STAGES)[number]["id"];

/** Where a card is drawn: a pipeline stage, or the lane of work that waits on a person. */
export type ViewPlace = ViewStageId | "needs_you";

export const NEEDS_YOU_LABEL = "Needs you";

/**
 * A card's state marker: an agent is working (`running`), it waits on the factory (a free
 * agent, CI, its turn to merge: `waiting`), it waits on a person (`person`), it failed, or it
 * merged (`done`).
 */
export type CardState = "running" | "waiting" | "person" | "failed" | "done";

export const CARD_STATE_LABEL: Record<CardState, string> = {
  running: "Running",
  waiting: "Waiting",
  person: "Needs a person",
  failed: "Failed",
  done: "Merged",
};

/** What the view knows about a session from the snapshot. */
export interface SessionInfo {
  status: SessionStatus;
  /** The session's latest `report_progress` line. */
  progress: string | null;
}

export interface ViewCard {
  item: FactoryWorkItem;
  place: ViewPlace;
  state: CardState;
  /** The pull request entry the factory keeps for it, if any. */
  pr: FactoryPrEntry | null;
  /** What it is doing now, in a few words. */
  activity: string;
  /** Since when it has been in its current step. */
  since: string;
  /** The session working on it now (the reviewer while reviewing). */
  sessionId: string | null;
}

export interface ViewPipeline {
  stages: Record<ViewStageId, ViewCard[]>;
  needsYou: ViewCard[];
  /** Cards that wait on a person, wherever they are drawn. */
  needsPerson: number;
  failed: number;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** PR states that end the factory's hold on a pull request. */
const CLOSED_PR = new Set(["merged", "superseded"]);

function sameLocalDay(iso: string, now: number): boolean {
  return new Date(iso).toDateString() === new Date(now).toDateString();
}

/** A failed item still worth a person's look: it failed in the last day or still owns a PR. */
function failedRecently(w: FactoryWorkItem, pr: FactoryPrEntry | null, now: number): boolean {
  if (pr && !CLOSED_PR.has(pr.state)) return true;
  return now - Date.parse(w.finishedAt ?? w.updatedAt) < DAY_MS;
}

/** The stage a work item is drawn on, or null when the view leaves it out. */
export function placeOf(
  w: FactoryWorkItem,
  pr: FactoryPrEntry | null,
  now: number,
): ViewPlace | null {
  switch (w.stage) {
    case "candidate":
      return "intake";
    case "backlog":
      return "type";
    case "building":
      return "building";
    case "verifying":
      return w.step === "merge" ? "merge" : "reviewing";
    case "watching":
      return "merged";
    case "merged":
      return sameLocalDay(w.mergedAt ?? w.updatedAt, now) ? "merged" : null;
    case "escalated":
      return "needs_you";
    case "failed":
      return failedRecently(w, pr, now) ? "needs_you" : null;
    default:
      // Ignored (counted on Intake), rejected and reverted (counted in the stats).
      return null;
  }
}

/** The card's state marker, from its stage, its pull request and its session. */
export function stateOf(
  w: FactoryWorkItem,
  pr: FactoryPrEntry | null,
  session: SessionInfo | undefined,
): CardState {
  if (w.stage === "failed") return "failed";
  if (w.stage === "escalated") return "person";
  if (w.stage === "merged") return "done";
  if (pr?.state === "waiting_for_you" || pr?.state === "stuck") return "person";
  if (w.stage === "watching") return "running";
  if (session?.status === "waiting") return "person";
  if (session?.status === "failed") return "failed";
  if (session?.status === "running" || session?.status === "starting") return "running";
  return "waiting";
}

function activityOf(
  w: FactoryWorkItem,
  pr: FactoryPrEntry | null,
  session: SessionInfo | undefined,
): string {
  const outcome = w.stage === "failed" || w.stage === "escalated" ? (w.reason ?? w.note) : null;
  return (
    outcome ??
    session?.progress ??
    pr?.note ??
    w.note ??
    (w.stage === "watching" ? "Watching CI on the default branch" : null) ??
    (w.stage === "merged" ? "Merged" : stepLabel(w.step, w.type))
  );
}

/** Place every work item of the status on the view, with its state and activity line. */
export function viewPipeline(
  f: FactoryStatus,
  sessions: ReadonlyMap<string, SessionInfo>,
  now: number = Date.now(),
): ViewPipeline {
  const prs = new Map(f.pullRequests.map((p) => [p.itemId, p]));
  const prOrder = new Map(f.pullRequests.map((p, i) => [p.itemId, i]));
  const stages: Record<ViewStageId, ViewCard[]> = {
    intake: [],
    type: [],
    building: [],
    reviewing: [],
    merge: [],
    merged: [],
  };
  const needsYou: ViewCard[] = [];
  const seen = new Set<string>();
  for (const w of [...f.backlog, ...f.inProgress, ...f.recent]) {
    if (seen.has(w.id)) continue;
    seen.add(w.id);
    const pr = prs.get(w.id) ?? null;
    const place = placeOf(w, pr, now);
    if (!place) continue;
    const sessionId = w.activeSessionId ?? w.sessionId;
    const session = sessionId ? sessions.get(sessionId) : undefined;
    const card: ViewCard = {
      item: w,
      place,
      state: stateOf(w, pr, session),
      pr,
      activity: activityOf(w, pr, session),
      since: w.stepSince ?? w.updatedAt,
      sessionId,
    };
    (place === "needs_you" ? needsYou : stages[place]).push(card);
  }
  // Longest-waiting first where the server's order doesn't already say who goes next.
  const oldest = (a: ViewCard, b: ViewCard) => Date.parse(a.since) - Date.parse(b.since);
  stages.building.sort(oldest);
  stages.reviewing.sort(oldest);
  // The merge queue in the order it merges, then the PRs that aren't queued.
  stages.merge.sort((a, b) => {
    const qa = a.pr?.queuePosition ?? Number.POSITIVE_INFINITY;
    const qb = b.pr?.queuePosition ?? Number.POSITIVE_INFINITY;
    if (qa !== qb) return qa - qb;
    return (
      (prOrder.get(a.item.id) ?? Number.POSITIVE_INFINITY) -
      (prOrder.get(b.item.id) ?? Number.POSITIVE_INFINITY)
    );
  });
  stages.merged.sort(
    (a, b) =>
      Date.parse(b.item.mergedAt ?? b.item.updatedAt) -
      Date.parse(a.item.mergedAt ?? a.item.updatedAt),
  );
  const all = [...Object.values(stages).flat(), ...needsYou];
  return {
    stages,
    needsYou,
    needsPerson: all.filter((c) => c.state === "person").length,
    failed: all.filter((c) => c.state === "failed").length,
  };
}

/** A card's short label: its issue number, else its PR number, else its title. */
export function cardNumber(w: FactoryWorkItem): string {
  if (w.issue) return `#${w.issue.number}`;
  if (w.pr) return `PR #${w.pr.number}`;
  return w.title.slice(0, 18);
}

/** Where each card is now, for announcing moves. */
export function placesOf(p: ViewPipeline): Map<string, ViewPlace> {
  const places = new Map<string, ViewPlace>();
  for (const card of [...Object.values(p.stages).flat(), ...p.needsYou])
    places.set(card.item.id, card.place);
  return places;
}

export function placeLabel(place: ViewPlace): string {
  if (place === "needs_you") return NEEDS_YOU_LABEL;
  return VIEW_STAGES.find((s) => s.id === place)?.label ?? place;
}

/**
 * What a screen reader hears when cards move: one sentence per card that changed stage
 * ("#142 moved to Reviewing.") or arrived. Cards that left the view aren't announced.
 */
export function describeMoves(
  before: ReadonlyMap<string, ViewPlace>,
  after: ViewPipeline,
): string[] {
  const lines: string[] = [];
  for (const card of [...Object.values(after.stages).flat(), ...after.needsYou]) {
    const was = before.get(card.item.id);
    if (was === card.place) continue;
    const name = cardNumber(card.item);
    lines.push(
      was
        ? `${name} moved to ${placeLabel(card.place)}.`
        : `${name} arrived in ${placeLabel(card.place)}.`,
    );
  }
  return lines;
}

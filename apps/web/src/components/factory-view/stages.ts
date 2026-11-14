import {
  type FactoryNeedKind,
  type FactoryPrEntry,
  type FactoryStatus,
  type FactoryWorkItem,
  factoryNeed,
  factoryNeedLabel,
  type SessionStatus,
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
    hint: "Every check passed and auto-merge is on: they merge one at a time, in this order. Pull requests a person merges wait in Needs you.",
  },
  {
    id: "merged",
    label: "Merged",
    hint: "Merged today. Right after an automatic merge, CI on the default branch is watched.",
  },
] as const;

export type ViewStageId = (typeof VIEW_STAGES)[number]["id"];

/**
 * Where a card is drawn: a pipeline stage, or the lane of work that waits on a person (whatever
 * `factoryNeed` says needs you, and nothing else).
 */
export type ViewPlace = ViewStageId | "needs_you";

/** What a card in the "Needs you" lane needs from a person, in words. */
export interface ViewNeed {
  kind: FactoryNeedKind;
  label: string;
}

export const NEEDS_YOU_LABEL = "Needs you";

/**
 * A card's state marker, one of four on every card:
 * - `running`: an agent is working on it, or CI is watched right after its automatic merge;
 * - `waiting`: nobody has to act and no agent is busy with it: it waits for a free agent, CI or
 *   its turn to merge, or it merged and is done;
 * - `person`: it waits on a person (an escalation, a PR to merge, a stuck PR, an agent's question);
 * - `failed`: it, or its agent's session, failed.
 */
export type CardState = "running" | "waiting" | "person" | "failed";

export const CARD_STATE_LABEL: Record<CardState, string> = {
  running: "Running",
  waiting: "Waiting",
  person: "Needs a person",
  failed: "Failed",
};

/** What the view knows about a session from the snapshot. */
export interface SessionInfo {
  status: SessionStatus;
  /** The session's latest `report_progress` line. */
  progress: string | null;
  /** When it reported that line. */
  progressAt?: string | null;
  /** The provider's display name ("Claude Code"), else its id. */
  provider?: string;
  model?: string | null;
  /** What the session works on (`factory:review:59`, `factory:integrate:53`, `issue:142`). */
  workKey?: string;
}

export interface ViewCard {
  item: FactoryWorkItem;
  place: ViewPlace;
  state: CardState;
  /** The entry the factory keeps for its current pull request, if the PR list has one. */
  pr: FactoryPrEntry | null;
  /** What it is doing now, in a few words. */
  activity: string;
  /** Since when it has been in its current step. */
  since: string;
  /** The session working on it now (the reviewer while reviewing). */
  sessionId: string | null;
  /** What it needs from a person; set on the cards of the "Needs you" lane only. */
  need: ViewNeed | null;
}

export interface ViewPipeline {
  stages: Record<ViewStageId, ViewCard[]>;
  needsYou: ViewCard[];
  /** Work that waits on a person: the "Needs you" lane, so the header counts what it lists. */
  needsPerson: number;
  /** Failed work (the item, or its agent's session), wherever it is drawn. */
  failed: number;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** PR states that end the factory's hold on a pull request. */
const CLOSED_PR = new Set(["merged", "superseded"]);

function sameLocalDay(iso: string, now: number): boolean {
  return new Date(iso).toDateString() === new Date(now).toDateString();
}

/**
 * The entry for an item's current pull request. An item can have several: superseded ones stay
 * listed (after the current one) until the factory has closed them, and a rebuild lists the PR it
 * replaces. The one matching the item's PR wins, else the first that isn't superseded.
 */
export function currentPr(
  w: Pick<FactoryWorkItem, "id" | "pr">,
  entries: readonly FactoryPrEntry[],
): FactoryPrEntry | null {
  const mine = entries.filter((p) => p.itemId === w.id);
  return (
    mine.find((p) => w.pr !== null && p.pr.number === w.pr.number) ??
    mine.find((p) => p.state !== "superseded") ??
    mine[0] ??
    null
  );
}

/**
 * Whether the factory still holds an open PR for it. The PR list (capped) says so when it has
 * the item; otherwise the item's own `ownedPr`, or its PR while open, does.
 */
function ownsOpenPr(w: FactoryWorkItem, pr: FactoryPrEntry | null): boolean {
  if (pr) return !CLOSED_PR.has(pr.state);
  return w.ownedPr !== null || w.pr?.state === "open" || w.pr?.state === "draft";
}

/**
 * Stuck: it already used its rebuild, or CI can never run, so it needs a person. The PR list's
 * state says so when it lists the item; otherwise the item's failure kind does.
 */
function isStuck(w: FactoryWorkItem, pr: FactoryPrEntry | null): boolean {
  return pr ? pr.state === "stuck" : w.stage === "failed" && w.failureKind === "stuck";
}

/** The open PR the factory holds for it: the PR list's entry, else its own `ownedPr` or open PR. */
function openPrNumber(w: FactoryWorkItem, pr: FactoryPrEntry | null): number | null {
  if (pr) return CLOSED_PR.has(pr.state) ? null : pr.pr.number;
  return w.ownedPr?.number ?? w.pr?.number ?? null;
}

/**
 * What a work item needs from a person, by the factory's one definition (`factoryNeed`): the
 * lane shows these cards and the header counts them. Null when nothing waits on a person.
 */
export function needOf(
  w: FactoryWorkItem,
  pr: FactoryPrEntry | null,
  session: SessionInfo | undefined,
  now: number,
): ViewNeed | null {
  const kind = factoryNeed(w, {
    now,
    ownsOpenPr: ownsOpenPr(w, pr),
    recovering: w.recovering,
    prWaitsForYou: pr?.state === "waiting_for_you",
    agentWaiting: session?.status === "waiting",
  });
  if (!kind) return null;
  const prNumber = openPrNumber(w, pr);
  return { kind, label: factoryNeedLabel(kind, { attempts: w.attempts, prNumber }) };
}

/**
 * The stage a work item is drawn on, or null when the view leaves it out. Work that needs a
 * person (`need`) is drawn in the "Needs you" lane, wherever it is in the pipeline.
 */
export function placeOf(
  w: FactoryWorkItem,
  pr: FactoryPrEntry | null,
  now: number,
  need: ViewNeed | null = null,
): ViewPlace | null {
  if (need) return "needs_you";
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
    case "failed":
      // A failure outside its code goes back by itself, to review when its PR is open (and
      // within the last day, as the server keeps them); others that need nothing are old news.
      if (!w.recovering) return null;
      if (ownsOpenPr(w, pr)) return "reviewing";
      return now - Date.parse(w.finishedAt ?? w.updatedAt) < DAY_MS ? "building" : null;
    default:
      // Ignored (counted on Intake), rejected and reverted (counted in the stats); escalated
      // work always needs you.
      return null;
  }
}

/** The card's state marker, from its stage, its pull request and its session. */
export function stateOf(
  w: FactoryWorkItem,
  pr: FactoryPrEntry | null,
  session: SessionInfo | undefined,
): CardState {
  if (w.stage === "escalated" || isStuck(w, pr)) return "person";
  if (w.stage === "failed") return "failed";
  // Done: nothing left for anyone to do.
  if (w.stage === "merged") return "waiting";
  if (pr?.state === "waiting_for_you") return "person";
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
  // `viewRecent` holds the finished work the view needs beyond the capped `recent` list.
  for (const w of [...f.backlog, ...f.inProgress, ...f.viewRecent, ...f.recent]) {
    if (seen.has(w.id)) continue;
    seen.add(w.id);
    const pr = currentPr(w, f.pullRequests);
    const sessionId = w.activeSessionId ?? w.sessionId;
    const session = sessionId ? sessions.get(sessionId) : undefined;
    const need = needOf(w, pr, session, now);
    const place = placeOf(w, pr, now, need);
    if (!place) continue;
    const card: ViewCard = {
      item: w,
      place,
      state: stateOf(w, pr, session),
      pr,
      activity: activityOf(w, pr, session),
      since: w.stepSince ?? w.updatedAt,
      sessionId,
      need,
    };
    (place === "needs_you" ? needsYou : stages[place]).push(card);
  }
  // Longest-waiting first where the server's order doesn't already say who goes next.
  const oldest = (a: ViewCard, b: ViewCard) => Date.parse(a.since) - Date.parse(b.since);
  stages.building.sort(oldest);
  stages.reviewing.sort(oldest);
  // The merge queue in the order it merges, then the other PRs in the server's order.
  const inf = Number.POSITIVE_INFINITY;
  const listed = (c: ViewCard) => {
    const at = c.pr ? f.pullRequests.indexOf(c.pr) : -1;
    return at === -1 ? inf : at;
  };
  stages.merge.sort((a, b) => {
    const qa = a.pr?.queuePosition ?? inf;
    const qb = b.pr?.queuePosition ?? inf;
    if (qa !== qb) return qa - qb;
    const la = listed(a);
    const lb = listed(b);
    return la === lb ? 0 : la - lb;
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
    needsPerson: needsYou.length,
    failed: all.filter((c) => c.state === "failed" || c.item.stage === "failed").length,
  };
}

/** A card's short label: its issue number, else its PR number, else its title. */
export function cardNumber(w: FactoryWorkItem): string {
  if (w.issue) return `#${w.issue.number}`;
  if (w.pr) return `PR #${w.pr.number}`;
  return w.title.slice(0, 18);
}

/** The card's state in words, for its accessible name and the sheet ("Waiting, merged"). */
export function cardStateLabel(card: Pick<ViewCard, "state" | "item">): string {
  const state = CARD_STATE_LABEL[card.state];
  return card.item.stage === "merged" ? `${state}, merged` : state;
}

/**
 * The pull request's place and state in a few words, e.g. "Queued #2" or "Updating · #1".
 * Null when it says nothing the card doesn't (checking, merged, superseded).
 */
export function prLabel(pr: FactoryPrEntry | null, labels: Record<string, string>): string | null {
  if (!pr || pr.state === "checking" || pr.state === "merged" || pr.state === "superseded")
    return null;
  if (pr.state === "queued") return pr.queuePosition ? `Queued #${pr.queuePosition}` : "Queued";
  const label = labels[pr.state] ?? pr.state;
  return pr.queuePosition ? `${label} · #${pr.queuePosition}` : label;
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

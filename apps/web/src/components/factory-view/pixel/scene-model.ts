import type { FactoryStatus, WorkType } from "@codeden/contracts";
import type { ViewCard } from "../stages";
import { type AgentInputs, type SceneAgent, sceneAgents } from "./agents";
import { frontOf, type StationId, stationOf, type Tile, tileId } from "./floor";
import { type BayCrate, bayCount, repairBay } from "./repair-bay";
import { assignSeats, type Seating } from "./seating";

/**
 * Pixel mode (#209, #264): the Factory view's pipeline as a factory floor. This module maps the
 * live state to what the scene shows: the agents and their seats, the ticket pile at intake, the
 * repair bay, the shipped counter and the wall's gauge and CI lamp, plus the moments to act out
 * when the state changes. Pure, so the mapping is unit-tested; `draw*.ts` only paints it.
 */

/** Tickets drawn on the intake pallet; the rest show as "+N". */
export const TICKET_CAP = 8;

export interface SceneTicket {
  card: ViewCard;
  slot: number;
  /** Plain paper before the item is sorted; tinted by type once it is. */
  tint: "paper" | WorkType;
}

export interface TicketPile {
  items: SceneTicket[];
  more: number;
  ids: string[];
}

export interface Scene {
  /** Kill switch on or loop stopped: the lights dim and everyone sits down. */
  stopped: boolean;
  agents: SceneAgent[];
  seating: Seating;
  tickets: TicketPile;
  bay: BayCrate[];
  /** Items merged today: off the floor, only counted. */
  merged: string[];
  /** The counter by the shipping door: merges today, as the figures count them. */
  shipped: number;
  /** Some pull request waits on CI, or CI on the default branch is watched after a merge. */
  ciRunning: boolean;
  /** Spend against the daily budget, 0..1; null when no budget is set. */
  gauge: number | null;
  /** Dark factory only. */
  scout: { round: number; active: boolean } | null;
}

/** Spend today against the daily budget, as the figures measure it (USD first, else tokens). */
export function budgetGauge(f: FactoryStatus): number | null {
  const { usd, tokens } = f.limits.dailyBudget;
  const fraction = usd ? f.spendToday.usd / usd : tokens ? f.spendToday.tokens / tokens : null;
  return fraction === null ? null : Math.min(1, Math.max(0, fraction));
}

function ticketsOf(cards: readonly ViewCard[]): TicketPile {
  return {
    items: cards.slice(0, TICKET_CAP).map((card, slot) => ({
      card,
      slot,
      tint: card.place === "type" && card.item.type ? card.item.type : "paper",
    })),
    more: Math.max(0, cards.length - TICKET_CAP),
    ids: cards.map((c) => c.item.id),
  };
}

/**
 * The scene for the current state. Seats follow `prev`, the seating of the scene before, so an
 * agent that stays at its station keeps its seat; the same data gives the same scene.
 */
export function sceneOf(inputs: AgentInputs, prev: Seating | null): Scene {
  const { f, pipeline } = inputs;
  const agents = sceneAgents(inputs);
  const seating = assignSeats(
    prev,
    agents.map((a) => ({ key: a.key, station: stationOf(a) })),
  );
  const all = [...Object.values(pipeline.stages).flat(), ...pipeline.needsYou];
  return {
    stopped: f.killSwitch || f.globalKillSwitch || f.loopState === "stopped",
    agents,
    seating,
    tickets: ticketsOf([...pipeline.stages.intake, ...pipeline.stages.type]),
    bay: repairBay(pipeline),
    merged: pipeline.stages.merged.filter((c) => c.item.stage === "merged").map((c) => c.item.id),
    shipped: f.limits.autoMerge ? f.mergesToday : f.stats.mergedToday,
    ciRunning: all.some((c) => c.pr?.state === "waiting_ci" || c.item.stage === "watching"),
    gauge: budgetGauge(f),
    scout:
      f.mode === "dark_factory" && f.scout
        ? { round: f.scout.rounds, active: f.scout.phase !== "idle" }
        : null,
  };
}

/** A moment the floor acts out once, between two scenes. */
export type Transition =
  /** An agent walks from its old seat to its new one; a reviewer stamps the crate first. */
  | {
      kind: "move";
      key: string;
      from: Tile;
      to: Tile;
      carry: "crate" | null;
      stamp: boolean;
      /** It celebrates on arrival (its pull request merged). */
      celebrate: boolean;
    }
  /** A build started from the pile: the builder walks in carrying its ticket. */
  | { kind: "arrive"; key: string; to: Tile }
  /** The builder carries its PR crate to the reviewer's desk, then walks back to its bench. */
  | { kind: "handoff"; agent: SceneAgent; from: Tile; to: Tile }
  /** A merge: the crate rides up the conveyor and out of the shipping door. */
  | { kind: "ship"; row: number }
  /** A departed agent's pull request merged: a small celebration where it stood. */
  | { kind: "celebrate"; agent: SceneAgent; at: Tile }
  /** It failed: a puff of smoke and a slump (and the agent leaves for the repair bay). */
  | { kind: "fail"; agent: SceneAgent; at: Tile; stays: boolean };

const itemOf = (a: SceneAgent) => a.card?.item.id ?? null;

/**
 * The moments between the previous scene and this one. Nothing on the first scene, so opening
 * the view doesn't replay the day, and nothing when the same data comes again.
 */
export function sceneEvents(prev: Scene | null, next: Scene): Transition[] {
  if (!prev) return [];
  const out: Transition[] = [];
  const before = (key: string) => prev.seating.seats.get(key);
  const after = (key: string) => next.seating.seats.get(key);
  const prevByItem = new Map<string, SceneAgent>();
  for (const a of prev.agents) {
    const id = itemOf(a);
    if (id) prevByItem.set(id, a);
  }
  const nextKeys = new Set(next.agents.map((a) => a.key));
  const nextItems = new Set(next.agents.map(itemOf).filter(Boolean));
  const was = new Map(prev.agents.map((a) => [a.key, a]));

  for (const a of next.agents) {
    const to = after(a.key);
    if (!to) continue;
    const item = itemOf(a);
    const same = was.get(a.key);
    const from = same ? before(a.key) : undefined;
    if (same && from) {
      if (tileId(from.tile) !== tileId(to.tile)) {
        const handsOver = from.station === "review" && to.station === "merge";
        out.push({
          kind: "move",
          key: a.key,
          from: from.tile,
          to: to.tile,
          carry: handsOver ? "crate" : null,
          stamp: handsOver,
          celebrate: to.station === "ship",
        });
        if (from.station === "merge" && to.station === "ship")
          out.push({ kind: "ship", row: from.tile.r });
      }
      if (!same.failed && a.failed) out.push({ kind: "fail", agent: a, at: to.tile, stays: true });
      continue;
    }
    if (same || !item) continue;
    // The item's builder hands its pull request over to the new reviewer.
    const builder = prevByItem.get(item);
    const bench = builder ? before(builder.key) : undefined;
    if (builder?.role === "builder" && a.role === "reviewer" && bench) {
      out.push({ kind: "handoff", agent: builder, from: bench.tile, to: frontOf(to.tile) });
      continue;
    }
    if (a.role === "builder" && prev.tickets.ids.includes(item))
      out.push({ kind: "arrive", key: a.key, to: to.tile });
  }

  const merged = new Set(next.merged);
  const inBay = new Set(next.bay.flatMap((c) => c.entries.map((e) => e.card.item.id)));
  for (const b of prev.agents) {
    const item = itemOf(b);
    const seat = before(b.key);
    if (nextKeys.has(b.key) || !item || !seat || nextItems.has(item)) continue;
    if (merged.has(item)) {
      out.push({ kind: "celebrate", agent: b, at: seat.tile });
      if (seat.station === "merge") out.push({ kind: "ship", row: seat.tile.r });
    } else if (inBay.has(item)) out.push({ kind: "fail", agent: b, at: seat.tile, stays: false });
  }
  return out;
}

const STATION_WORDS: [StationId[], string][] = [
  [["prep", "bench"], "building"],
  [["review"], "in review"],
  [["merge"], "in the merge queue"],
];

/**
 * The scene in words, for the live caption that stands in for the canvas: "4 building, 1 in
 * review, 3 merged today, 1 waiting for approval, 2 in the repair bay." Full counts, drawn or not.
 */
export function sceneSummary(scene: Scene): string {
  const parts: string[] = [];
  const add = (n: number, text: string) => {
    if (n > 0) parts.push(`${n} ${text}`);
  };
  add(scene.tickets.ids.length, "in intake");
  const work = scene.agents.filter((a) => a.card);
  for (const [stations, words] of STATION_WORDS)
    add(work.filter((a) => stations.includes(stationOf(a))).length, words);
  add(scene.shipped, "merged today");
  add(scene.agents.filter((a) => a.status === "approval").length, "waiting for approval");
  add(bayCount(scene.bay), "in the repair bay");
  const lines = [parts.length > 0 ? `${parts.join(", ")}.` : "The factory floor is quiet."];
  if (scene.scout?.active && !scene.stopped)
    lines.push(`The scout is on round ${scene.scout.round}.`);
  if (scene.stopped) lines.push("The loop is stopped.");
  return lines.join(" ");
}

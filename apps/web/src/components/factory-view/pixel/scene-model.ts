import type { DiscoveryArea, FactoryStatus, ScoutStatus, WorkType } from "@codeden/contracts";
import { AREA_LABEL } from "@/components/factory/meta";
import type { CardState, ViewCard, ViewPipeline } from "../stages";

/**
 * Pixel mode (#209): the Factory view's pipeline as a small factory floor. This module maps the
 * live state to what the scene shows (which workers, tickets, crates and machines exist, on
 * which station slot, in which pose). It is pure, so the mapping is unit-tested; `draw.ts` only
 * paints it.
 */

/** How many of each thing the floor has room for; the rest show as "+N". */
export const SCENE_CAPS = {
  tickets: 8,
  builders: 6,
  reviewers: 4,
  queue: 6,
  shipped: 5,
  machines: 4,
  helpers: 4,
} as const;

/**
 * A worker's pose: `work` (hammering, inspecting), `idle` (standing by, waiting for CI or a free
 * agent), `ask` (its agent asked a question, or the PR waits for you), `alert` (it failed), and
 * `sit` (the loop is stopped).
 */
export type WorkerPose = "work" | "idle" | "ask" | "alert" | "sit";

/** One drawn thing tied to a work item, on a fixed station slot (0 is the first). */
export interface SceneSlot {
  card: ViewCard;
  slot: number;
}

export interface SceneTicket extends SceneSlot {
  /** Plain paper before the item is sorted; tinted by type once it is. */
  tint: "paper" | WorkType;
}

export interface SceneWorker extends SceneSlot {
  pose: WorkerPose;
}

export interface SceneCrate extends SceneSlot {
  /** A flag above it: the pull request waits on a person (or failed). */
  flag: "person" | "failed" | null;
}

export interface SceneShipped extends SceneSlot {
  /** Merged automatically and CI on the default branch is still watched. */
  watching: boolean;
}

export interface SceneMachine extends SceneSlot {
  /** Red lamp and smoke for failed work; an amber lamp for an escalation. */
  failed: boolean;
}

/** A station: what's drawn, how many more there are, and every item id there (drawn or not). */
export interface Station<T> {
  items: T[];
  more: number;
  ids: string[];
}

export interface SceneHelper {
  area: DiscoveryArea;
  label: string;
  /** `writing` while it reviews, `done` once it reported, `waiting` before it starts. */
  state: "writing" | "done" | "waiting";
  slot: number;
}

export interface SceneScout {
  phase: ScoutStatus["phase"];
  /** It walks the floor with its magnifying glass while a round runs. */
  walking: boolean;
  round: number;
  findings: number;
  filed: number;
  helpers: SceneHelper[];
}

export interface Scene {
  /** Kill switch on or loop stopped: the lights dim and everyone sits down. */
  stopped: boolean;
  tickets: Station<SceneTicket>;
  builders: Station<SceneWorker>;
  reviewers: Station<SceneWorker>;
  queue: Station<SceneCrate>;
  shipped: Station<SceneShipped>;
  machines: Station<SceneMachine>;
  /** Dark factory only. */
  scout: SceneScout | null;
  /** Spend against the daily budget, 0..1; null when no budget is set. */
  gauge: number | null;
  /** The counter board: merges today, the same number as the figures' "Merges today". */
  mergesToday: number;
}

function station<T extends SceneSlot>(
  cards: readonly ViewCard[],
  cap: number,
  make: (card: ViewCard, slot: number) => T,
): Station<T> {
  return {
    items: cards.slice(0, cap).map((c, i) => make(c, i)),
    more: Math.max(0, cards.length - cap),
    ids: cards.map((c) => c.item.id),
  };
}

function poseOf(state: CardState, stopped: boolean): WorkerPose {
  if (stopped) return "sit";
  if (state === "running") return "work";
  if (state === "person") return "ask";
  if (state === "failed") return "alert";
  return "idle";
}

/** Spend today against the daily budget, as the figures measure it (USD first, else tokens). */
export function budgetGauge(f: FactoryStatus): number | null {
  const { usd, tokens } = f.limits.dailyBudget;
  const fraction = usd ? f.spendToday.usd / usd : tokens ? f.spendToday.tokens / tokens : null;
  return fraction === null ? null : Math.min(1, Math.max(0, fraction));
}

function scoutOf(scout: ScoutStatus | null, f: FactoryStatus): SceneScout | null {
  if (f.mode !== "dark_factory" || !scout) return null;
  return {
    phase: scout.phase,
    walking: scout.phase !== "idle",
    round: scout.rounds,
    findings: scout.findings,
    filed: scout.filed,
    helpers: scout.lenses.slice(0, SCENE_CAPS.helpers).map((l, slot) => ({
      area: l.area,
      label: AREA_LABEL[l.area],
      state: l.reported ? "done" : l.active ? "writing" : "waiting",
      slot,
    })),
  };
}

/** The scene for the current factory state and pipeline. */
export function sceneOf(f: FactoryStatus, pipeline: ViewPipeline): Scene {
  const stopped = f.killSwitch || f.globalKillSwitch || f.loopState === "stopped";
  const { stages } = pipeline;
  const worker = (card: ViewCard, slot: number): SceneWorker => ({
    card,
    slot,
    pose: poseOf(card.state, stopped),
  });
  return {
    stopped,
    tickets: station([...stages.intake, ...stages.type], SCENE_CAPS.tickets, (card, slot) => ({
      card,
      slot,
      tint: card.place === "type" && card.item.type ? card.item.type : "paper",
    })),
    builders: station(stages.building, SCENE_CAPS.builders, worker),
    reviewers: station(stages.reviewing, SCENE_CAPS.reviewers, worker),
    queue: station(stages.merge, SCENE_CAPS.queue, (card, slot) => ({
      card,
      slot,
      flag: card.state === "person" || card.state === "failed" ? card.state : null,
    })),
    shipped: station(stages.merged, SCENE_CAPS.shipped, (card, slot) => ({
      card,
      slot,
      watching: card.item.stage === "watching",
    })),
    machines: station(pipeline.needsYou, SCENE_CAPS.machines, (card, slot) => ({
      card,
      slot,
      failed: card.item.stage === "failed" || card.state === "failed",
    })),
    scout: scoutOf(f.scout, f),
    gauge: budgetGauge(f),
    mergesToday: f.limits.autoMerge ? f.mergesToday : f.stats.mergedToday,
  };
}

/** What changed between two scenes that the floor acts out once. */
export interface SceneEvents {
  /** Items whose build started: a worker carries their ticket from the pile to a bench. */
  buildStarted: string[];
  /** Items that merged: their crate rides out of the shipping door with a sparkle. */
  shipped: string[];
}

/**
 * The moments to animate between the previous scene and this one. Nothing on the first scene,
 * so opening the view doesn't replay the day. Only drawn items animate (they need a slot).
 */
export function sceneEvents(prev: Scene | null, next: Scene): SceneEvents {
  if (!prev) return { buildStarted: [], shipped: [] };
  const wasTicket = new Set(prev.tickets.ids);
  const wasBuilding = new Set(prev.builders.ids);
  const wasQueued = new Set([...prev.queue.ids, ...prev.reviewers.ids]);
  const wasShipped = new Set(prev.shipped.ids);
  return {
    buildStarted: next.builders.items
      .map((b) => b.card.item.id)
      .filter((id) => !wasBuilding.has(id) && wasTicket.has(id)),
    shipped: next.shipped.items
      .map((s) => s.card.item.id)
      .filter((id) => !wasShipped.has(id) && wasQueued.has(id)),
  };
}

/**
 * The scene in words, for the live caption that stands in for the canvas: "3 building, 1 in
 * review, 2 merged today, 1 needs you." Counts are the full ones, not just what's drawn.
 */
export function sceneSummary(scene: Scene): string {
  const parts: string[] = [];
  const add = (n: number, text: string) => {
    if (n > 0) parts.push(`${n} ${text}`);
  };
  add(scene.tickets.ids.length, "in intake");
  add(scene.builders.ids.length, "building");
  add(scene.reviewers.ids.length, "in review");
  add(scene.queue.ids.length, "in the merge queue");
  add(scene.mergesToday, "merged today");
  const needYou = scene.machines.ids.length;
  add(needYou, needYou === 1 ? "needs you" : "need you");
  const lines = [parts.length > 0 ? `${parts.join(", ")}.` : "The factory floor is quiet."];
  if (scene.scout?.walking && !scene.stopped)
    lines.push(`The scout is on round ${scene.scout.round}.`);
  if (scene.stopped) lines.push("The loop is stopped.");
  return lines.join(" ");
}

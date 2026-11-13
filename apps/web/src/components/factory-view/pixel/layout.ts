import type { ViewCard } from "../stages";
import type { Scene } from "./scene-model";

/**
 * Where everything stands on the factory floor, in scene pixels (320×180, scaled up on screen).
 * The flow runs left to right like the board: the intake door and its ticket pile, the
 * workbenches, the inspection area, then the conveyor to the shipping door. Broken machines line
 * the bottom; the scout's helpers sit in the bottom-left corner.
 */

export const SCENE_W = 320;
export const SCENE_H = 180;
/** The back wall's height; the floor starts below it. */
export const WALL_H = 36;

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export const IN_DOOR: Rect = { x: 12, y: 8, w: 32, h: 28 };
export const SHIP_DOOR: Rect = { x: 258, y: 8, w: 32, h: 28 };
export const WINDOWS: Rect[] = [
  { x: 56, y: 8, w: 36, h: 18 },
  { x: 196, y: 8, w: 36, h: 18 },
];
export const GAUGE: Rect = { x: 104, y: 6, w: 28, h: 24 };
export const COUNTER: Rect = { x: 140, y: 6, w: 44, h: 24 };
export const BELT: Rect = { x: 262, y: WALL_H, w: 24, h: SCENE_H - WALL_H };

/** Where the scout waits between rounds, and the aisle it walks during one. */
export const SCOUT_HOME = { x: 50, y: 40 };
export const SCOUT_AISLE = { x0: 64, x1: 240, y: 118 };

/** Ticket slots in the pile in front of the intake door (top-left corners of 7×5 tickets). */
const TICKETS = [
  [18, 44],
  [28, 42],
  [22, 50],
  [33, 49],
  [14, 53],
  [27, 57],
  [37, 56],
  [20, 61],
] as const;

export function ticketAt(slot: number): Rect {
  const [x, y] = TICKETS[slot] ?? TICKETS[0];
  return { x, y, w: 7, h: 5 };
}

/** A workbench cell: three across, two rows. The worker stands behind the bench. */
export function builderCell(slot: number): Rect {
  return { x: 64 + (slot % 3) * 40, y: 44 + Math.floor(slot / 3) * 38, w: 36, h: 32 };
}

/** An inspection cell: a crate and a reviewer with a clipboard, two across, two rows. */
export function reviewerCell(slot: number): Rect {
  return { x: 188 + (slot % 2) * 34, y: 44 + Math.floor(slot / 2) * 38, w: 32, h: 32 };
}

/** A crate on the conveyor; slot 0 is next to the shipping door. */
export function queueCrate(slot: number): Rect {
  return { x: BELT.x + 6, y: WALL_H + 6 + slot * 21, w: 12, h: 12 };
}

/** Today's shipped crates, stacked on the dock beside the conveyor. */
const SHIPPED = [
  [292, 104],
  [305, 104],
  [292, 91],
  [305, 91],
  [298, 78],
] as const;

export function shippedCrate(slot: number): Rect {
  const [x, y] = SHIPPED[slot] ?? SHIPPED[0];
  return { x, y, w: 12, h: 12 };
}

/** A broken machine along the bottom of the floor. */
export function machineCell(slot: number): Rect {
  return { x: 66 + slot * 44, y: 136, w: 30, h: 40 };
}

/** An area reviewer's spot in the bottom-left corner. */
export function helperCell(slot: number): Rect {
  return { x: 6 + (slot % 2) * 24, y: 120 + Math.floor(slot / 2) * 28, w: 20, h: 24 };
}

/** Where a "+N" sign goes for each station that overflows. */
export const MORE_AT = {
  tickets: { x: 42, y: 64 },
  builders: { x: 170, y: 116 },
  reviewers: { x: 244, y: 116 },
  queue: { x: BELT.x + 4, y: SCENE_H - 8 },
  shipped: { x: 296, y: 120 },
  machines: { x: 242, y: 168 },
} as const;

/** Something on the floor the pointer can hover and click. */
export interface SceneTarget {
  key: string;
  rect: Rect;
  kind: "ticket" | "builder" | "reviewer" | "crate" | "shipped" | "machine";
  card: ViewCard;
}

/** Every clickable thing on the floor, in reading order (left to right, as the pipeline flows). */
export function sceneTargets(scene: Scene): SceneTarget[] {
  const out: SceneTarget[] = [];
  const add = (kind: SceneTarget["kind"], card: ViewCard, rect: Rect) =>
    out.push({ key: `${kind}:${card.item.id}`, kind, card, rect });
  // Tickets are small: give each a slightly larger target than its paper.
  for (const t of scene.tickets.items) {
    const r = ticketAt(t.slot);
    add("ticket", t.card, { x: r.x - 1, y: r.y - 1, w: r.w + 2, h: r.h + 2 });
  }
  for (const b of scene.builders.items) add("builder", b.card, builderCell(b.slot));
  for (const r of scene.reviewers.items) add("reviewer", r.card, reviewerCell(r.slot));
  for (const c of scene.queue.items) add("crate", c.card, queueCrate(c.slot));
  for (const s of scene.shipped.items) add("shipped", s.card, shippedCrate(s.slot));
  for (const m of scene.machines.items) add("machine", m.card, machineCell(m.slot));
  return out;
}

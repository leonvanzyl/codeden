import type { SceneAgent } from "./agents";

/**
 * The factory floor's plan (#264): a grid of 8-pixel tiles on a 384×216 canvas, laid out left to
 * right as the pipeline runs. Intake and its ticket pile, the reproduce and analyze desks, the
 * workbenches, the review desks, the merge conveyor with its CI lamp and the shipping door, then
 * the control room where the PM (and, in a dark factory, the scout and its area reviewers) sit.
 * The repair bay is the small fenced corner at the bottom left. Pure data and lookups.
 */

export const TILE = 8;
export const COLS = 48;
export const ROWS = 27;
export const SCENE_W = COLS * TILE;
export const SCENE_H = ROWS * TILE;
/** The back wall's rows; the floor starts below them. */
export const WALL_ROWS = 4;
export const WALL_H = WALL_ROWS * TILE;

export interface Tile {
  c: number;
  r: number;
}

export const tileId = (t: Tile): number => t.r * COLS + t.c;
export const sameTile = (a: Tile, b: Tile): boolean => a.c === b.c && a.r === b.r;

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** A zone of the floor, for its sign on the wall and its floor colour. */
export interface Zone {
  id: string;
  label: string;
  /** First and last column, inclusive. */
  c0: number;
  c1: number;
}

export const ZONES: Zone[] = [
  { id: "intake", label: "IN", c0: 0, c1: 5 },
  { id: "prep", label: "PREP", c0: 6, c1: 12 },
  { id: "bench", label: "BUILD", c0: 13, c1: 21 },
  { id: "review", label: "REVIEW", c0: 22, c1: 28 },
  { id: "merge", label: "MERGE", c0: 29, c1: 35 },
  { id: "ship", label: "SHIP", c0: 36, c1: 39 },
  { id: "control", label: "PM", c0: 40, c1: 47 },
];

/** Where an agent sits: one station per step zone, and single posts in the control room. */
export type StationId = "prep" | "bench" | "review" | "merge" | "ship" | "pm" | "scout" | "area";

export interface Station {
  id: StationId;
  /** Seat tiles in the order they are handed out; the agent stands here, facing the viewer. */
  seats: Tile[];
  /** Where agents wait, in order, when every seat is taken. */
  queue: Tile[];
  /** Whether a seat has a desk in front of it (on the row below). */
  desks: boolean;
  /** Where its "+N" sign goes when even the queue is full (scene pixels). */
  more: { x: number; y: number };
}

const grid = (cols: number[], rows: number[]): Tile[] =>
  rows.flatMap((r) => cols.map((c) => ({ c, r })));
const row = (c0: number, c1: number, r: number): Tile[] =>
  Array.from({ length: c1 - c0 + 1 }, (_, i) => ({ c: c0 + i, r }));

/** Desk rows: seats on 6, 11 and 16, desks in front on 7, 12 and 17; aisles in between. */
const SEAT_ROWS = [6, 11, 16];
const QUEUE_ROW = 19;

export const STATIONS: Record<StationId, Station> = {
  prep: {
    id: "prep",
    seats: grid([7, 10], SEAT_ROWS),
    queue: row(7, 10, QUEUE_ROW),
    desks: true,
    more: { x: 7 * TILE, y: 21 * TILE },
  },
  bench: {
    id: "bench",
    seats: grid([14, 17, 20], SEAT_ROWS),
    queue: row(14, 19, QUEUE_ROW),
    desks: true,
    more: { x: 15 * TILE, y: 21 * TILE },
  },
  review: {
    id: "review",
    seats: grid([24, 27], SEAT_ROWS),
    queue: row(23, 26, QUEUE_ROW),
    desks: true,
    more: { x: 23 * TILE, y: 21 * TILE },
  },
  // Beside the conveyor, the crate on the belt at the same row; 6 is next to the door.
  merge: {
    id: "merge",
    seats: [6, 9, 12, 15, 18, 21].map((r) => ({ c: 31, r })),
    queue: row(29, 31, 24),
    desks: false,
    more: { x: 29 * TILE, y: 25 * TILE + 2 },
  },
  // Merged, CI on the default branch still watched: by the shipping door.
  ship: {
    id: "ship",
    seats: [6, 10, 14].map((r) => ({ c: 37, r })),
    queue: [],
    desks: false,
    more: { x: 36 * TILE, y: 16 * TILE },
  },
  pm: { id: "pm", seats: [{ c: 44, r: 6 }], queue: [], desks: true, more: { x: 0, y: 0 } },
  scout: { id: "scout", seats: [{ c: 46, r: 11 }], queue: [], desks: false, more: { x: 0, y: 0 } },
  area: {
    id: "area",
    seats: grid([42, 45], [16, 21]),
    queue: [],
    desks: true,
    more: { x: 41 * TILE, y: 25 * TILE },
  },
};

/**
 * The station an agent works at, by its role and step: the pipeline's zone for its step. A PR
 * waiting on CI stays where it is (at the review desk, or on the conveyor); a merged one whose
 * CI is still watched stands by the shipping door.
 */
export function stationOf(a: Pick<SceneAgent, "role" | "step" | "card">): StationId {
  if (a.role === "pm" || a.role === "scout" || a.role === "area") return a.role;
  switch (a.step) {
    case "reproducing":
    case "analyzing":
      return "prep";
    case "implementing":
    case "revising":
    case "rebasing":
      return "bench";
    case "merging":
      return "merge";
    case "watching_ci":
      if (a.card?.item.stage === "watching") return "ship";
      return a.card?.item.step === "merge" ? "merge" : "review";
    default:
      return "review";
  }
}

/** The conveyor runs up into the shipping door. */
export const BELT = { c0: 33, c1: 34, r0: 5, r1: 25 };
export const SHIP_DOOR: Rect = { x: 32 * TILE, y: 6, w: 4 * TILE, h: WALL_H - 6 };
export const IN_DOOR: Rect = { x: 1 * TILE, y: 6, w: 4 * TILE, h: WALL_H - 6 };
/** The CI lamp on the wall above the merge zone. */
export const CI_LAMP: Rect = { x: 29 * TILE + 4, y: 8, w: 20, h: 18 };
/** The shipped counter on the wall by the door. */
export const COUNTER: Rect = { x: 36 * TILE + 1, y: 6, w: 30, h: 22 };
/** The budget gauge on the wall above the prep desks. */
export const GAUGE: Rect = { x: 13 * TILE - 28, y: 5, w: 26, h: 24 };
/** The ticket pallet in front of the IN door. */
export const PALLET = { c0: 1, c1: 4, r0: 5, r1: 8 };
/** Where a builder picks up its ticket: in front of the pallet. */
export const PICKUP: Tile = { c: 5, r: 9 };
/** The control room's glass wall, with a doorway near the bottom. */
export const GLASS = { c: 40, r0: WALL_ROWS, r1: ROWS - 1, door: [23, 24] };
/** The repair bay: a fenced corner, its crates in a row. */
export const BAY = { c0: 0, c1: 5, r0: 21, r1: ROWS - 1 };
export const BAY_RECT: Rect = {
  x: BAY.c0 * TILE,
  y: BAY.r0 * TILE,
  w: (BAY.c1 - BAY.c0 + 1) * TILE,
  h: (BAY.r1 - BAY.r0 + 1) * TILE,
};

/** Tiles nobody walks on: desks, the belt, the pallet, the glass wall, the repair bay. */
function furniture(): Set<number> {
  const out = new Set<number>();
  const add = (c: number, r: number) => out.add(tileId({ c, r }));
  for (const s of Object.values(STATIONS)) {
    if (!s.desks) continue;
    for (const seat of s.seats) for (let c = seat.c - 1; c <= seat.c + 1; c++) add(c, seat.r + 1);
  }
  for (let r = BELT.r0; r <= BELT.r1; r++) for (let c = BELT.c0; c <= BELT.c1; c++) add(c, r);
  for (let r = PALLET.r0; r <= PALLET.r1; r++)
    for (let c = PALLET.c0; c <= PALLET.c1; c++) add(c, r);
  for (let r = GLASS.r0; r <= GLASS.r1; r++) if (!GLASS.door.includes(r)) add(GLASS.c, r);
  for (let r = BAY.r0; r <= BAY.r1; r++) for (let c = BAY.c0; c <= BAY.c1; c++) add(c, r);
  return out;
}

const BLOCKED = furniture();

/** Whether a tile is floor someone can stand on. */
export function walkable(t: Tile): boolean {
  return t.c >= 0 && t.c < COLS && t.r >= WALL_ROWS && t.r < ROWS && !BLOCKED.has(tileId(t));
}

/** The tile in front of a seat, where someone hands it something (the aisle above it). */
export function frontOf(seat: Tile): Tile {
  return { c: seat.c, r: seat.r - 1 };
}

/** The top-left corner of a 10×14 person standing on a tile (feet on the tile's bottom edge). */
export function personAt(t: { c: number; r: number }): { x: number; y: number } {
  return { x: t.c * TILE - 1, y: t.r * TILE - 6 };
}

/** What a hit target covers for an agent on a tile: the person and its label above. */
export function agentRect(t: Tile): Rect {
  const p = personAt(t);
  return { x: p.x - 3, y: p.y - 8, w: 16, h: 22 };
}

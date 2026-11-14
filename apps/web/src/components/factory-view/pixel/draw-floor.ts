import {
  BAY_RECT,
  BELT,
  CI_LAMP,
  COUNTER,
  GAUGE,
  GLASS,
  IN_DOOR,
  PALLET,
  type Rect,
  SCENE_H,
  SCENE_W,
  SHIP_DOOR,
  TILE,
  WALL_H,
  ZONES,
} from "./floor";
import { pixelText, shadowText, textWidth } from "./font";
import { INK, prop } from "./sprites";

/**
 * The floor's static layer (#264), painted once into an offscreen canvas: the back wall with
 * each zone's sign, the doors, the gauge and counter plates and the CI lamp's housing, the floor
 * tinted per zone, the ticket pallet, the conveyor's frame, the control room's glass wall and
 * the fenced repair bay. Everything that moves is drawn over it each frame.
 */

type Ctx = CanvasRenderingContext2D;

export function fill(ctx: Ctx, r: Rect, colour: string) {
  ctx.fillStyle = colour;
  ctx.fillRect(r.x, r.y, r.w, r.h);
}

/** Floor colours per zone: two tile shades and the grout. */
const FLOOR: Record<string, [string, string, string]> = {
  intake: ["#a99f94", "#a1978c", "#8f857b"],
  prep: ["#9ba8b8", "#94a1b1", "#848fa0"],
  bench: ["#a3a9b8", "#9ba2b2", "#8c93a5"],
  review: ["#98ae9f", "#91a798", "#829788"],
  merge: ["#9a9eaa", "#9297a3", "#80858f"],
  ship: ["#a3a9b8", "#9ba2b2", "#8c93a5"],
  control: ["#3d4660", "#394159", "#2f3650"],
};

function wall(ctx: Ctx) {
  fill(ctx, { x: 0, y: 0, w: SCENE_W, h: WALL_H }, "#4a5470");
  for (let y = 4; y < WALL_H; y += 6) {
    fill(ctx, { x: 0, y, w: SCENE_W, h: 1 }, "#3d4660");
    for (let x = (y / 6) % 2 ? 0 : 6; x < SCENE_W; x += 12)
      fill(ctx, { x, y, w: 1, h: 6 }, "#3d4660");
  }
  fill(ctx, { x: 0, y: 0, w: SCENE_W, h: 3 }, "#262b44");
  fill(ctx, { x: 0, y: WALL_H - 2, w: SCENE_W, h: 2 }, "#262b44");
  // The control room's back wall: a big status board.
  const room = ZONES.find((z) => z.id === "control");
  if (room) {
    const x = room.c0 * TILE + 6;
    fill(ctx, { x, y: 5, w: (room.c1 - room.c0 + 1) * TILE - 10, h: 22 }, "#262b44");
    fill(ctx, { x: x + 2, y: 7, w: (room.c1 - room.c0 + 1) * TILE - 14, h: 18 }, "#29366f");
    for (let i = 0; i < 5; i++) fill(ctx, { x: x + 5 + i * 10, y: 10, w: 6, h: 2 }, "#73eff7");
    for (let i = 0; i < 4; i++) fill(ctx, { x: x + 5 + i * 12, y: 16, w: 8, h: 1 }, "#41a6f6");
    for (let i = 0; i < 3; i++) fill(ctx, { x: x + 5 + i * 16, y: 20, w: 10, h: 1 }, "#566c86");
  }
}

function door(ctx: Ctx, r: Rect, sign: string, colour: string, hazard: boolean) {
  fill(ctx, { x: r.x - 2, y: r.y - 2, w: r.w + 4, h: r.h + 2 }, "#262b44");
  for (let y = r.y; y < r.y + r.h; y += 3)
    fill(ctx, { x: r.x, y, w: r.w, h: 3 }, (y - r.y) % 6 === 0 ? "#8da1b3" : "#7a8ea3");
  const w = textWidth(sign) + 4;
  fill(ctx, { x: r.x + Math.floor((r.w - w) / 2), y: r.y + 2, w, h: 8 }, INK);
  shadowText(ctx, sign, r.x + Math.floor((r.w - w) / 2) + 2, r.y + 3, colour);
  if (hazard)
    for (let x = r.x; x < r.x + r.w; x += 4)
      fill(ctx, { x, y: r.y + r.h - 4, w: 2, h: 4 }, "#ffcd75");
}

function signs(ctx: Ctx) {
  // The doors and the CI lamp name their own zones.
  for (const z of ZONES) {
    if (!["prep", "bench", "review"].includes(z.id)) continue;
    const w = textWidth(z.label) + 6;
    // The budget gauge shares the prep zone's wall: its sign keeps to the left.
    const x = z.id === "prep" ? z.c0 * TILE + 2 : Math.floor(((z.c0 + z.c1 + 1) * TILE - w) / 2);
    const y = 12;
    fill(ctx, { x, y, w, h: 9 }, "#262b44");
    fill(ctx, { x: x + 1, y: y + 1, w: w - 2, h: 7 }, "#ffcd75");
    pixelText(ctx, z.label, x + 3, y + 2, INK);
  }
}

function floor(ctx: Ctx) {
  for (const z of ZONES) {
    const [a, b, grout] = FLOOR[z.id] ?? ["#a3a9b8", "#9ba2b2", "#8c93a5"];
    for (let r = WALL_H / TILE; r * TILE < SCENE_H; r++)
      for (let c = z.c0; c <= z.c1; c++) {
        const x = c * TILE;
        const y = r * TILE;
        fill(ctx, { x, y, w: TILE, h: TILE }, (c + r) % 2 ? a : b);
        fill(ctx, { x, y, w: TILE, h: 1 }, grout);
        fill(ctx, { x, y, w: 1, h: TILE }, grout);
      }
    // A dashed line where one zone ends and the next begins.
    if (z.c0 > 0 && z.id !== "control")
      for (let y = WALL_H + 2; y < SCENE_H; y += 6)
        fill(ctx, { x: z.c0 * TILE, y, w: 1, h: 3 }, "#ffcd75");
  }
  ctx.fillStyle = "rgba(0,0,0,0.18)";
  ctx.fillRect(0, WALL_H, SCENE_W, 3);
}

function pallet(ctx: Ctx) {
  const r: Rect = {
    x: PALLET.c0 * TILE,
    y: PALLET.r0 * TILE + 2,
    w: (PALLET.c1 - PALLET.c0 + 1) * TILE,
    h: (PALLET.r1 - PALLET.r0 + 1) * TILE - 2,
  };
  fill(ctx, r, INK);
  fill(ctx, { x: r.x + 1, y: r.y + 1, w: r.w - 2, h: r.h - 2 }, "#a0683a");
  for (let y = r.y + 4; y < r.y + r.h - 1; y += 5)
    fill(ctx, { x: r.x + 1, y, w: r.w - 2, h: 1 }, "#6e4527");
}

function conveyor(ctx: Ctx) {
  const x = BELT.c0 * TILE;
  const w = (BELT.c1 - BELT.c0 + 1) * TILE;
  // The belt runs from the bottom of the floor up into the shipping door.
  fill(ctx, { x: x - 1, y: WALL_H - 2, w: w + 2, h: (BELT.r1 + 1) * TILE - WALL_H + 2 }, INK);
  fill(ctx, { x, y: WALL_H - 2, w, h: (BELT.r1 + 1) * TILE - WALL_H + 1 }, "#566c86");
  for (let y = BELT.r0 * TILE; y < (BELT.r1 + 1) * TILE; y += 16)
    fill(ctx, { x: x - 2, y, w: 2, h: 3 }, "#333c57");
}

function controlRoom(ctx: Ctx) {
  const x = GLASS.c * TILE;
  for (let r = GLASS.r0; r <= GLASS.r1; r++) {
    if (GLASS.door.includes(r)) continue;
    fill(ctx, { x: x + 2, y: r * TILE, w: 4, h: TILE }, "rgba(115,239,247,0.35)");
    fill(ctx, { x: x + 2, y: r * TILE, w: 1, h: TILE }, "#262b44");
    fill(ctx, { x: x + 5, y: r * TILE, w: 1, h: TILE }, "#262b44");
  }
  for (const r of [GLASS.r0 + 3, GLASS.r0 + 10, GLASS.r0 + 17])
    fill(ctx, { x: x + 3, y: r * TILE + 2, w: 1, h: 3 }, "#f4f4f4");
}

function repairBay(ctx: Ctx) {
  const r = BAY_RECT;
  fill(ctx, r, "#5d5a52");
  for (let x = r.x; x < r.x + r.w; x += 8)
    for (let y = r.y; y < r.y + r.h; y += 8) fill(ctx, { x, y, w: 8, h: 1 }, "#4e4b44");
  // Hazard stripes along the fence.
  for (let x = r.x; x < r.x + r.w; x += 4) {
    fill(ctx, { x, y: r.y, w: 2, h: 2 }, "#ffcd75");
    fill(ctx, { x: x + 2, y: r.y, w: 2, h: 2 }, INK);
  }
  for (let y = r.y; y < r.y + r.h; y += 4) {
    fill(ctx, { x: r.x + r.w - 2, y, w: 2, h: 2 }, "#ffcd75");
    fill(ctx, { x: r.x + r.w - 2, y: y + 2, w: 2, h: 2 }, INK);
  }
  const w = textWidth("FIX") + 4;
  fill(ctx, { x: r.x + 3, y: r.y + 4, w, h: 8 }, INK);
  shadowText(ctx, "FIX", r.x + 5, r.y + 5, "#ffcd75");
}

function plates(ctx: Ctx) {
  // The budget gauge's plate and dial: green, then amber, then red.
  fill(ctx, GAUGE, "#566c86");
  fill(ctx, { x: GAUGE.x + 1, y: GAUGE.y + 1, w: GAUGE.w - 2, h: GAUGE.h - 2 }, "#262b44");
  const cx = GAUGE.x + GAUGE.w / 2;
  const cy = GAUGE.y + 17;
  for (let i = 0; i <= 40; i++) {
    const f = i / 40;
    const a = Math.PI + f * Math.PI;
    ctx.fillStyle = f < 0.6 ? "#38b764" : f < 0.85 ? "#ffcd75" : "#e43b44";
    ctx.fillRect(Math.round(cx + Math.cos(a) * 10), Math.round(cy + Math.sin(a) * 10), 1, 1);
  }
  // The CI lamp's housing and sign.
  fill(ctx, CI_LAMP, "#262b44");
  fill(ctx, { x: CI_LAMP.x + 1, y: CI_LAMP.y + 1, w: CI_LAMP.w - 2, h: CI_LAMP.h - 2 }, "#333c57");
  shadowText(ctx, "CI", CI_LAMP.x + 4, CI_LAMP.y + 11, "#f4f4f4");
  // The shipped counter: a crate, and per frame the number.
  fill(ctx, COUNTER, "#566c86");
  fill(ctx, { x: COUNTER.x + 1, y: COUNTER.y + 1, w: COUNTER.w - 2, h: COUNTER.h - 2 }, INK);
  ctx.drawImage(prop("smallCrate", "stamped"), COUNTER.x + 3, COUNTER.y + 3);
}

let layer: HTMLCanvasElement | null = null;

/** Everything that never changes, painted once. */
export function floorLayer(): HTMLCanvasElement {
  if (layer) return layer;
  const canvas = document.createElement("canvas");
  canvas.width = SCENE_W;
  canvas.height = SCENE_H;
  layer = canvas;
  const ctx = canvas.getContext("2d");
  if (!ctx) return canvas;
  wall(ctx);
  floor(ctx);
  signs(ctx);
  door(ctx, IN_DOOR, "IN", "#38b764", false);
  door(ctx, SHIP_DOOR, "SHIP", "#ffcd75", true);
  plates(ctx);
  pallet(ctx);
  conveyor(ctx);
  controlRoom(ctx);
  repairBay(ctx);
  return canvas;
}

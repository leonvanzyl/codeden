import {
  BELT,
  builderCell,
  COUNTER,
  GAUGE,
  helperCell,
  IN_DOOR,
  MORE_AT,
  machineCell,
  queueCrate,
  type Rect,
  reviewerCell,
  SCENE_H,
  SCENE_W,
  SCOUT_AISLE,
  SCOUT_HOME,
  SHIP_DOOR,
  shippedCrate,
  ticketAt,
  WALL_H,
  WINDOWS,
} from "./layout";
import type { Scene, WorkerPose } from "./scene-model";
import { pixelText, pixelTextWidth, type SpriteName, type SpriteVariant, sprite } from "./sprites";

/**
 * Paints a `Scene` on the 320×180 canvas: a static background (wall, floor, doors, belt frame),
 * then the stations, the scout, the one-off effects and, when the loop is stopped, a dim
 * overlay. `tick` counts frames at the scene's frame rate; with `animate` off it is 0 and
 * nothing moves.
 */

/** A one-off moment: a ticket carried to a bench, or a crate shipped out of the door. */
export interface SceneEffect {
  kind: "carry" | "ship";
  /** The builder slot the ticket goes to, or 0 for the crate at the door. */
  slot: number;
  start: number;
}

export const EFFECT_FRAMES: Record<SceneEffect["kind"], number> = { carry: 24, ship: 18 };

type Ctx = CanvasRenderingContext2D;

const INK = "#1a1c2c";

function put(ctx: Ctx, name: SpriteName, x: number, y: number, variant?: SpriteVariant) {
  ctx.drawImage(sprite(name, variant), Math.round(x), Math.round(y));
}

function rect(ctx: Ctx, r: Rect, colour: string) {
  ctx.fillStyle = colour;
  ctx.fillRect(r.x, r.y, r.w, r.h);
}

function door(ctx: Ctx, r: Rect, sign: string, signColour: string, hazard: boolean) {
  rect(ctx, { x: r.x - 2, y: r.y - 2, w: r.w + 4, h: r.h + 2 }, "#262b44");
  for (let y = r.y; y < r.y + r.h; y += 3)
    rect(ctx, { x: r.x, y, w: r.w, h: 3 }, (y - r.y) % 6 === 0 ? "#8da1b3" : "#7a8ea3");
  rect(ctx, { x: r.x + 6, y: r.y + 2, w: r.w - 12, h: 7 }, INK);
  const width = pixelTextWidth(sign);
  pixelText(ctx, sign, r.x + Math.floor((r.w - width) / 2), r.y + 3, signColour);
  if (hazard)
    for (let x = r.x; x < r.x + r.w; x += 4)
      rect(ctx, { x, y: r.y + r.h - 4, w: 2, h: 4 }, "#ffcd75");
}

let background: HTMLCanvasElement | null = null;

/** Everything that never changes, painted once. */
function backgroundLayer(): HTMLCanvasElement {
  if (background) return background;
  const canvas = document.createElement("canvas");
  canvas.width = SCENE_W;
  canvas.height = SCENE_H;
  const ctx = canvas.getContext("2d");
  background = canvas;
  if (!ctx) return canvas;
  // The back wall: bricks under a dark ceiling edge.
  rect(ctx, { x: 0, y: 0, w: SCENE_W, h: WALL_H }, "#4a5470");
  for (let y = 4; y < WALL_H; y += 6) {
    rect(ctx, { x: 0, y, w: SCENE_W, h: 1 }, "#3d4660");
    for (let x = (y / 6) % 2 ? 0 : 6; x < SCENE_W; x += 12)
      rect(ctx, { x, y, w: 1, h: 6 }, "#3d4660");
  }
  rect(ctx, { x: 0, y: 0, w: SCENE_W, h: 4 }, "#262b44");
  rect(ctx, { x: 0, y: WALL_H - 2, w: SCENE_W, h: 2 }, "#262b44");
  // The floor: concrete tiles, a shadow under the wall, two pools of light.
  for (let y = WALL_H; y < SCENE_H; y += 16)
    for (let x = 0; x < SCENE_W; x += 16) {
      rect(ctx, { x, y, w: 16, h: 16 }, ((x + y) / 16) % 2 ? "#a3a9b8" : "#9ba2b2");
      rect(ctx, { x, y, w: 16, h: 1 }, "#8c93a5");
      rect(ctx, { x, y, w: 1, h: 16 }, "#8c93a5");
    }
  ctx.fillStyle = "rgba(0,0,0,0.18)";
  ctx.fillRect(0, WALL_H, SCENE_W, 3);
  ctx.fillStyle = "rgba(255,255,255,0.07)";
  for (const cx of [122, 220]) {
    ctx.beginPath();
    ctx.ellipse(cx, 80, 46, 30, 0, 0, Math.PI * 2);
    ctx.fill();
  }
  // The scout's corner: a rug.
  rect(ctx, { x: 3, y: 116, w: 50, h: 60 }, "#4f3f6b");
  rect(ctx, { x: 5, y: 118, w: 46, h: 56 }, "#6b5590");
  // The repair bay along the bottom, marked in amber.
  for (let x = 62; x < 238; x += 6) {
    rect(ctx, { x, y: 133, w: 3, h: 1 }, "#ffb000");
    rect(ctx, { x, y: 178, w: 3, h: 1 }, "#ffb000");
  }
  // A safety line in front of the shipping lane.
  for (let y = WALL_H + 4; y < SCENE_H; y += 7) rect(ctx, { x: 256, y, w: 2, h: 4 }, "#ffcd75");
  // Doors and windows.
  door(ctx, IN_DOOR, "IN", "#38b764", false);
  door(ctx, SHIP_DOOR, "SHIP", "#ffcd75", true);
  for (const w of WINDOWS) {
    rect(ctx, { x: w.x - 2, y: w.y - 2, w: w.w + 4, h: w.h + 4 }, "#262b44");
    rect(ctx, w, "#41a6f6");
    rect(ctx, { x: w.x, y: w.y, w: w.w, h: 6 }, "#73eff7");
    rect(ctx, { x: w.x + w.w / 2 - 1, y: w.y, w: 2, h: w.h }, "#262b44");
    rect(ctx, { x: w.x + 3, y: w.y + 2, w: 6, h: 1 }, "#f4f4f4");
  }
  // The budget gauge's plate and dial: green, then amber, then red.
  rect(ctx, GAUGE, "#566c86");
  rect(ctx, { x: GAUGE.x + 1, y: GAUGE.y + 1, w: GAUGE.w - 2, h: GAUGE.h - 2 }, "#262b44");
  const cx = GAUGE.x + GAUGE.w / 2;
  const cy = GAUGE.y + 17;
  for (let i = 0; i <= 40; i++) {
    const f = i / 40;
    const a = Math.PI + f * Math.PI;
    ctx.fillStyle = f < 0.6 ? "#38b764" : f < 0.85 ? "#ffcd75" : "#e43b44";
    ctx.fillRect(Math.round(cx + Math.cos(a) * 10), Math.round(cy + Math.sin(a) * 10), 1, 1);
  }
  // The counter board: a crate and, per frame, the number.
  rect(ctx, COUNTER, "#566c86");
  rect(ctx, { x: COUNTER.x + 1, y: COUNTER.y + 1, w: COUNTER.w - 2, h: COUNTER.h - 2 }, INK);
  ctx.drawImage(sprite("crate", "shipped"), COUNTER.x + 4, COUNTER.y + 6);
  // The conveyor's rails and the dock's pallet.
  rect(ctx, BELT, "#566c86");
  rect(ctx, { x: 290, y: 116, w: 28, h: 3 }, "#6e4527");
  rect(ctx, { x: 290, y: 119, w: 28, h: 1 }, INK);
  return canvas;
}

function drawBelt(ctx: Ctx, tick: number) {
  rect(ctx, { x: BELT.x + 2, y: BELT.y, w: BELT.w - 4, h: BELT.h }, "#333c57");
  // Ridges that run toward the door.
  const shift = tick % 5;
  for (let y = BELT.y + 4 - shift; y < SCENE_H; y += 5)
    if (y >= BELT.y) rect(ctx, { x: BELT.x + 3, y, w: BELT.w - 6, h: 1 }, "#4a5470");
}

function drawGauge(ctx: Ctx, value: number | null, jitter: number) {
  const cx = GAUGE.x + GAUGE.w / 2;
  const cy = GAUGE.y + 17;
  const f = value === null ? 0 : Math.min(1, Math.max(0, value + jitter));
  const a = Math.PI + f * Math.PI;
  ctx.fillStyle = value === null ? "#566c86" : "#f4f4f4";
  for (let i = 0; i <= 8; i++)
    ctx.fillRect(Math.round(cx + Math.cos(a) * i), Math.round(cy + Math.sin(a) * i), 1, 1);
  rect(ctx, { x: cx - 1, y: cy - 1, w: 2, h: 2 }, "#e43b44");
}

function drawCounter(ctx: Ctx, merges: number) {
  const text = String(Math.min(999, merges));
  const width = pixelTextWidth(text, 2);
  pixelText(ctx, text, COUNTER.x + COUNTER.w - width - 4, COUNTER.y + 7, "#a7f070", 2);
}

function more(ctx: Ctx, n: number, at: { x: number; y: number }) {
  if (n <= 0) return;
  pixelText(ctx, `+${n}`, at.x + 1, at.y + 1, INK);
  pixelText(ctx, `+${n}`, at.x, at.y, "#f4f4f4");
}

/** A worker in a pose; `phase` keeps neighbours out of step. */
function worker(
  ctx: Ctx,
  x: number,
  y: number,
  role: SpriteVariant,
  pose: WorkerPose,
  tick: number,
  phase: number,
) {
  if (pose === "sit") return put(ctx, "sit", x, y + 2, role);
  const bob = pose === "work" && role !== "builder" && (tick + phase) % 12 < 6 ? 1 : 0;
  put(ctx, "stand", x, y + bob, role);
  if (pose === "ask") put(ctx, "question", x + 7, y - 9 + ((tick >> 3) % 2), "base");
  if (pose === "alert") put(ctx, "bang", x + 7, y - 9 + ((tick >> 2) % 2), "red");
}

function builders(ctx: Ctx, scene: Scene, tick: number) {
  for (const b of scene.builders.items) {
    const cell = builderCell(b.slot);
    const wx = cell.x + 13;
    const wy = cell.y + 2;
    const strike = b.pose === "work" && (tick + b.slot * 3) % 8 >= 5;
    if (b.pose === "work") put(ctx, strike ? "armDown" : "armUp", wx, wy, "builder");
    else if (b.pose !== "sit") worker(ctx, wx, wy, "builder", b.pose, tick, b.slot);
    put(ctx, "bench", cell.x + 7, cell.y + 13);
    if (b.pose === "work" && !strike) put(ctx, "hammerUp", wx + 7, wy);
    else put(ctx, "hammerDown", wx + 8, wy + 12);
    if (strike) rect(ctx, { x: wx + 12, y: wy + 10, w: 1, h: 1 }, "#ffcd75");
    if (b.pose === "sit") worker(ctx, cell.x + 2, cell.y + 14, "builder", "sit", tick, b.slot);
  }
  more(ctx, scene.builders.more, MORE_AT.builders);
}

function reviewers(ctx: Ctx, scene: Scene, tick: number) {
  for (const r of scene.reviewers.items) {
    const cell = reviewerCell(r.slot);
    put(ctx, "crate", cell.x + 2, cell.y + 14);
    const wx = cell.x + 17;
    const wy = cell.y + 8;
    worker(ctx, wx, wy, "reviewer", r.pose, tick, r.slot * 4);
    if (r.pose === "sit") continue;
    put(ctx, "clipboard", wx - 3, wy + 7);
    // The pencil ticks off the list while it inspects.
    if (r.pose === "work")
      rect(
        ctx,
        { x: wx - 2 + ((tick >> 1) % 3), y: wy + 9 + ((tick >> 3) % 2) * 2, w: 1, h: 1 },
        INK,
      );
  }
  more(ctx, scene.reviewers.more, MORE_AT.reviewers);
}

function flag(ctx: Ctx, x: number, y: number, colour: "red" | "amber", tick: number) {
  put(ctx, (tick >> 2) % 2 ? "flagA" : "flagB", x, y, colour);
}

function queue(ctx: Ctx, scene: Scene, tick: number) {
  for (const c of scene.queue.items) {
    const r = queueCrate(c.slot);
    put(ctx, "crate", r.x, r.y);
    if (c.flag) flag(ctx, r.x + 8, r.y - 7, c.flag === "failed" ? "red" : "amber", tick + c.slot);
  }
  more(ctx, scene.queue.more, MORE_AT.queue);
}

function shipped(ctx: Ctx, scene: Scene, tick: number) {
  for (const s of scene.shipped.items) {
    const r = shippedCrate(s.slot);
    put(ctx, "crate", r.x, r.y, "shipped");
    // CI on the default branch is still watched: a blinking light.
    if (s.watching && (tick >> 2) % 2 === 0)
      rect(ctx, { x: r.x + 9, y: r.y + 1, w: 2, h: 2 }, "#73eff7");
  }
  more(ctx, scene.shipped.more, MORE_AT.shipped);
}

function machines(ctx: Ctx, scene: Scene, tick: number) {
  for (const m of scene.machines.items) {
    const cell = machineCell(m.slot);
    put(ctx, "machine", cell.x + 6, cell.y + 20, m.failed ? "broken" : "base");
    const on = (tick >> (m.failed ? 2 : 3)) % 2 === 0;
    const lamp: SpriteVariant = m.failed ? (on ? "red" : "redDim") : on ? "amber" : "amberDim";
    put(ctx, "lamp", cell.x + 13, cell.y + 16, lamp);
    flag(ctx, cell.x + 24, cell.y + 8, m.failed ? "red" : "amber", tick + m.slot);
    if (!m.failed) continue;
    // Puffs of smoke rising from the top and fading.
    for (let i = 0; i < 3; i++) {
      const age = (tick + i * 6 + m.slot * 2) % 18;
      ctx.globalAlpha = 0.75 * (1 - age / 18);
      put(ctx, "smoke", cell.x + 5 + (i % 2) * 3, cell.y + 14 - age);
    }
    ctx.globalAlpha = 1;
  }
  more(ctx, scene.machines.more, MORE_AT.machines);
}

function scout(ctx: Ctx, scene: Scene, tick: number) {
  const s = scene.scout;
  if (!s) return;
  for (const h of s.helpers) {
    const cell = helperCell(h.slot);
    const wx = cell.x + 5;
    const wy = cell.y + 2;
    if (scene.stopped) {
      worker(ctx, wx, wy, "helper", "sit", tick, h.slot);
      continue;
    }
    put(ctx, "stand", wx, wy, "helper");
    put(ctx, "notepad", wx + 6, wy + 8);
    if (h.state === "writing")
      rect(ctx, { x: wx + 7 + ((tick >> 1) % 2), y: wy + 10, w: 1, h: 1 }, INK);
    if (h.state === "done") put(ctx, "check", wx + 3, wy - 6);
  }
  if (scene.stopped || !s.walking) {
    worker(ctx, SCOUT_HOME.x, SCOUT_HOME.y, "scout", scene.stopped ? "sit" : "idle", tick, 0);
    put(ctx, "magnifier", SCOUT_HOME.x + 8, SCOUT_HOME.y + 6);
    return;
  }
  // Up and down the aisle between the benches and the repair bay, a pixel per frame.
  const span = SCOUT_AISLE.x1 - SCOUT_AISLE.x0;
  const p = tick % (span * 2);
  const right = p < span;
  const x = SCOUT_AISLE.x0 + (right ? p : span * 2 - p);
  put(ctx, (tick >> 2) % 2 ? "walkA" : "walkB", x, SCOUT_AISLE.y, "scout");
  put(ctx, "magnifier", right ? x + 8 : x - 3, SCOUT_AISLE.y + 6);
}

function tickets(ctx: Ctx, scene: Scene) {
  for (const t of scene.tickets.items) {
    const r = ticketAt(t.slot);
    put(ctx, "ticket", r.x, r.y, t.tint);
  }
  more(ctx, scene.tickets.more, MORE_AT.tickets);
}

function effects(ctx: Ctx, list: readonly SceneEffect[], tick: number) {
  for (const e of list) {
    const age = tick - e.start;
    if (age < 0 || age >= EFFECT_FRAMES[e.kind]) continue;
    const f = age / EFFECT_FRAMES[e.kind];
    if (e.kind === "carry") {
      // From the pile to the bench, the ticket held up high.
      const to = builderCell(e.slot);
      const x = 24 + (to.x + 13 - 24) * f;
      const y = 44 + (to.y + 2 - 44) * f;
      put(ctx, (age >> 2) % 2 ? "walkA" : "walkB", x, y, "builder");
      put(ctx, "ticket", x + 1, y - 5, "paper");
      continue;
    }
    // Out through the shipping door, then a sparkle.
    const from = queueCrate(0);
    const door = SHIP_DOOR;
    if (f < 0.5) {
      rect(ctx, { x: door.x + 6, y: door.y + 10, w: door.w - 12, h: door.h - 10 }, INK);
      put(ctx, "crate", from.x, from.y - (from.y - door.y - 14) * (f * 2));
    } else {
      const big = (age >> 1) % 2 === 0;
      put(ctx, big ? "sparkleA" : "sparkleB", door.x + door.w / 2 - 2, door.y + 4);
      put(ctx, big ? "sparkleB" : "sparkleA", door.x + 4, door.y + 12);
      put(ctx, big ? "sparkleA" : "sparkleB", door.x + door.w - 9, door.y + 14);
    }
  }
}

/** A "CLOSED" board hung across the IN door while the factory drains. */
function closedSign(ctx: Ctx) {
  const r = IN_DOOR;
  const text = "CLOSED";
  const w = pixelTextWidth(text) + 6;
  const x = r.x + Math.floor((r.w - w) / 2);
  const y = r.y + Math.floor(r.h / 2) - 2;
  rect(ctx, { x: x - 1, y: y - 1, w: w + 2, h: 11 }, INK);
  rect(ctx, { x, y, w, h: 9 }, "#e43b44");
  pixelText(ctx, text, x + 3, y + 2, "#f4f4f4");
}

/** Paint the whole scene for frame `tick`. */
export function drawScene(
  ctx: Ctx,
  scene: Scene,
  tick: number,
  list: readonly SceneEffect[],
  animate: boolean,
) {
  const t = animate ? tick : 0;
  const moving = animate && !scene.stopped;
  ctx.imageSmoothingEnabled = false;
  ctx.globalAlpha = 1;
  ctx.drawImage(backgroundLayer(), 0, 0);
  drawBelt(ctx, moving ? t : 0);
  drawGauge(ctx, scene.gauge, moving ? Math.sin(t / 3) * 0.01 : 0);
  drawCounter(ctx, scene.mergesToday);
  tickets(ctx, scene);
  builders(ctx, scene, moving ? t : 0);
  reviewers(ctx, scene, moving ? t : 0);
  queue(ctx, scene, t);
  shipped(ctx, scene, t);
  scout(ctx, scene, moving ? t : 0);
  machines(ctx, scene, t);
  if (moving) effects(ctx, list, t);
  // Draining: the IN door is closed; the work on the floor carries on.
  if (scene.draining !== null && !scene.stopped) closedSign(ctx);
  if (scene.stopped) {
    // The lights go down.
    ctx.fillStyle = "rgba(10,12,28,0.55)";
    ctx.fillRect(0, 0, SCENE_W, SCENE_H);
  }
}

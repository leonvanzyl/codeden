import { drawAgents } from "./draw-agents";
import { fill, floorLayer } from "./draw-floor";
import {
  BAY_RECT,
  BELT,
  CI_LAMP,
  COUNTER,
  GAUGE,
  PALLET,
  type Rect,
  SCENE_H,
  SCENE_W,
  SHIP_DOOR,
  STATIONS,
  type StationId,
  TILE,
  WALL_H,
} from "./floor";
import { pixelText, shadowText, textWidth } from "./font";
import type { Figure, Fx } from "./motion";
import type { BayCrate } from "./repair-bay";
import type { Scene } from "./scene-model";
import { type GlyphName, glyph, INK, prop } from "./sprites";

/**
 * Paints a frame of the factory floor (#264) on the 384×216 canvas: the static layer, then the
 * moving belt, the wall's gauge, CI lamp and shipped counter, the tickets at intake, the crates
 * on the conveyor and in the repair bay, the agents and their desks, the one-off effects, and
 * the dim overlay when the loop is stopped. `tick` counts frames; with `animate` off it is 0 and
 * nothing moves.
 */

type Ctx = CanvasRenderingContext2D;

/** Where the repair bay's crates sit (scene pixels), first to last. */
export function bayCrateRect(i: number): Rect {
  return { x: BAY_RECT.x + 3 + i * 14, y: BAY_RECT.y + 24, w: 12, h: 12 };
}

/** Where intake's tickets lie on the pallet. */
export function ticketRect(slot: number): Rect {
  return {
    x: PALLET.c0 * TILE + 2 + (slot % 4) * 7,
    y: PALLET.r0 * TILE + 5 + Math.floor(slot / 4) * 9,
    w: 7,
    h: 5,
  };
}

const BAY_GLYPH: Record<BayCrate["kind"], GlyphName> = {
  retry: "revising",
  stuck: "rebasing",
  merge: "merging",
};

function belt(ctx: Ctx, tick: number) {
  const x = BELT.c0 * TILE + 1;
  const w = (BELT.c1 - BELT.c0 + 1) * TILE - 2;
  const top = WALL_H - 2;
  const bottom = (BELT.r1 + 1) * TILE;
  fill(ctx, { x, y: top, w, h: bottom - top }, "#333c57");
  // Ridges run up toward the shipping door.
  const shift = tick % 5;
  for (let y = top + 4 - shift; y < bottom; y += 5)
    if (y >= top) fill(ctx, { x: x + 1, y, w: w - 2, h: 1 }, "#4a5470");
}

function wallFigures(ctx: Ctx, scene: Scene, tick: number, moving: boolean) {
  // The gauge's needle, trembling a little while the floor runs.
  const cx = GAUGE.x + GAUGE.w / 2;
  const cy = GAUGE.y + 17;
  const jitter = moving ? Math.sin(tick / 3) * 0.01 : 0;
  const v = scene.gauge === null ? 0 : Math.min(1, Math.max(0, scene.gauge + jitter));
  const a = Math.PI + v * Math.PI;
  ctx.fillStyle = scene.gauge === null ? "#566c86" : "#f4f4f4";
  for (let i = 0; i <= 8; i++)
    ctx.fillRect(Math.round(cx + Math.cos(a) * i), Math.round(cy + Math.sin(a) * i), 1, 1);
  fill(ctx, { x: cx - 1, y: cy - 1, w: 2, h: 2 }, "#e43b44");
  // The CI lamp: amber and blinking while CI runs, green otherwise.
  const on = !moving || (tick >> 2) % 2 === 0;
  ctx.drawImage(
    prop("lamp", scene.ciRunning ? (on ? "amber" : "dim") : "green"),
    CI_LAMP.x + 8,
    CI_LAMP.y + 3,
  );
  // The shipped counter.
  const text = String(Math.min(999, scene.shipped));
  pixelText(ctx, text, COUNTER.x + COUNTER.w - textWidth(text, 2) - 3, COUNTER.y + 6, "#a7f070", 2);
}

function tickets(ctx: Ctx, scene: Scene) {
  for (const t of scene.tickets.items) {
    const r = ticketRect(t.slot);
    ctx.drawImage(prop("ticket", t.tint), r.x, r.y);
  }
  more(ctx, scene.tickets.more, { x: PALLET.c1 * TILE + 9, y: PALLET.r1 * TILE + 4 });
}

/** A crate on the conveyor beside each agent waiting there to merge. */
function beltCrates(ctx: Ctx, scene: Scene, figures: readonly Figure[]) {
  for (const f of figures) {
    if (!f.seated || f.ghost) continue;
    const seat = scene.seating.seats.get(f.agent.key);
    if (seat?.station !== "merge" || seat.queued) continue;
    ctx.drawImage(prop("crate", "stamped"), BELT.c0 * TILE + 2, seat.tile.r * TILE - 4);
  }
}

function bay(ctx: Ctx, scene: Scene, tick: number) {
  scene.bay.forEach((crate, i) => {
    const r = bayCrateRect(i);
    ctx.drawImage(prop("crate"), r.x, r.y);
    glyph(
      ctx,
      BAY_GLYPH[crate.kind],
      r.x + 4,
      r.y + 5,
      crate.kind === "merge" ? "#ffcd75" : "#e43b44",
    );
    // The count badge, blinking gently.
    const n = String(Math.min(99, crate.entries.length));
    const w = textWidth(n) + 4;
    fill(
      ctx,
      { x: r.x + r.w - w + 3, y: r.y - 5, w, h: 7 },
      (tick >> 3) % 2 ? "#e43b44" : "#b13e53",
    );
    pixelText(ctx, n, r.x + r.w - w + 5, r.y - 4, "#f4f4f4");
  });
}

function more(ctx: Ctx, n: number, at: { x: number; y: number }) {
  if (n > 0) shadowText(ctx, `+${n}`, at.x, at.y, "#f4f4f4");
}

function effects(ctx: Ctx, list: readonly Fx[], tick: number) {
  for (const e of list) {
    const age = tick - e.start;
    if (age < 0 || age >= e.frames) continue;
    const f = age / e.frames;
    if (e.kind === "ship") {
      const x = BELT.c0 * TILE + 2;
      if (f < 0.6) {
        // Up the belt and in through the door.
        const y = e.y + (SHIP_DOOR.y + 10 - e.y) * (f / 0.6);
        ctx.drawImage(prop("crate", "stamped"), x, Math.round(y));
      } else {
        const big = (age >> 1) % 2 === 0;
        ctx.drawImage(
          prop(big ? "sparkleA" : "sparkleB"),
          SHIP_DOOR.x + SHIP_DOOR.w / 2 - 2,
          SHIP_DOOR.y + 4,
        );
        ctx.drawImage(prop(big ? "sparkleB" : "sparkleA"), SHIP_DOOR.x + 3, SHIP_DOOR.y + 12);
        ctx.drawImage(prop(big ? "sparkleA" : "sparkleB"), COUNTER.x + 20, COUNTER.y + 14);
      }
      continue;
    }
    ctx.globalAlpha = Math.max(0, 1 - f);
    if (e.kind === "poof") ctx.drawImage(prop("poof"), e.x + 2, e.y + 4);
    else
      for (let i = 0; i < 4; i++)
        ctx.drawImage(prop("smoke"), e.x - 2 + (i % 2) * 7, e.y + 2 - age / 2 - i * 3);
    ctx.globalAlpha = 1;
  }
}

/** Paints the whole scene for frame `tick`. */
export function drawScene(
  ctx: Ctx,
  scene: Scene,
  figures: readonly Figure[],
  fx: readonly Fx[],
  tick: number,
  animate: boolean,
) {
  const t = animate ? tick : 0;
  const moving = animate && !scene.stopped;
  ctx.imageSmoothingEnabled = false;
  ctx.globalAlpha = 1;
  ctx.drawImage(floorLayer(), 0, 0);
  belt(ctx, moving ? t : 0);
  wallFigures(ctx, scene, t, moving);
  tickets(ctx, scene);
  beltCrates(ctx, scene, figures);
  bay(ctx, scene, t);
  drawAgents(ctx, scene, figures, moving ? t : 0);
  for (const [station, n] of Object.entries(scene.seating.more))
    more(ctx, n ?? 0, STATIONS[station as StationId].more);
  if (moving) effects(ctx, fx, t);
  if (scene.stopped) {
    // The lights go down.
    ctx.fillStyle = "rgba(10,12,28,0.55)";
    ctx.fillRect(0, 0, SCENE_W, SCENE_H);
  }
  ctx.fillStyle = INK;
}

import type { AgentStatus, SceneAgent } from "./agents";
import { SCENE_W, STATIONS, type StationId, TILE, tileId } from "./floor";
import { pixelText, textWidth } from "./font";
import type { Figure } from "./motion";
import { accessory, headDrop, lookOf, type Pose, person, seedHash } from "./people";
import type { Scene } from "./scene-model";
import { type GlyphName, glyph, INK, type PropName, painted, prop } from "./sprites";

/**
 * Paints the agents (#264): each person in a pose for its state (typing at a desk while it
 * works, a thought bubble while it thinks, a raised hand and "!" while it waits for approval, a
 * red sweat drop when blocked, arms up on a merge, slumped after a failure, small fidgets when
 * idle), its role's accessory, what it carries, and above it a label with its issue number and
 * a glyph for its step. Desks are drawn in the same depth order, so a seated agent sits behind
 * its desk.
 */

type Ctx = CanvasRenderingContext2D;

const DESK: Partial<Record<StationId, PropName>> = {
  prep: "deskPrep",
  bench: "deskBench",
  review: "deskReview",
  pm: "console",
  area: "deskPrep",
};

export const STATUS_COLOUR: Record<AgentStatus, string> = {
  working: "#a7f070",
  thinking: "#73eff7",
  approval: "#ffcd75",
  blocked: "#e43b44",
  done: "#38b764",
  idle: "#94b0c2",
};

const AREA_SHORT: Record<string, string> = {
  features: "FEAT",
  ux: "UX",
  performance: "PERF",
  tech_debt: "CODE",
  test_gaps: "TEST",
  security: "SEC",
  bugs: "BUGS",
  docs: "DOCS",
};

/** The label's text and glyph: the issue number and the step, or the role. */
export function labelOf(a: SceneAgent): { text: string; glyph: GlyphName } {
  if (a.role === "pm") return { text: "PM", glyph: "pm" };
  if (a.role === "scout") return { text: "SCOUT", glyph: "scout" };
  if (a.role === "area") return { text: AREA_SHORT[a.area ?? ""] ?? "AREA", glyph: "area" };
  // The issue number (a pull request without an issue: "P" and its number), kept short so
  // neighbours' labels don't touch.
  const w = a.card?.item;
  const pr = w?.pr?.number ?? w?.ownedPr?.number;
  const text = w?.issue ? String(w.issue.number) : pr ? `P${pr}` : "?";
  return { text, glyph: a.step ?? "implementing" };
}

function label(ctx: Ctx, a: SceneAgent, cx: number, y: number) {
  const { text, glyph: g } = labelOf(a);
  const colour = STATUS_COLOUR[a.status];
  const w = textWidth(text) + 9;
  const img = painted(`label:${text}:${g}:${colour}`, w, 9, (c) => {
    c.fillStyle = INK;
    c.fillRect(1, 0, w - 2, 9);
    c.fillRect(0, 1, w, 7);
    pixelText(c, text, 2, 2, "#f4f4f4");
    glyph(c, g, w - 6, 2, colour);
  });
  const x = Math.min(SCENE_W - w - 1, Math.max(1, Math.round(cx - w / 2)));
  ctx.drawImage(img, x, Math.round(y));
}

/** The pose for a figure this frame. `phase` keeps neighbours out of step. */
export function poseOf(fig: Figure, tick: number, stopped: boolean): Pose {
  const phase = seedHash(fig.agent.seed) % 32;
  if (stopped || fig.slumped || fig.agent.failed) return "slump";
  if (fig.walking) return (tick >> 1) & 1 ? "walkA" : "walkB";
  if (fig.stamping) return (tick >> 1) & 1 ? "raise" : "stand";
  if (fig.cheering) return (tick >> 2) & 1 ? "cheer" : "stand";
  switch (fig.agent.status) {
    case "working":
      return fig.atDesk ? (((tick + phase) >> 1) & 1 ? "typeA" : "typeB") : "stand";
    case "approval":
      return "raise";
    default:
      // A small fidget now and then: a foot tapped.
      return (tick + phase * 7) % 48 < 4 ? "fidget" : "stand";
  }
}

function bubble(ctx: Ctx, fig: Figure, x: number, y: number, tick: number) {
  const a = fig.agent;
  const phase = seedHash(a.seed) % 16;
  if (fig.slumped || a.failed) {
    // A wisp of smoke now and then.
    const age = (tick + phase) % 24;
    if (age < 12) {
      ctx.globalAlpha = 0.7 * (1 - age / 12);
      ctx.drawImage(prop("smoke"), x + 3, y - age / 2);
      ctx.globalAlpha = 1;
    }
    return;
  }
  if (fig.walking || fig.stamping) return;
  // The PM's headset light blinks while it answers.
  if (a.role === "pm" && a.status === "working" && (tick >> 2) & 1) {
    ctx.fillStyle = "#e43b44";
    ctx.fillRect(x + 3, y + 6, 1, 1);
  }
  if (fig.cheering) {
    const colours = ["#ffcd75", "#41a6f6", "#e43b44", "#38b764"];
    for (let i = 0; i < 6; i++) {
      ctx.fillStyle = colours[i % 4] as string;
      ctx.fillRect(x - 3 + ((i * 5 + tick) % 16), y - 4 + ((i * 3 + tick * 2) % 10), 1, 1);
    }
    return;
  }
  switch (a.status) {
    case "thinking": {
      ctx.drawImage(prop("thought"), x + 9, y);
      // The dots light up in turn.
      const dot = (tick >> 2) % 3;
      ctx.fillStyle = INK;
      ctx.fillRect(x + 11 + dot * 2, y + 2, 1, 1);
      return;
    }
    case "approval":
      ctx.drawImage(prop("bang"), x + 11, y - 1 + ((tick >> 3) & 1));
      return;
    case "blocked": {
      // A red sweat drop slides down the side of its head.
      const slide = ((tick + phase) >> 1) % 6;
      ctx.drawImage(prop("sweatRed"), x + 8, y + 1 + slide);
      return;
    }
    case "done":
      ctx.drawImage(prop("check"), x + 9, y - 2);
      return;
    default:
      return;
  }
}

function held(ctx: Ctx, fig: Figure, pose: Pose, x: number, y: number, tick: number) {
  if (fig.carry === "crate") return ctx.drawImage(prop("smallCrate"), x + 1, y + 7);
  if (fig.carry === "ticket") return ctx.drawImage(prop("ticket"), x + 2, y + 8);
  if (fig.stamping) {
    ctx.drawImage(prop("smallCrate", (tick >> 2) & 1 ? "stamped" : "base"), x + 1, y + 8);
    ctx.drawImage(prop("stamp", "red"), x + 3, y + 3 + ((tick >> 1) & 1) * 2);
    return;
  }
  if (fig.atDesk || pose === "slump") return;
  const role = fig.agent.role;
  if (role === "reviewer") ctx.drawImage(prop("clipboard"), x + 6, y + 8);
  if (role === "area" || role === "scout") ctx.drawImage(prop("magnifier"), x + 7, y + 6);
}

interface Drawable {
  base: number;
  draw: () => void;
}

/** Desks, with a crate on the ones whose agent works on a pull request. */
function desks(ctx: Ctx, busy: Set<number>): Drawable[] {
  const out: Drawable[] = [];
  for (const station of Object.values(STATIONS)) {
    const name = DESK[station.id];
    if (!station.desks || !name) continue;
    for (const seat of station.seats) {
      const x = (seat.c - 1) * TILE;
      const y = seat.r * TILE + 2;
      out.push({
        base: (seat.r + 2) * TILE,
        draw: () => {
          ctx.drawImage(prop(name), x, y);
          if (busy.has(tileId(seat)) && (station.id === "bench" || station.id === "review"))
            ctx.drawImage(prop("smallCrate"), x + (station.id === "bench" ? 2 : 15), y - 4);
        },
      });
    }
  }
  return out;
}

/** Paints every figure and desk in depth order, then labels and bubbles on top. */
export function drawAgents(ctx: Ctx, scene: Scene, figures: readonly Figure[], tick: number) {
  const busy = new Set<number>();
  for (const f of figures)
    if (f.atDesk && f.agent.card && f.agent.status !== "blocked") {
      const seat = scene.seating.seats.get(f.agent.key);
      if (seat) busy.add(tileId(seat.tile));
    }
  const list = desks(ctx, busy);
  const poses = figures.map((f) => poseOf(f, tick, scene.stopped));
  figures.forEach((f, i) => {
    const pose = poses[i] as Pose;
    const jump = pose === "cheer" ? -2 : 0;
    list.push({
      base: f.y + 14,
      draw: () => {
        const look = lookOf(f.agent.seed, f.agent.role);
        ctx.drawImage(person(look, pose), f.x, f.y + jump);
        accessory(ctx, f.agent.role, pose, f.x, f.y + jump, f.agent.area);
        held(ctx, f, pose, f.x, f.y + jump, tick);
      },
    });
  });
  list.sort((a, b) => a.base - b.base);
  for (const d of list) d.draw();
  figures.forEach((f, i) => {
    const dy = headDrop(poses[i] as Pose);
    if (!scene.stopped) bubble(ctx, f, f.x, f.y + dy, tick);
    if (!f.ghost) label(ctx, f.agent, f.x + 5, f.y + dy - 10);
  });
}

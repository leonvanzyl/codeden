import type { CSSProperties } from "react";
import type { ViewCard } from "../stages";
import type { SceneAgent } from "./agents";
import { bayCrateRect, ticketRect } from "./draw";
import { agentRect, type Rect, SCENE_H, SCENE_W } from "./floor";
import type { BayCrate } from "./repair-bay";
import type { Scene } from "./scene-model";

/**
 * Everything on the floor the pointer can hover and the keyboard can reach (#264): each ticket
 * at intake, each seated or queued agent, each repair bay crate. The scene puts a transparent
 * button over each, in reading order (left to right, as the pipeline flows).
 */
export type SceneTarget =
  | { kind: "ticket"; key: string; rect: Rect; card: ViewCard }
  | { kind: "agent"; key: string; rect: Rect; agent: SceneAgent }
  | { kind: "bay"; key: string; rect: Rect; crate: BayCrate };

export function sceneTargets(scene: Scene): SceneTarget[] {
  const out: SceneTarget[] = [];
  for (const t of scene.tickets.items) {
    const r = ticketRect(t.slot);
    out.push({
      kind: "ticket",
      key: `ticket:${t.card.item.id}`,
      rect: { x: r.x - 1, y: r.y - 1, w: r.w + 2, h: r.h + 2 },
      card: t.card,
    });
  }
  const seated = scene.agents
    .map((agent) => ({ agent, seat: scene.seating.seats.get(agent.key) }))
    .filter((x) => x.seat !== undefined);
  // Left to right, then top to bottom.
  seated.sort(
    (a, b) =>
      (a.seat?.tile.c ?? 0) - (b.seat?.tile.c ?? 0) ||
      (a.seat?.tile.r ?? 0) - (b.seat?.tile.r ?? 0),
  );
  for (const { agent, seat } of seated)
    if (seat)
      out.push({ kind: "agent", key: `agent:${agent.key}`, rect: agentRect(seat.tile), agent });
  scene.bay.forEach((crate, i) => {
    const r = bayCrateRect(i);
    out.push({
      kind: "bay",
      key: `bay:${crate.kind}`,
      rect: { x: r.x - 1, y: r.y - 6, w: r.w + 4, h: r.h + 7 },
      crate,
    });
  });
  return out;
}

/** A rect in scene pixels as percentages of the scene, for overlays that scale with it. */
export const pct = (r: Rect): CSSProperties => ({
  left: `${(r.x / SCENE_W) * 100}%`,
  top: `${(r.y / SCENE_H) * 100}%`,
  width: `${(r.w / SCENE_W) * 100}%`,
  height: `${(r.h / SCENE_H) * 100}%`,
});

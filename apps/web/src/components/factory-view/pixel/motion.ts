import type { SceneAgent } from "./agents";
import { PICKUP, personAt, STATIONS, type Tile, tileId } from "./floor";
import type { Scene, Transition } from "./scene-model";
import {
  arrived,
  GIVE_UP_AFTER,
  nearestFree,
  startWalker,
  stepWalkers,
  type Walker,
  walkerTile,
} from "./walk";

/**
 * The floor's motion between data refreshes (#264): who walks where, the one-off moments (a
 * stamp, a celebration, a slump, a crate riding out) and where to draw everyone this frame.
 * Movement only comes from `sceneEvents` transitions; nothing wanders. Walkers step one tile
 * every `STEP_FRAMES` frames through `stepWalkers`, so nobody shares a tile or walks through
 * anyone; an agent whose seat is still taken by someone on their way out waits off the floor.
 */

export const STEP_FRAMES = 2;
const STAMP_FRAMES = 8;
const CHEER_FRAMES = 24;
const STILL_FRAMES = 30;

interface Mover {
  walker: Walker;
  /** The tile before its last step, to slide between tiles. */
  prev: Tile;
  agent: SceneAgent;
  /** A departed agent acting out its exit (a builder walking a crate over): leaves when done. */
  ghost: boolean;
  carry: "crate" | "ticket" | null;
  /** Frames to stand still first (stamping the crate). */
  delay: number;
  /** A second leg: where it walks back to. */
  back: Tile | null;
  celebrate: boolean;
}

/** A departed agent standing where it was: celebrating its merge, or slumped after a failure. */
interface Still {
  agent: SceneAgent;
  tile: Tile;
  kind: "cheer" | "slump";
  until: number;
}

export interface Fx {
  kind: "ship" | "smoke" | "poof";
  x: number;
  y: number;
  start: number;
  frames: number;
}

/** One person to draw this frame. */
export interface Figure {
  agent: SceneAgent;
  x: number;
  y: number;
  /** At its seat, behind its desk when the station has desks. */
  seated: boolean;
  atDesk: boolean;
  walking: boolean;
  stamping: boolean;
  cheering: boolean;
  slumped: boolean;
  carry: "crate" | "ticket" | null;
  /** A departed agent: no label, no hit target. */
  ghost: boolean;
}

const lerp = (a: number, b: number, f: number) => Math.round(a + (b - a) * f);

export class FloorMotion {
  private movers: Mover[] = [];
  private stills: Still[] = [];
  private cheers = new Map<string, number>();
  fx: Fx[] = [];
  private stepTick = 0;

  /** Someone walks or a moment plays: every frame counts. Otherwise only idle animations run. */
  get busy(): boolean {
    return (
      this.movers.length > 0 || this.stills.length > 0 || this.fx.length > 0 || this.cheers.size > 0
    );
  }
  private ghosts = 0;

  /** Tiles of agents sitting still in the scene (not walking), plus departed agents standing. */
  private occupied(scene: Scene): Set<number> {
    const walking = new Set(this.movers.filter((m) => !m.ghost).map((m) => m.walker.key));
    const out = new Set<number>();
    for (const [key, seat] of scene.seating.seats)
      if (!walking.has(key)) out.add(tileId(seat.tile));
    for (const s of this.stills) out.add(tileId(s.tile));
    return out;
  }

  private walk(
    scene: Scene,
    key: string,
    from: Tile,
    to: Tile,
    m: Partial<Mover> & { agent: SceneAgent },
  ) {
    this.movers = this.movers.filter((x) => x.walker.key !== key);
    const blocked = this.occupied(scene);
    blocked.delete(tileId(to));
    const walker = startWalker(key, from, to, blocked);
    this.movers.push({
      walker,
      prev: walker.path[0] ?? from,
      ghost: false,
      carry: null,
      delay: 0,
      back: null,
      celebrate: false,
      ...m,
    });
  }

  /** Act out the moments between the previous scene and `scene`. */
  play(scene: Scene, events: readonly Transition[], tick: number) {
    const agentOf = (key: string) => scene.agents.find((a) => a.key === key);
    for (const e of events) {
      if (e.kind === "move" || e.kind === "arrive") {
        const agent = agentOf(e.key);
        if (!agent) continue;
        const current = this.movers.find((m) => m.walker.key === e.key);
        const from = current ? walkerTile(current.walker) : e.kind === "move" ? e.from : PICKUP;
        this.walk(scene, e.key, from, e.to, {
          agent,
          carry: e.kind === "arrive" ? "ticket" : e.carry,
          delay: e.kind === "move" && e.stamp ? STAMP_FRAMES : 0,
          celebrate: e.kind === "move" && e.celebrate,
        });
      } else if (e.kind === "handoff") {
        const blocked = this.occupied(scene);
        const to = nearestFree(e.to, blocked) ?? e.to;
        this.ghosts += 1;
        this.walk(scene, `ghost:${this.ghosts}`, e.from, to, {
          agent: e.agent,
          ghost: true,
          carry: "crate",
          back: e.from,
        });
      } else if (e.kind === "ship") {
        const x = (STATIONS.merge.seats[0]?.c ?? 31) * 8 + 16;
        this.fx.push({ kind: "ship", x, y: e.row * 8 - 6, start: tick, frames: 30 });
      } else if (e.kind === "celebrate") {
        this.stills.push({ agent: e.agent, tile: e.at, kind: "cheer", until: tick + CHEER_FRAMES });
      } else if (e.kind === "fail") {
        const p = personAt(e.at);
        this.fx.push({ kind: "smoke", x: p.x, y: p.y, start: tick, frames: 24 });
        if (!e.stays)
          this.stills.push({
            agent: e.agent,
            tile: e.at,
            kind: "slump",
            until: tick + STILL_FRAMES,
          });
      }
    }
  }

  /** One frame: expire moments, and every few frames step everyone who walks. */
  advance(scene: Scene, tick: number) {
    this.fx = this.fx.filter((f) => tick - f.start < f.frames);
    this.stills = this.stills.filter((s) => s.until > tick);
    for (const [key, until] of this.cheers) if (until <= tick) this.cheers.delete(key);
    const keys = new Set(scene.agents.map((a) => a.key));
    this.movers = this.movers.filter((m) => m.ghost || keys.has(m.walker.key));
    for (const m of this.movers) if (m.delay > 0) m.delay -= 1;
    if (tick - this.stepTick < STEP_FRAMES) return;
    this.stepTick = tick;
    // Most frames nobody walks.
    if (this.movers.length === 0) return;
    const ready = this.movers.filter((m) => m.delay === 0);
    const stepped = stepWalkers(
      ready.map((m) => m.walker),
      this.occupied(scene),
    );
    ready.forEach((m, i) => {
      m.prev = walkerTile(m.walker);
      m.walker = stepped[i] as Walker;
    });
    const done: Mover[] = [];
    for (const m of ready) {
      const stuck = m.walker.waited >= GIVE_UP_AFTER;
      if (!arrived(m.walker) && !stuck) continue;
      if (stuck)
        this.fx.push({ kind: "poof", ...personAt(walkerTile(m.walker)), start: tick, frames: 8 });
      if (m.back && !stuck) {
        const here = walkerTile(m.walker);
        const blocked = this.occupied(scene);
        // Its bench may have a new builder already: it goes as near as it can, then leaves.
        const back = blocked.has(tileId(m.back)) ? (nearestFree(m.back, blocked) ?? here) : m.back;
        m.walker = startWalker(m.walker.key, here, back, blocked);
        m.prev = here;
        m.back = null;
        m.carry = null;
        continue;
      }
      if (m.celebrate) this.cheers.set(m.walker.key, tick + CHEER_FRAMES);
      done.push(m);
    }
    this.movers = this.movers.filter((m) => !done.includes(m));
  }

  /** Everyone to draw this frame, where they are. */
  figures(scene: Scene, tick: number): Figure[] {
    const f = Math.min(1, (tick - this.stepTick) / STEP_FRAMES);
    const out: Figure[] = [];
    const taken = new Set<number>();
    const base = { seated: false, atDesk: false, stamping: false, cheering: false, slumped: false };
    for (const m of this.movers) {
      const at = walkerTile(m.walker);
      taken.add(tileId(at));
      const from = personAt(m.prev);
      const to = personAt(at);
      out.push({
        ...base,
        agent: m.agent,
        x: lerp(from.x, to.x, f),
        y: lerp(from.y, to.y, f),
        walking: m.delay === 0 && !arrived(m.walker),
        stamping: m.delay > 0,
        carry: m.carry,
        ghost: m.ghost,
      });
    }
    for (const s of this.stills) {
      taken.add(tileId(s.tile));
      out.push({
        ...base,
        agent: s.agent,
        ...personAt(s.tile),
        walking: false,
        cheering: s.kind === "cheer",
        slumped: s.kind === "slump",
        carry: null,
        ghost: true,
      });
    }
    const moving = new Set(this.movers.map((m) => m.walker.key));
    for (const a of scene.agents) {
      const seat = scene.seating.seats.get(a.key);
      if (!seat || moving.has(a.key) || taken.has(tileId(seat.tile))) continue;
      out.push({
        ...base,
        agent: a,
        ...personAt(seat.tile),
        seated: true,
        atDesk: !seat.queued && STATIONS[seat.station].desks,
        walking: false,
        cheering: this.cheers.has(a.key),
        carry: null,
        ghost: false,
      });
    }
    return out;
  }
}

/** The figures of a still scene: everyone at their seat (reduced motion, first paint). */
export function stillFigures(scene: Scene): Figure[] {
  return new FloorMotion().figures(scene, 0);
}

import { COLS, ROWS, type Tile, tileId, walkable } from "./floor";

/**
 * Walking on the floor (#264): shortest paths over walkable tiles (breadth-first, four
 * directions), and one step at a time for everyone who walks, so nobody ever walks through
 * anyone. A walker only steps into a tile that no seated agent occupies and no other walker
 * stands on or has just stepped into; otherwise it waits, and after a few blocked steps looks
 * for a way around. Pure.
 */

const DIRS = [
  [0, -1],
  [0, 1],
  [-1, 0],
  [1, 0],
] as const;

/**
 * The shortest path from `from` to `to` (both included), avoiding `blocked` tiles; null when
 * there is none. `from` itself may be blocked (it is where the walker stands).
 */
export function findPath(from: Tile, to: Tile, blocked: ReadonlySet<number>): Tile[] | null {
  if (from.c === to.c && from.r === to.r) return [from];
  if (!walkable(to) || blocked.has(tileId(to))) return null;
  const came = new Map<number, number>([[tileId(from), -1]]);
  const queue: Tile[] = [from];
  const goal = tileId(to);
  for (let i = 0; i < queue.length; i++) {
    const at = queue[i] as Tile;
    for (const [dc, dr] of DIRS) {
      const next = { c: at.c + dc, r: at.r + dr };
      const id = tileId(next);
      if (came.has(id) || !walkable(next) || (blocked.has(id) && id !== goal)) continue;
      came.set(id, tileId(at));
      if (id === goal) return unwind(came, id);
      queue.push(next);
    }
  }
  return null;
}

function unwind(came: ReadonlyMap<number, number>, end: number): Tile[] {
  const path: Tile[] = [];
  for (let id = end; id !== -1; id = came.get(id) ?? -1)
    path.unshift({ c: id % COLS, r: Math.floor(id / COLS) });
  return path;
}

/** The nearest walkable tile to `t` that isn't blocked (itself when it is free). */
export function nearestFree(t: Tile, blocked: ReadonlySet<number>): Tile | null {
  const seen = new Set<number>([tileId(t)]);
  const queue: Tile[] = [t];
  for (let i = 0; i < queue.length && i < COLS * ROWS; i++) {
    const at = queue[i] as Tile;
    if (walkable(at) && !blocked.has(tileId(at))) return at;
    for (const [dc, dr] of DIRS) {
      const next = { c: at.c + dc, r: at.r + dr };
      if (next.c < 0 || next.c >= COLS || next.r < 0 || next.r >= ROWS) continue;
      if (seen.has(tileId(next))) continue;
      seen.add(tileId(next));
      queue.push(next);
    }
  }
  return null;
}

export interface Walker {
  key: string;
  /** From where it started (or last re-planned) to its goal. */
  path: Tile[];
  /** Its index on the path: where it stands. */
  at: number;
  /** Steps it has waited in a row. */
  waited: number;
}

/** After this many blocked steps a walker looks for another way. */
export const REPATH_AFTER = 3;
/** After this many, it gives up walking (the scene puts it straight on its goal). */
export const GIVE_UP_AFTER = 36;

export const walkerTile = (w: Walker): Tile => w.path[w.at] as Tile;
export const walkerGoal = (w: Walker): Tile => w.path[w.path.length - 1] as Tile;
export const arrived = (w: Walker): boolean => w.at >= w.path.length - 1;

export function startWalker(key: string, from: Tile, to: Tile, blocked: ReadonlySet<number>) {
  const path = findPath(from, to, blocked) ?? [from, to];
  return { key, path, at: 0, waited: 0 } satisfies Walker;
}

/**
 * One step for every walker, in order. `occupied` holds the tiles of agents standing still.
 * Every walker's tile counts as taken for the whole step (even one that moves off it), so two
 * walkers never meet on a tile or swap through each other. When two walkers block each other,
 * the later one in the list gives way (looks for another route) and the earlier one waits, so
 * they don't both step aside the same way forever.
 */
export function stepWalkers(walkers: readonly Walker[], occupied: ReadonlySet<number>): Walker[] {
  const claimed = new Set(walkers.map((w) => tileId(walkerTile(w))));
  const standing = new Map(walkers.map((w, i) => [tileId(walkerTile(w)), i]));
  return walkers.map((w, i) => {
    if (arrived(w)) return w;
    const next = w.path[w.at + 1] as Tile;
    const id = tileId(next);
    if (!occupied.has(id) && !claimed.has(id)) {
      claimed.add(id);
      return { ...w, at: w.at + 1, waited: 0 };
    }
    const waited = w.waited + 1;
    const blocker = standing.get(id);
    const blockerWalker = blocker === undefined ? undefined : walkers[blocker];
    // Anyone gives way after waiting a while: the other may have no way around.
    const yields =
      blocker === undefined ||
      blocker < i ||
      (blockerWalker !== undefined && arrived(blockerWalker)) ||
      waited >= 2 * REPATH_AFTER;
    if (yields && waited % REPATH_AFTER === 0) {
      const around = new Set([...occupied, ...claimed]);
      around.delete(tileId(walkerTile(w)));
      const path = findPath(walkerTile(w), walkerGoal(w), around);
      if (path && path.length > 1) return { ...w, path, at: 0, waited };
    }
    return { ...w, waited };
  });
}

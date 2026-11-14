import { describe, expect, it } from "vitest";
import {
  STATIONS,
  type StationId,
  type Tile,
  tileId,
  walkable,
} from "@/components/factory-view/pixel/floor";
import {
  assignSeats,
  type Seating,
  type SeatRequest,
  sameSeating,
} from "@/components/factory-view/pixel/seating";
import {
  arrived,
  findPath,
  GIVE_UP_AFTER,
  startWalker,
  stepWalkers,
  type Walker,
  walkerTile,
} from "@/components/factory-view/pixel/walk";

/**
 * Issue #264: the floor follows the pipeline, every agent sits at its station, positions are
 * stable across refreshes, and nobody shares a tile or walks through anyone.
 */

const ask = (key: string, station: StationId): SeatRequest => ({ key, station });
const many = (n: number, station: StationId, prefix = station) =>
  Array.from({ length: n }, (_, i) => ask(`${prefix}-${i}`, station));

function tilesOf(s: Seating): number[] {
  return [...s.seats.values()].map((seat) => tileId(seat.tile));
}

function expectNoSharedTiles(s: Seating) {
  const tiles = tilesOf(s);
  expect(new Set(tiles).size).toBe(tiles.length);
}

describe("pixel floor plan (#264)", () => {
  it("lays the stations out left to right as the pipeline runs", () => {
    const x = (id: StationId) => Math.min(...STATIONS[id].seats.map((t) => t.c));
    const order: StationId[] = ["prep", "bench", "review", "merge", "ship", "pm"];
    const xs = order.map(x);
    expect([...xs].sort((a, b) => a - b)).toEqual(xs);
  });

  it("can reach every seat and queue tile from every other", () => {
    const tiles = Object.values(STATIONS).flatMap((s) => [...s.seats, ...s.queue]);
    for (const t of tiles) expect(walkable(t)).toBe(true);
    const from = STATIONS.prep.seats[0] as Tile;
    for (const t of tiles) expect(findPath(from, t, new Set())).not.toBeNull();
  });
});

describe("pixel seating (#264)", () => {
  it("seats each agent at its station, in seat order", () => {
    const s = assignSeats(null, [ask("a", "prep"), ask("b", "bench"), ask("c", "review")]);
    expect([...s.seats.entries()].map(([k, v]) => [k, v.station, v.tile, v.queued])).toEqual([
      ["a", "prep", STATIONS.prep.seats[0], false],
      ["b", "bench", STATIONS.bench.seats[0], false],
      ["c", "review", STATIONS.review.seats[0], false],
    ]);
  });

  it("queues agents in front of a full station, then counts the rest as +N", () => {
    const seats = STATIONS.bench.seats.length;
    const queue = STATIONS.bench.queue.length;
    const s = assignSeats(null, many(seats + queue + 3, "bench"));
    const placed = [...s.seats.values()];
    expect(placed.filter((x) => !x.queued)).toHaveLength(seats);
    expect(placed.filter((x) => x.queued).map((x) => x.tile)).toEqual(STATIONS.bench.queue);
    expect(s.more).toEqual({ bench: 3 });
    expectNoSharedTiles(s);
  });

  it("never puts two agents on one tile, however crowded every station is", () => {
    const stations = Object.keys(STATIONS) as StationId[];
    const s = assignSeats(
      null,
      stations.flatMap((id) => many(20, id)),
    );
    expectNoSharedTiles(s);
  });

  it("keeps everyone where they are when the same agents come again", () => {
    const agents = [...many(4, "bench"), ...many(3, "review"), ...many(14, "prep")];
    const first = assignSeats(null, agents);
    const again = assignSeats(first, agents);
    expect(sameSeating(first, again)).toBe(true);
    // The order of the data doesn't matter either.
    expect(sameSeating(first, assignSeats(first, [...agents].reverse()))).toBe(true);
  });

  it("doesn't move the others when an agent arrives or leaves", () => {
    const agents = many(5, "bench");
    const first = assignSeats(null, agents);
    const without = assignSeats(
      first,
      agents.filter((a) => a.key !== "bench-1"),
    );
    for (const a of agents.filter((x) => x.key !== "bench-1"))
      expect(without.seats.get(a.key)).toEqual(first.seats.get(a.key));
    // A newcomer takes the first free seat: the one that was freed.
    const back = assignSeats(without, [
      ...agents.filter((a) => a.key !== "bench-1"),
      ask("new", "bench"),
    ]);
    expect(back.seats.get("new")?.tile).toEqual(first.seats.get("bench-1")?.tile);
    for (const a of agents.filter((x) => x.key !== "bench-1"))
      expect(back.seats.get(a.key)).toEqual(first.seats.get(a.key));
  });

  it("gives a freed seat to the first in the queue", () => {
    const n = STATIONS.review.seats.length;
    const agents = many(n + 2, "review");
    const first = assignSeats(null, agents);
    expect(first.seats.get(`review-${n}`)?.queued).toBe(true);
    const next = assignSeats(first, agents.slice(1));
    expect(next.seats.get(`review-${n}`)).toMatchObject({
      queued: false,
      tile: STATIONS.review.seats[0],
    });
    expect(next.seats.get(`review-${n + 1}`)).toMatchObject({
      queued: true,
      tile: STATIONS.review.queue[0],
    });
  });

  it("moves an agent to a new seat when its step changes station", () => {
    const first = assignSeats(null, [ask("a", "bench"), ask("b", "bench")]);
    const next = assignSeats(first, [ask("a", "review"), ask("b", "bench")]);
    expect(next.seats.get("a")?.station).toBe("review");
    expect(next.seats.get("b")).toEqual(first.seats.get("b"));
  });
});

/** Steps walkers until all arrive (or a limit), checking every step that no two share a tile. */
function walkAll(walkers: Walker[], occupied: Set<number>, limit = 400) {
  let now = walkers;
  for (let i = 0; i < limit && !now.every(arrived); i++) {
    const before = new Map(now.map((x) => [x.key, tileId(walkerTile(x))]));
    now = stepWalkers(now, occupied);
    const tiles = now.map((x) => tileId(walkerTile(x)));
    expect(new Set(tiles).size).toBe(tiles.length);
    for (const t of tiles) expect(occupied.has(t)).toBe(false);
    // Nobody swaps places with another walker in one step.
    for (const x of now)
      for (const y of now)
        if (x.key !== y.key && before.get(x.key) === tileId(walkerTile(y)))
          expect(before.get(y.key)).not.toBe(tileId(walkerTile(x)));
  }
  return now;
}

describe("pixel walking (#264)", () => {
  it("finds a path around desks and the conveyor, one tile at a time", () => {
    const from = STATIONS.bench.seats[0] as Tile;
    const to = STATIONS.ship.seats[0] as Tile;
    const path = findPath(from, to, new Set()) ?? [];
    expect(path[0]).toEqual(from);
    expect(path.at(-1)).toEqual(to);
    for (let i = 1; i < path.length; i++) {
      const a = path[i - 1] as Tile;
      const b = path[i] as Tile;
      expect(Math.abs(a.c - b.c) + Math.abs(a.r - b.r)).toBe(1);
      expect(walkable(b)).toBe(true);
    }
  });

  it("waits rather than walk into a seated agent, and goes around it", () => {
    const from = { c: 12, r: 9 };
    const to = { c: 12, r: 14 };
    const sitting = new Set([tileId({ c: 12, r: 11 })]);
    const walker = { key: "a", path: findPath(from, to, new Set()) ?? [], at: 0, waited: 0 };
    const [done] = walkAll([walker], sitting);
    expect(done && walkerTile(done)).toEqual(to);
  });

  it("lets two walkers meet head-on without sharing a tile or swapping through each other", () => {
    const a = { c: 12, r: 5 };
    const b = { c: 12, r: 20 };
    const walkers = [startWalker("a", a, b, new Set()), startWalker("b", b, a, new Set())];
    const done = walkAll(walkers, new Set());
    expect(done.map(walkerTile)).toEqual([b, a]);
  });

  it("keeps a crowd of walkers apart on their way across the floor", () => {
    const seats = [...STATIONS.bench.seats, ...STATIONS.review.seats, ...STATIONS.prep.seats];
    const goals = [...STATIONS.merge.seats, ...STATIONS.ship.seats, ...STATIONS.bench.queue];
    const walkers = seats
      .slice(0, goals.length)
      .map((from, i) => startWalker(`w${i}`, from, goals[i] as Tile, new Set()));
    const done = walkAll(walkers, new Set(), 600);
    expect(done.every(arrived)).toBe(true);
    // Nobody waited long enough to give up and be put on its seat.
    expect(Math.max(...done.map((x) => x.waited))).toBeLessThan(GIVE_UP_AFTER);
  });
});

import type { SceneAgent } from "./agents";
import { STATIONS, type StationId, type Tile, tileId } from "./floor";

/**
 * Who sits where (#264). Every agent gets a seat at the station for its step; a session keeps
 * its seat while its station stays the same, so nothing jumps between refreshes. New agents
 * take the first free seat; when the seats are full they wait on the station's queue tiles, in
 * order, and past those they only count toward the station's "+N". Seats and queue tiles are
 * distinct tiles, so two agents never share one. Pure: the result depends only on the previous
 * seating and the agents.
 */

export interface Seat {
  station: StationId;
  tile: Tile;
  /** Waiting in the station's queue rather than at a seat. */
  queued: boolean;
}

export interface Seating {
  /** By agent key; agents past the queue have none. */
  seats: ReadonlyMap<string, Seat>;
  /** Agents with no tile, per station: the "+N" signs. */
  more: Partial<Record<StationId, number>>;
}

export const NO_SEATING: Seating = { seats: new Map(), more: {} };

/** An agent and the station its step puts it at (`stationOf`). */
export interface SeatRequest {
  key: SceneAgent["key"];
  station: StationId;
}

export function assignSeats(prev: Seating | null, agents: readonly SeatRequest[]): Seating {
  const seats = new Map<string, Seat>();
  const taken = new Set<number>();
  const more: Partial<Record<StationId, number>> = {};
  const want = agents.map((a, order) => ({ key: a.key, station: a.station, order }));
  const place = (key: string, seat: Seat) => {
    seats.set(key, seat);
    taken.add(tileId(seat.tile));
  };

  // Seated agents whose station didn't change keep their seat.
  for (const w of want) {
    const was = prev?.seats.get(w.key);
    if (was && !was.queued && was.station === w.station) place(w.key, was);
  }

  // Then the queue, in its order (the first in line gets a freed seat first), then newcomers.
  const queuePos = (w: (typeof want)[number]) => {
    const was = prev?.seats.get(w.key);
    if (!was?.queued || was.station !== w.station) return Number.POSITIVE_INFINITY;
    return STATIONS[w.station].queue.findIndex((t) => tileId(t) === tileId(was.tile));
  };
  const rest = want
    .filter((w) => !seats.has(w.key))
    .map((w) => ({ ...w, pos: queuePos(w) }))
    .sort((a, b) => (a.pos === b.pos ? a.order - b.order : a.pos - b.pos));
  for (const w of rest) {
    const station = STATIONS[w.station];
    const free = (t: Tile) => !taken.has(tileId(t));
    const seat = station.seats.find(free);
    if (seat) {
      place(w.key, { station: w.station, tile: seat, queued: false });
      continue;
    }
    const spot = station.queue.find(free);
    if (spot) {
      place(w.key, { station: w.station, tile: spot, queued: true });
      continue;
    }
    more[w.station] = (more[w.station] ?? 0) + 1;
  }
  return { seats, more };
}

/** Whether two seatings put everyone in the same place. */
export function sameSeating(a: Seating, b: Seating): boolean {
  if (a.seats.size !== b.seats.size) return false;
  for (const [key, s] of a.seats) {
    const t = b.seats.get(key);
    if (!t || t.station !== s.station || t.queued !== s.queued || tileId(t.tile) !== tileId(s.tile))
      return false;
  }
  const stations = new Set([...Object.keys(a.more), ...Object.keys(b.more)]) as Set<StationId>;
  for (const s of stations) if ((a.more[s] ?? 0) !== (b.more[s] ?? 0)) return false;
  return true;
}

import type { EventEnvelope, NewEvent, RawEventEnvelope } from "@codeden/contracts";
import { and, asc, gt, inArray, isNull, max, or } from "drizzle-orm";
import type { Db } from "../db/client";
import { events } from "../db/schema";
import { DbProjectionReader, type Tx } from "./projection-db";
import { applyProjection } from "./projector";
import type { ProjectionReader } from "./reducer/types";

type Listener = (events: RawEventEnvelope[]) => void;

/**
 * Append-only event log (§6). `append` writes events, their projections and any derived
 * domain events in one transaction, then notifies subscribers (the UI WebSocket hub) after
 * commit. Listeners must not append synchronously (defer with `queueMicrotask`), so every
 * listener sees batches in seq order.
 */
export class EventStore {
  private readonly listeners = new Set<Listener>();

  constructor(private readonly db: Db) {}

  /** Highest seq in the log (0 when empty). */
  headSeq(): number {
    const row = this.db
      .select({ seq: max(events.seq) })
      .from(events)
      .get();
    return row?.seq ?? 0;
  }

  /**
   * Append events atomically. `extra` runs inside the same transaction (e.g. to advance a
   * runner's acked seq), so either everything is stored or nothing is.
   */
  append(newEvents: NewEvent[], extra?: (tx: Tx) => void): RawEventEnvelope[] {
    if (newEvents.length === 0 && !extra) return [];
    return this.transact(() => newEvents, extra);
  }

  /**
   * Like `append`, but the events are computed inside the transaction from the current
   * projections (for changes that depend on state, e.g. provider process lifecycle).
   */
  appendFrom(
    build: (reader: ProjectionReader) => NewEvent[],
    extra?: (tx: Tx) => void,
  ): RawEventEnvelope[] {
    return this.appendSteps([build], extra);
  }

  /**
   * Several `appendFrom` builds in one transaction (and one commit), in order: each build sees
   * the projections as the builds before it left them.
   */
  appendSteps(
    builds: ((reader: ProjectionReader) => NewEvent[])[],
    extra?: (tx: Tx) => void,
  ): RawEventEnvelope[] {
    if (builds.length === 0 && !extra) return [];
    const ts = new Date().toISOString();
    const stored = this.db.transaction((tx) => {
      const out: RawEventEnvelope[] = [];
      const reader = new DbProjectionReader(tx);
      for (const build of builds) {
        for (const event of build(reader)) insertAndProject(tx, event, ts, out);
      }
      extra?.(tx);
      return out;
    });
    this.notify(stored);
    return stored;
  }

  /** Events with `seq > afterSeq`, oldest first. Session filter keeps global events too. */
  listAfter(afterSeq: number, limit = 1000, sessionIds?: string[]): RawEventEnvelope[] {
    const sessionFilter =
      sessionIds && sessionIds.length > 0
        ? or(isNull(events.sessionId), inArray(events.sessionId, sessionIds))
        : undefined;
    return this.db
      .select()
      .from(events)
      .where(and(gt(events.seq, afterSeq), sessionFilter))
      .orderBy(asc(events.seq))
      .limit(limit)
      .all();
  }

  /** Subscribe to committed events; returns an unsubscribe function. */
  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private transact(build: (tx: Tx) => NewEvent[], extra?: (tx: Tx) => void): RawEventEnvelope[] {
    const ts = new Date().toISOString();
    const stored = this.db.transaction((tx) => {
      const out: RawEventEnvelope[] = [];
      for (const event of build(tx)) insertAndProject(tx, event, ts, out);
      extra?.(tx);
      return out;
    });
    this.notify(stored);
    return stored;
  }

  private notify(stored: RawEventEnvelope[]): void {
    if (stored.length > 0) for (const listener of this.listeners) listener(stored);
  }
}

function insertAndProject(tx: Tx, event: NewEvent, ts: string, out: RawEventEnvelope[]): void {
  const row = tx
    .insert(events)
    .values({ sessionId: event.sessionId, type: event.type, payload: event.payload, ts })
    .returning({ seq: events.seq })
    .get();
  const envelope = { ...event, seq: row.seq, ts } as EventEnvelope;
  out.push(envelope);
  for (const derived of applyProjection(tx, envelope)) insertAndProject(tx, derived, ts, out);
}

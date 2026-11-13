import {
  agentEventToNewEvent,
  type NewEvent,
  type RawEventEnvelope,
  type RunnerEventMessage,
} from "@codeden/contracts";
import { eq } from "drizzle-orm";
import type { Db } from "../db/client";
import { runnerState } from "../db/schema";
import { derivedEvents } from "./projection-db";
import { reduceProcessEvent } from "./reducer/process";
import type { ProjectionReader } from "./reducer/types";
import type { EventStore } from "./store";

/**
 * Server events produced by one durable runner event (pure apart from the reader). `recordId`
 * is the runner's `runners` record (omitted for the home runner).
 */
export function runnerEventToNewEvents(
  reader: ProjectionReader,
  msg: RunnerEventMessage,
  runnerId: string,
  recordId?: string,
): NewEvent[] {
  const event = msg.event;
  switch (event.kind) {
    case "agent":
      return [agentEventToNewEvent(event.sessionId, event.event)];
    case "session.process":
      return derivedEvents(reduceProcessEvent(reader, event, msg.seq, msg.ts));
    case "workspace.setup":
      if (!reader.getSession(event.sessionId)) return [];
      return [
        {
          type: "session.setup",
          sessionId: event.sessionId,
          payload: {
            sessionId: event.sessionId,
            step: {
              command: event.command,
              status: event.status,
              output: event.output ?? "",
              updatedAt: msg.ts,
            },
          },
        },
      ];
    case "checkpoint.created":
      if (!reader.getSession(event.sessionId)) return [];
      return [
        {
          type: "checkpoint.created",
          sessionId: event.sessionId,
          payload: {
            checkpoint: {
              sessionId: event.sessionId,
              index: event.index,
              ref: event.ref,
              commit: event.commit,
              turnId: event.turnId ?? null,
              createdAt: msg.ts,
            },
          },
        },
      ];
    case "pty.exited":
      return [
        {
          type: "pty.exited",
          sessionId: null,
          payload: { ptyId: event.ptyId, exitCode: event.exitCode },
        },
      ];
    case "runner.draining":
      return [
        {
          type: "runner.draining",
          sessionId: null,
          payload: { ...(recordId ? { id: recordId } : {}), runnerId, reason: event.reason },
        },
      ];
  }
}

export interface IngestResult {
  /** False when the event was already stored (replayed after a reconnect). */
  stored: boolean;
  events: RawEventEnvelope[];
  /** Seq to acknowledge to the runner. */
  ackSeq: number;
}

/** Highest runner seq durably stored for `runnerId`. */
export function lastAckedSeq(db: Db, runnerId: string): number {
  return (
    db.select().from(runnerState).where(eq(runnerState.runnerId, runnerId)).get()?.lastAckedSeq ?? 0
  );
}

/**
 * The event pipeline (§4.2, §6): store one runner event and its projections, and advance the
 * runner's acked seq in the same transaction. Idempotent by runner seq: replays at or below
 * the stored position are acknowledged without storing anything again.
 */
export function ingestRunnerEvent(
  db: Db,
  store: EventStore,
  runnerId: string,
  msg: RunnerEventMessage,
  recordId?: string,
): IngestResult {
  if (msg.seq <= lastAckedSeq(db, runnerId)) {
    return { stored: false, events: [], ackSeq: msg.seq };
  }
  const now = new Date().toISOString();
  const events = store.appendFrom(
    (reader) => runnerEventToNewEvents(reader, msg, runnerId, recordId),
    (tx) => {
      tx.insert(runnerState)
        .values({ runnerId, lastAckedSeq: msg.seq, updatedAt: now })
        .onConflictDoUpdate({
          target: runnerState.runnerId,
          set: { lastAckedSeq: msg.seq, updatedAt: now },
        })
        .run();
    },
  );
  return { stored: true, events, ackSeq: msg.seq };
}

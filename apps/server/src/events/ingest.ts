import {
  agentEventToNewEvent,
  type NewEvent,
  type RawEventEnvelope,
  type RunnerEvent,
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

/** The session a runner event is about; `null` for runner-level events. */
export function runnerEventSessionId(event: RunnerEvent): string | null {
  switch (event.kind) {
    case "agent":
    case "session.process":
    case "workspace.setup":
    case "checkpoint.created":
      return event.sessionId;
    case "pty.exited":
    case "runner.draining":
      return null;
  }
}

/**
 * Why a runner that isn't trusted (any but the home runner: a sandbox runner shares its sandbox
 * with an agent that has a shell) may not write this event, or `null` when it may. An event
 * that names a session must name one routed to that runner: one whose `sessions.runnerId` is
 * its journal id `runnerId`. The server checks at `welcome` that no other runner record carries
 * that id (`runner/identity.ts`), so that is exactly the sessions it sends to this runner.
 */
export function foreignSessionRefusal(
  reader: ProjectionReader,
  event: RunnerEvent,
  runnerId: string,
): string | null {
  const sessionId = runnerEventSessionId(event);
  if (sessionId === null) return null;
  const session = reader.getSession(sessionId)?.session;
  if (!session) return `session ${sessionId} does not exist`;
  if (session.runnerId !== runnerId) return `session ${sessionId} is not routed to this runner`;
  return null;
}

/** Who sent a runner event, beyond its journal id. */
export interface RunnerEventSource {
  /** The runner's `runners` record, stamped on its `runner.*` events (omitted: the home runner). */
  recordId?: string;
  /**
   * The runner's messages are untrusted input (every runner but the home runner): events for
   * sessions not routed to it are dropped (`foreignSessionRefusal`).
   */
  untrusted?: boolean;
}

export interface IngestResult {
  /** False when the event was already stored (replayed after a reconnect) or refused. */
  stored: boolean;
  events: RawEventEnvelope[];
  /** Seq to acknowledge to the runner. */
  ackSeq: number;
  /** Why an untrusted runner's event was dropped (acknowledged, never stored). */
  refused?: string;
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
 * the stored position are acknowledged without storing anything again. An untrusted runner's
 * event for a session not routed to it advances the acked seq too (so it is not redelivered),
 * but stores nothing.
 */
export function ingestRunnerEvent(
  db: Db,
  store: EventStore,
  runnerId: string,
  msg: RunnerEventMessage,
  source: RunnerEventSource = {},
): IngestResult {
  if (msg.seq <= lastAckedSeq(db, runnerId)) {
    return { stored: false, events: [], ackSeq: msg.seq };
  }
  const now = new Date().toISOString();
  // Set inside the transaction; `as` keeps TypeScript from narrowing it to `null` here.
  let refused = null as string | null;
  const events = store.appendFrom(
    (reader) => {
      refused = source.untrusted ? foreignSessionRefusal(reader, msg.event, runnerId) : null;
      return refused ? [] : runnerEventToNewEvents(reader, msg, runnerId, source.recordId);
    },
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
  if (refused) return { stored: false, events: [], ackSeq: msg.seq, refused };
  return { stored: true, events, ackSeq: msg.seq };
}

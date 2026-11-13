import type { AgentEvent, RawEventEnvelope, TranscriptMessage } from "@codeden/contracts";
import { and, eq, inArray } from "drizzle-orm";
import type { Db } from "../db/client";
import { rowToItemRecord, rowToThread, rowToTurn } from "../db/rows";
import { items, sessions, threads, turns } from "../db/schema";
import { turnsOldestFirst } from "../db/turn-order";
import { type ArtifactLookup, clientItemRecord } from "../services/sessions/client-items";

/** Transcript rows of one session touched by events, waiting to be sent. */
export interface Dirty {
  threads: Set<string>;
  turns: Set<string>;
  items: Set<string>;
  usage: boolean;
  /** Highest event seq folded in. */
  seq: number;
}

export function emptyDirty(): Dirty {
  return { threads: new Set(), turns: new Set(), items: new Set(), usage: false, seq: 0 };
}

export function isDirty(d: Dirty): boolean {
  return d.threads.size + d.turns.size + d.items.size > 0 || d.usage;
}

/**
 * Record which transcript rows `events` touched for `sessionId`, optionally limited to
 * `threadIds` (child threads started from a watched thread are still announced). Pure apart
 * from mutating `dirty`.
 */
export function collectDirty(
  dirty: Dirty,
  events: RawEventEnvelope[],
  sessionId: string,
  threadIds?: ReadonlySet<string>,
): void {
  for (const e of events) {
    if (e.sessionId !== sessionId || !e.type.startsWith("agent.")) continue;
    const event = e.payload as AgentEvent;
    const watched = (id: string) => !threadIds || threadIds.has(id);
    switch (event.type) {
      case "thread.started": {
        const parent = event.thread.parentThreadId;
        if (watched(event.thread.id) || (parent !== undefined && watched(parent))) {
          dirty.threads.add(event.thread.id);
        }
        break;
      }
      case "turn.started":
      case "turn.completed":
      case "turn.failed":
      case "turn.interrupted":
        if (watched(event.threadId)) dirty.turns.add(event.turnId);
        break;
      case "item.started":
      case "item.updated":
      case "item.completed":
        if (watched(event.threadId)) dirty.items.add(event.item.id);
        break;
      case "item.delta":
        if (watched(event.threadId)) dirty.items.add(event.itemId);
        break;
      case "usage.updated":
        dirty.usage = true;
        if (event.turnId && watched(event.threadId)) dirty.turns.add(event.turnId);
        break;
      case "session.updated":
        break;
    }
    dirty.seq = Math.max(dirty.seq, e.seq);
  }
}

/**
 * Load the latest state of dirty rows as a `transcript` message (outputs previewed, image
 * paths mapped to artifacts, see `clientItemRecord`).
 */
export function loadTranscript(
  db: Db,
  sessionId: string,
  dirty: Dirty,
  artifacts: ArtifactLookup,
): TranscriptMessage {
  const ids = (set: Set<string>) => [...set];
  const msg: TranscriptMessage = {
    type: "transcript",
    sessionId,
    seq: dirty.seq,
    threads:
      dirty.threads.size === 0
        ? []
        : db
            .select()
            .from(threads)
            .where(and(eq(threads.sessionId, sessionId), inArray(threads.id, ids(dirty.threads))))
            .all()
            .map(rowToThread),
    turns:
      dirty.turns.size === 0
        ? []
        : db
            .select()
            .from(turns)
            .where(and(eq(turns.sessionId, sessionId), inArray(turns.id, ids(dirty.turns))))
            .orderBy(...turnsOldestFirst)
            .all()
            .map(rowToTurn),
    items:
      dirty.items.size === 0
        ? []
        : db
            .select()
            .from(items)
            .where(and(eq(items.sessionId, sessionId), inArray(items.id, ids(dirty.items))))
            .all()
            .map((r) => clientItemRecord(rowToItemRecord(r), artifacts))
            .sort((a, b) => a.position - b.position),
  };
  if (dirty.usage) {
    const usage = db
      .select({ usage: sessions.usage })
      .from(sessions)
      .where(eq(sessions.id, sessionId))
      .get()?.usage;
    if (usage) msg.usage = usage;
  }
  return msg;
}

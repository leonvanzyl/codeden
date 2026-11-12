import type { InboxItem, ItemRecord, NewEvent, Thread } from "@codeden/contracts";
import { and, eq, inArray, max } from "drizzle-orm";
import type { Db } from "../db/client";
import { rowToInbox, rowToItemRecord, rowToSession, rowToTurnRecord } from "../db/rows";
import { inboxItems, items, sessions, threads, turns } from "../db/schema";
import { indexItem } from "../services/search/index-writer";
import type { Mutation, ProjectionReader, SessionRecord, TurnRecord } from "./reducer/types";

/** A transaction handle from `db.transaction`. */
export type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

const REQUEST_KINDS = ["approval_request", "user_question"];

/** `ProjectionReader` over the database, used inside the append transaction. */
export class DbProjectionReader implements ProjectionReader {
  constructor(private readonly tx: Tx) {}

  getSession(sessionId: string): SessionRecord | undefined {
    const row = this.tx.select().from(sessions).where(eq(sessions.id, sessionId)).get();
    return row ? { session: rowToSession(row), usage: row.usage ?? null } : undefined;
  }

  getThread(sessionId: string, threadId: string): Thread | undefined {
    return this.tx
      .select()
      .from(threads)
      .where(and(eq(threads.sessionId, sessionId), eq(threads.id, threadId)))
      .get();
  }

  getTurn(sessionId: string, turnId: string): TurnRecord | undefined {
    const row = this.tx
      .select()
      .from(turns)
      .where(and(eq(turns.sessionId, sessionId), eq(turns.id, turnId)))
      .get();
    return row ? rowToTurnRecord(row) : undefined;
  }

  getItem(sessionId: string, itemId: string): ItemRecord | undefined {
    const row = this.tx
      .select()
      .from(items)
      .where(and(eq(items.sessionId, sessionId), eq(items.id, itemId)))
      .get();
    return row ? rowToItemRecord(row) : undefined;
  }

  nextItemPosition(sessionId: string, threadId: string): number {
    const row = this.tx
      .select({ n: max(items.position) })
      .from(items)
      .where(and(eq(items.sessionId, sessionId), eq(items.threadId, threadId)))
      .get();
    return row?.n === null || row?.n === undefined ? 0 : row.n + 1;
  }

  openRequestItems(sessionId: string): ItemRecord[] {
    return this.tx
      .select()
      .from(items)
      .where(
        and(
          eq(items.sessionId, sessionId),
          inArray(items.kind, REQUEST_KINDS),
          eq(items.status, "in_progress"),
        ),
      )
      .all()
      .map(rowToItemRecord);
  }

  getInbox(inboxId: string): InboxItem | undefined {
    const row = this.tx.select().from(inboxItems).where(eq(inboxItems.id, inboxId)).get();
    return row ? rowToInbox(row) : undefined;
  }

  openInboxForSession(sessionId: string): InboxItem[] {
    return this.tx
      .select()
      .from(inboxItems)
      .where(and(eq(inboxItems.sessionId, sessionId), eq(inboxItems.status, "open")))
      .all()
      .map(rowToInbox);
  }
}

/**
 * Write transcript mutations (threads, turns, items) and session usage. Session and inbox rows
 * are written by the domain events derived from the same mutations (`derivedEvents`), so
 * the global event stream carries every entity change.
 *
 * Items are also written to the transcript search index unless `index` is false: streaming
 * deltas skip it, so a growing message is indexed when it starts, updates and completes rather
 * than on every token.
 */
export function applyMutations(
  tx: Tx,
  mutations: Mutation[],
  { index = true }: { index?: boolean } = {},
): void {
  for (const m of mutations) {
    switch (m.type) {
      case "thread":
        tx.insert(threads)
          .values(m.thread)
          .onConflictDoUpdate({ target: [threads.sessionId, threads.id], set: m.thread })
          .run();
        break;
      case "turn":
        tx.insert(turns)
          .values(m.turn)
          .onConflictDoUpdate({ target: [turns.sessionId, turns.id], set: m.turn })
          .run();
        break;
      case "item": {
        const { record } = m;
        const row = {
          sessionId: record.sessionId,
          id: record.item.id,
          threadId: record.threadId,
          turnId: record.turnId,
          position: record.position,
          kind: record.item.kind,
          status: record.item.status,
          data: record.item,
          createdAt: record.createdAt,
          updatedAt: record.updatedAt,
        };
        tx.insert(items)
          .values(row)
          .onConflictDoUpdate({ target: [items.sessionId, items.id], set: row })
          .run();
        if (index) indexItem(tx, record);
        break;
      }
      case "session":
        tx.update(sessions).set({ usage: m.usage }).where(eq(sessions.id, m.session.id)).run();
        break;
      case "inbox":
        break;
    }
  }
}

/** Domain events announcing the session and inbox changes in `mutations`. */
export function derivedEvents(mutations: Mutation[]): NewEvent[] {
  const out: NewEvent[] = [];
  for (const m of mutations) {
    if (m.type === "session" && m.sessionChanged) {
      out.push({
        type: "session.updated",
        sessionId: m.session.id,
        payload: { session: m.session },
      });
    } else if (m.type === "inbox") {
      out.push({
        type: m.created ? "inbox.created" : "inbox.updated",
        sessionId: m.item.sessionId,
        payload: { item: m.item },
      });
    }
  }
  return out;
}

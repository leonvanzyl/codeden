import type {
  InboxCounts,
  InboxItem,
  InboxSettlement,
  JsonValue,
  ListInboxQuery,
  ResolveInboxRequest,
  RuntimeResponse,
  Session,
} from "@codeden/contracts";
import { and, desc, eq, type SQL } from "drizzle-orm";
import type { Db } from "../db/client";
import { rowToInbox } from "../db/rows";
import { inboxItems } from "../db/schema";
import { openRunFailed, runFailedAgain, runFailedInbox } from "../events/reducer/items";
import type { EventStore } from "../events/store";
import { badRequest, notFound } from "./errors";

/** Sends an approval/answer to the agent; provided by the session service. */
export type Responder = (
  sessionId: string,
  requestId: string,
  response: RuntimeResponse,
) => Promise<void>;

/** The inbox (§11.1): everything waiting on the user. */
export class InboxService {
  constructor(
    private readonly db: Db,
    private readonly store: EventStore,
    private readonly responder: () => Responder,
  ) {}

  list(query: ListInboxQuery = {}): InboxItem[] {
    const conditions: SQL[] = [eq(inboxItems.status, query.status ?? "open")];
    if (query.projectId) conditions.push(eq(inboxItems.projectId, query.projectId));
    if (query.sessionId) conditions.push(eq(inboxItems.sessionId, query.sessionId));
    return this.db
      .select()
      .from(inboxItems)
      .where(and(...conditions))
      .orderBy(desc(inboxItems.createdAt))
      .limit(1000)
      .all()
      .map(rowToInbox);
  }

  counts(): InboxCounts {
    const open = this.list();
    const byProject: Record<string, number> = {};
    const byKind: InboxCounts["byKind"] = {};
    for (const item of open) {
      if (item.projectId) byProject[item.projectId] = (byProject[item.projectId] ?? 0) + 1;
      byKind[item.kind] = (byKind[item.kind] ?? 0) + 1;
    }
    return { open: open.length, byProject, byKind };
  }

  get(id: string): InboxItem {
    const item = this.find(id);
    if (!item) throw notFound(`No inbox item ${id}`, "inbox_not_found");
    return item;
  }

  find(id: string): InboxItem | undefined {
    const row = this.db.select().from(inboxItems).where(eq(inboxItems.id, id)).get();
    return row ? rowToInbox(row) : undefined;
  }

  /** Create an item, or replace the one with the same id. */
  put(item: InboxItem): InboxItem {
    const type = this.find(item.id) ? "inbox.updated" : "inbox.created";
    this.store.append([{ type, sessionId: item.sessionId, payload: { item } }]);
    return item;
  }

  /**
   * Answer an item in place. Approvals and questions forward `response` to the agent (the
   * transcript update then resolves the item too); other items are just closed.
   */
  async resolve(id: string, req: ResolveInboxRequest): Promise<InboxItem> {
    const item = this.get(id);
    if (item.status !== "open") return item;
    const answerable = (item.kind === "approval" || item.kind === "question") && item.requestId;
    if (answerable && req.status === "resolved") {
      if (!req.response) throw badRequest("This item needs a response", "response_required");
      if (!item.sessionId || !item.requestId) throw badRequest("Item has no session");
      await this.responder()(item.sessionId, item.requestId, req.response);
      return this.get(id);
    }
    return this.close(item, req.status, req.note ? { note: req.note } : null);
  }

  /** Close an open item now (eagerly, before the agent's confirmation arrives). */
  close(item: InboxItem, status: "resolved" | "dismissed", resolution: JsonValue): InboxItem {
    if (item.status !== "open") return item;
    const next = closedItem(item, status, resolution);
    this.store.append([
      { type: "inbox.updated", sessionId: item.sessionId, payload: { item: next } },
    ]);
    return next;
  }

  /** Close the open item mirroring a session's request, if there is one. */
  closeForRequest(sessionId: string, requestId: string, resolution: JsonValue): void {
    const row = this.db
      .select()
      .from(inboxItems)
      .where(
        and(
          eq(inboxItems.sessionId, sessionId),
          eq(inboxItems.requestId, requestId),
          eq(inboxItems.status, "open"),
        ),
      )
      .get();
    if (row) this.close(rowToInbox(row), "resolved", resolution);
  }

  /** Dismiss a session's open approvals and questions (session stopped). */
  dismissRequestsForSession(sessionId: string, reason: string): void {
    for (const item of this.list({ sessionId })) {
      if (item.kind === "approval" || item.kind === "question") {
        this.close(item, "dismissed", { reason });
      }
    }
  }

  /**
   * Raise a `run_failed` item for a session that could not start or crashed. One item per run:
   * a session whose earlier failure is still open updates that item in place (attempts, latest
   * error) instead of getting a second one.
   */
  raiseRunFailed(session: Session, key: string, message: string): InboxItem {
    const now = new Date().toISOString();
    const open = openRunFailed(this.list({ sessionId: session.id }));
    return this.put(
      open
        ? runFailedAgain(open, message, now)
        : runFailedInbox(session, `inbox:${session.id}:${key}`, message, session.rootThreadId, now),
    );
  }

  /**
   * Dismiss open items at once (the inbox's bulk clean-up). Approvals and questions are left:
   * they need an answer. Returns how many were dismissed.
   */
  dismissMany(ids: readonly string[], note?: string): number {
    let dismissed = 0;
    for (const id of new Set(ids)) {
      const item = this.find(id);
      if (item?.status !== "open") continue;
      if (item.kind === "approval" || item.kind === "question") continue;
      this.close(item, "dismissed", note ? { note } : null);
      dismissed++;
    }
    return dismissed;
  }

  /** Close an open item CodeDen settled by itself, with a short note on why (`InboxSettlement`). */
  settle(item: InboxItem, settlement: InboxSettlement): InboxItem {
    return this.close(item, "resolved", settlement);
  }
}

/** `item` closed now with `status` and `resolution` (append it as `inbox.updated`). */
export function closedItem(
  item: InboxItem,
  status: "resolved" | "dismissed",
  resolution: JsonValue,
  now = new Date().toISOString(),
): InboxItem {
  return { ...item, status, resolution, resolvedAt: now, updatedAt: now };
}

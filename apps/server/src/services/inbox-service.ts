import {
  type DismissInboxResponse,
  INBOX_ACT_NOTIFY,
  INBOX_ANSWER_KINDS,
  INBOX_BULK_MAX,
  type InboxCounts,
  type InboxDismissFilter,
  type InboxItem,
  type InboxItemKind,
  type InboxSettlement,
  inboxAttempts,
  inboxRestorable,
  inboxWaitsOnYou,
  type JsonValue,
  type ListInboxQuery,
  type ResolveInboxRequest,
  type RestoreInboxResponse,
  type RuntimeResponse,
  type Session,
} from "@codeden/contracts";
import { and, count, desc, eq, inArray, not, type SQL, sql } from "drizzle-orm";
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
    return this.newest(matching(query), 1000);
  }

  /** The newest `limit` items `where` matches. */
  private newest(where: SQL | undefined, limit: number): InboxItem[] {
    return this.db
      .select()
      .from(inboxItems)
      .where(where)
      .orderBy(desc(inboxItems.createdAt))
      .limit(limit)
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
   * error) instead of getting a second one. An item of the same key that was closed opens again
   * and counts on, so the new failure still gets its own notice (`deriveNotices`).
   */
  raiseRunFailed(session: Session, key: string, message: string): InboxItem {
    const now = new Date().toISOString();
    const open = openRunFailed(this.list({ sessionId: session.id }));
    if (open) return this.put(runFailedAgain(open, message, now));
    const id = `inbox:${session.id}:${key}`;
    const fresh = runFailedInbox(session, id, message, session.rootThreadId, now);
    const closed = this.find(id);
    return this.put(closed ? { ...fresh, attempts: inboxAttempts(closed) + 1 } : fresh);
  }

  /**
   * Dismiss open items at once (the inbox's bulk clean-up), given by id or by the list's
   * filters, in one transaction. Items that wait on the user (`inboxWaitsOnYou`) are left and
   * counted as `kept`; the rest are closed like a hand dismissal (`inbox.updated`), with
   * `{ bulk: true }` so `restoreMany` can undo it.
   */
  dismissMany(
    scope: { ids: readonly string[] } | { filter: InboxDismissFilter },
    note?: string,
  ): DismissInboxResponse {
    const now = new Date().toISOString();
    const resolution: JsonValue = note ? { bulk: true, note } : { bulk: true };
    const { items, kept } = "ids" in scope ? this.byIds(scope.ids) : this.byFilter(scope.filter);
    const closed = items.map((item) => closedItem(item, "dismissed", resolution, now));
    this.appendUpdates(closed);
    return { dismissed: closed.length, ids: closed.map((i) => i.id), kept };
  }

  /** The open items among `ids` a bulk dismiss closes, and how many it keeps as waiting on you. */
  private byIds(ids: readonly string[]): BulkScope {
    const open = [...new Set(ids)]
      .slice(0, INBOX_BULK_MAX)
      .map((id) => this.find(id))
      .filter((item): item is InboxItem => item?.status === "open");
    const items = open.filter((item) => !inboxWaitsOnYou(item));
    return { items, kept: open.length - items.length };
  }

  /**
   * The newest open items `filter` matches that a bulk dismiss closes (at most
   * {@link INBOX_BULK_MAX}), and how many matching items it keeps as waiting on you. Both run in
   * SQL, so items that wait on the user don't take slots under the cap and crowd out older
   * notices (#433).
   */
  private byFilter(filter: InboxDismissFilter): BulkScope {
    const scope = matching(filter);
    const waits = waitsOnYou();
    const items = this.newest(and(scope, not(waits)), INBOX_BULK_MAX);
    const row = this.db.select({ n: count() }).from(inboxItems).where(and(scope, waits)).get();
    return { items, kept: row?.n ?? 0 };
  }

  /**
   * Undo a bulk dismiss or the PM's resolution of stale items: reopen the given items closed that
   * way (`inboxRestorable`), in one transaction. One since re-raised, settled or closed by hand
   * is left as it is, so exactly the closed set comes back.
   */
  restoreMany(ids: readonly string[]): RestoreInboxResponse {
    const now = new Date().toISOString();
    const reopened: InboxItem[] = [];
    for (const id of new Set(ids)) {
      const item = this.find(id);
      if (!item || !inboxRestorable(item)) continue;
      reopened.push({
        ...item,
        status: "open",
        resolution: null,
        resolvedAt: null,
        updatedAt: now,
      });
    }
    this.appendUpdates(reopened);
    return { restored: reopened.length, ids: reopened.map((i) => i.id) };
  }

  /** Append `inbox.updated` for each item, all in one batch. */
  private appendUpdates(items: InboxItem[]): void {
    if (items.length === 0) return;
    this.store.append(
      items.map((item) => ({
        type: "inbox.updated" as const,
        sessionId: item.sessionId,
        payload: { item },
      })),
    );
  }

  /** Close an open item CodeDen settled by itself, with a short note on why (`InboxSettlement`). */
  settle(item: InboxItem, settlement: InboxSettlement): InboxItem {
    return this.close(item, "resolved", settlement);
  }
}

/** What a bulk dismiss covers: the open items it closes, and how many it keeps. */
interface BulkScope {
  items: InboxItem[];
  kept: number;
}

/**
 * Items with `query`'s status (open when not given), project and session, of one of `kinds` when
 * given. Every condition runs in SQL, before any limit, so older matching items aren't crowded
 * out by newer items that don't match.
 */
function matching(query: ListInboxQuery & { kinds?: readonly InboxItemKind[] }): SQL | undefined {
  const conditions: SQL[] = [eq(inboxItems.status, query.status ?? "open")];
  if (query.projectId) conditions.push(eq(inboxItems.projectId, query.projectId));
  if (query.sessionId) conditions.push(eq(inboxItems.sessionId, query.sessionId));
  if (query.kinds) conditions.push(inArray(inboxItems.kind, [...query.kinds]));
  return and(...conditions);
}

/** `inboxWaitsOnYou` in SQL: a kind that needs an answer, or high priority a person acts on. */
function waitsOnYou(): SQL {
  const answer = inArray(inboxItems.kind, [...INBOX_ANSWER_KINDS]);
  const act = inArray(inboxItems.notify, [...INBOX_ACT_NOTIFY]);
  return sql`(${answer} or (${eq(inboxItems.priority, "high")} and ${act}))`;
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

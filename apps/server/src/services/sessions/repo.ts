import {
  agentEventToNewEvent,
  type Item,
  type ItemOf,
  type ItemRecord,
  type ListSessionsQuery,
  type NewEvent,
  type Session,
  SessionStartMeta,
  type ThreadItemsPage,
  type ThreadItemsQuery,
  type Usage,
  type UserInput,
  type WorkSummary,
  type WorkspaceRequest,
} from "@codeden/contracts";
import { and, asc, type Column, desc, eq, gt, inArray, lt, or, type SQL, sql } from "drizzle-orm";
import type { Db } from "../../db/client";
import { rowToItemRecord, rowToSession } from "../../db/rows";
import { automationRuns, items, sessions, turns } from "../../db/schema";
import type { EventStore } from "../../events/store";
import { notFound } from "../errors";
import { ACTIVE_RUN_STATUSES, ACTIVE_SESSION_STATUSES } from "./conflicts";
import type { ForkStart } from "./fork";

/** What a queued session needs to start later (kept with its start metadata). */
export interface PendingStart {
  input?: UserInput;
  workspace: WorkspaceRequest;
}

/**
 * Start metadata as stored: the public `SessionStartMeta` plus a pending start, and the PR
 * feedback already sent per PR number (`PrFeedbackService`).
 */
export type StoredStartMeta = SessionStartMeta & {
  pending?: PendingStart | null;
  prFeedback?: Record<string, { rounds: number; keys: string[] }>;
  /** A fork's workspace plan (§9): prepared before any start until the worktree exists. */
  forkStart?: ForkStart | null;
};

/**
 * A folder as `SessionRepo.inFolder` compares it: forward slashes, no trailing slash, ASCII
 * lower case (what SQLite's `lower()` does).
 */
export function folderKey(folder: string): string {
  return folder
    .replace(/\\/g, "/")
    .replace(/\/+$/, "")
    .replace(/[A-Z]/g, (c) => c.toLowerCase());
}

/** Session rows and transcript reads. Every session change goes through the event log. */
export class SessionRepo {
  constructor(
    private readonly db: Db,
    private readonly store: EventStore,
  ) {}

  find(
    id: string,
  ): { session: Session; usage: Usage | null; startMeta: StoredStartMeta | null } | undefined {
    const row = this.db.select().from(sessions).where(eq(sessions.id, id)).get();
    if (!row) return undefined;
    return {
      session: rowToSession(row),
      usage: row.usage ?? null,
      startMeta: row.startMeta ?? null,
    };
  }

  get(id: string): Session {
    const found = this.find(id);
    if (!found) throw notFound(`No session ${id}`, "session_not_found");
    return found.session;
  }

  /** Insert a new session (and its start metadata) in one transaction. */
  create(session: Session, startMeta: StoredStartMeta): void {
    this.store.append(
      [{ type: "session.created", sessionId: session.id, payload: { session } }],
      (tx) => {
        tx.update(sessions).set({ startMeta }).where(eq(sessions.id, session.id)).run();
      },
    );
  }

  /**
   * Apply `change` to the current row and append `session.updated` when it changed. Synchronous
   * end to end, so there is no read-modify-write race with event ingestion.
   */
  update(id: string, change: (s: Session) => Session): Session {
    const current = this.get(id);
    const next = change(current);
    if (next === current) return current;
    const session = { ...next, updatedAt: new Date().toISOString() };
    this.store.append([{ type: "session.updated", sessionId: id, payload: { session } }]);
    return session;
  }

  setStartMeta(id: string, change: (meta: StoredStartMeta | null) => StoredStartMeta): void {
    const meta = change(this.find(id)?.startMeta ?? null);
    this.db.update(sessions).set({ startMeta: meta }).where(eq(sessions.id, id)).run();
  }

  /** Public view of the start metadata. */
  publicStartMeta(meta: StoredStartMeta | null): SessionStartMeta | null {
    return meta ? SessionStartMeta.parse(meta) : null;
  }

  list(query: ListSessionsQuery = {}): Session[] {
    const conditions: SQL[] = [];
    if (query.projectId) conditions.push(eq(sessions.projectId, query.projectId));
    if (query.status?.length) conditions.push(inArray(sessions.status, query.status));
    if (query.workKey) conditions.push(eq(sessions.workKey, query.workKey));
    if (query.role) conditions.push(eq(sessions.role, query.role));
    return this.db
      .select()
      .from(sessions)
      .where(and(...conditions))
      .orderBy(desc(sessions.createdAt))
      .limit(1000)
      .all()
      .map(rowToSession);
  }

  /**
   * Every session working in `folder` (its cwd or its worktree), compared without ASCII case,
   * slash style or a trailing slash. Not capped like `list`: cleanup must see each one.
   */
  inFolder(folder: string): Session[] {
    const target = folderKey(folder);
    const key = (column: Column) => sql`lower(rtrim(replace(${column}, ${"\\"}, '/'), '/'))`;
    return this.db
      .select()
      .from(sessions)
      .where(
        or(sql`${key(sessions.cwd)} = ${target}`, sql`${key(sessions.worktreePath)} = ${target}`),
      )
      .all()
      .map(rowToSession);
  }

  /** Queued sessions, oldest first. */
  queued(): Session[] {
    return this.db
      .select()
      .from(sessions)
      .where(eq(sessions.status, "queued"))
      .orderBy(asc(sessions.createdAt))
      .all()
      .map(rowToSession);
  }

  /** Running or queued work in a project: sessions and automation runs (§8.4). */
  activeWork(projectId: string | null): WorkSummary[] {
    const sessionRows = this.db
      .select()
      .from(sessions)
      .where(
        and(
          projectId === null ? undefined : eq(sessions.projectId, projectId),
          inArray(sessions.status, [...ACTIVE_SESSION_STATUSES]),
        ),
      )
      .orderBy(asc(sessions.createdAt))
      .all()
      .map(rowToSession)
      .filter((s) => s.projectId === projectId);
    const runRows = this.db
      .select()
      .from(automationRuns)
      .where(inArray(automationRuns.status, [...ACTIVE_RUN_STATUSES]))
      .all()
      // A run whose session is listed already is the same work; list it once.
      .filter((r) => r.projectId === projectId)
      .filter((r) => !(r.sessionId && sessionRows.some((s) => s.id === r.sessionId)));
    return [
      ...sessionRows.map(
        (s): WorkSummary => ({
          kind: "session",
          id: s.id,
          sessionId: s.id,
          projectId: s.projectId,
          startedBy: s.startedBy,
          purpose: s.purpose,
          workKey: s.workKey,
          scope: s.scope,
          progress: s.progress,
          status: s.status,
          startedAt: s.createdAt,
        }),
      ),
      ...runRows.map(
        (r): WorkSummary => ({
          kind: "automation_run",
          id: r.id,
          sessionId: r.sessionId,
          projectId: r.projectId,
          startedBy: r.startedBy,
          purpose: r.purpose,
          workKey: r.workKey,
          scope: r.scope,
          progress: r.progress,
          status: r.status,
          startedAt: r.startedAt,
        }),
      ),
    ];
  }

  /**
   * Close what a runner that went away without a word (crash, kill, power loss) left open in a
   * session it no longer hosts (§4.2). Turns still `running` end as interrupted by a restart,
   * which cancels their approvals and provider questions and dismisses their inbox items; any
   * other provider request still open is cancelled too, so none of them can keep the session
   * `waiting`. CodeDen's deferred `ask_user` questions outlive their turn and stay open.
   * Returns how many turns and requests it closed.
   */
  closeOrphanedTurns(sessionId: string): number {
    const running = this.db
      .select()
      .from(turns)
      .where(and(eq(turns.sessionId, sessionId), eq(turns.status, "running")))
      .orderBy(asc(turns.startedAt))
      .all();
    const ended = new Set(running.map((t) => t.id));
    const requests = this.db
      .select()
      .from(items)
      .where(
        and(
          eq(items.sessionId, sessionId),
          inArray(items.kind, ["approval_request", "user_question"]),
          eq(items.status, "in_progress"),
        ),
      )
      .all()
      .map(rowToItemRecord)
      .filter((r) => !ended.has(r.turnId))
      .filter((r) => !(r.item.kind === "user_question" && r.item.deferred));
    const root = this.find(sessionId)?.session.rootThreadId;
    const isRoot = (t: { threadId: string }) => Number(t.threadId === root);
    const events: NewEvent[] = [
      ...requests.map((r) =>
        agentEventToNewEvent(sessionId, {
          type: "item.completed",
          threadId: r.threadId,
          turnId: r.turnId,
          item: { ...r.item, status: "cancelled" } as Item,
        }),
      ),
      // Child threads first, so the root turn ends last and sets the session's status.
      ...running
        .sort((a, b) => isRoot(a) - isRoot(b))
        .map((t) =>
          agentEventToNewEvent(sessionId, {
            type: "turn.interrupted",
            threadId: t.threadId,
            turnId: t.id,
            reason: "runner_restart",
          }),
        ),
    ];
    if (events.length > 0) this.store.append(events);
    return events.length;
  }

  item(sessionId: string, itemId: string): ItemRecord | undefined {
    const row = this.db
      .select()
      .from(items)
      .where(and(eq(items.sessionId, sessionId), eq(items.id, itemId)))
      .get();
    return row ? rowToItemRecord(row) : undefined;
  }

  /** A page of a thread's items by position (newest page by default). */
  threadPage(sessionId: string, threadId: string, q: ThreadItemsQuery): ThreadItemsPage {
    const base = [eq(items.sessionId, sessionId), eq(items.threadId, threadId)];
    const newestFirst = q.after === undefined;
    const rows = this.db
      .select()
      .from(items)
      .where(
        and(
          ...base,
          q.before !== undefined ? lt(items.position, q.before) : undefined,
          q.after !== undefined ? gt(items.position, q.after) : undefined,
        ),
      )
      .orderBy(newestFirst ? desc(items.position) : asc(items.position))
      .limit(q.limit + 1)
      .all();
    const more = rows.length > q.limit;
    const page = rows.slice(0, q.limit).map(rowToItemRecord);
    if (newestFirst) page.reverse();
    const first = page[0]?.position;
    const last = page.at(-1)?.position;
    const exists = (cond: SQL) =>
      this.db
        .select({ id: items.id })
        .from(items)
        .where(and(...base, cond))
        .limit(1)
        .get() !== undefined;
    return {
      threadId,
      items: page,
      hasMoreBefore: newestFirst ? more : first !== undefined && exists(lt(items.position, first)),
      hasMoreAfter: newestFirst ? last !== undefined && exists(gt(items.position, last)) : more,
    };
  }

  /** Follow-ups of the latest root-thread turn that produced some (§7.5). */
  latestFollowups(session: Session): ItemOf<"followups"> | null {
    if (!session.rootThreadId) return null;
    const row = this.db
      .select()
      .from(items)
      .where(
        and(
          eq(items.sessionId, session.id),
          eq(items.threadId, session.rootThreadId),
          eq(items.kind, "followups"),
        ),
      )
      .orderBy(desc(items.position))
      .limit(1)
      .get();
    return row?.data.kind === "followups" ? row.data : null;
  }
}

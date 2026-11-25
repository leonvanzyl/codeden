import type { SessionSnapshot, SessionSnapshotQuery, Thread } from "@codeden/contracts";
import { and, asc, count, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import { rowToItemRecord, rowToSession, rowToThread, rowToTurn } from "../../db/rows";
import { items, sessions, threads, turns } from "../../db/schema";
import { turnsOldestFirst } from "../../db/turn-order";
import type { AppServices } from "../container";
import { notFound } from "../errors";
import { clientItemRecord } from "./client-items";

type Deps = Pick<AppServices, "db" | "store" | "artifacts">;

/** Ids per `IN (...)` list, well under SQLite's bound-parameter limit. */
const IN_CHUNK = 500;

/**
 * `GET /api/sessions/:id/snapshot`: the whole session, or with `q.turns` only the latest root
 * turns (§6), so opening a long-lived session (a PM, the orchestrator, the scout) costs a page
 * rather than its whole history. A page holds its root turns and their items, plus every
 * subagent thread those items started, with all of that thread's turns and items.
 */
export function sessionSnapshot(
  s: Deps,
  sessionId: string,
  q: SessionSnapshotQuery = {},
): SessionSnapshot {
  // Read the head first: anything appended later arrives through the session watch.
  const seq = s.store.headSeq();
  const row = s.db.select().from(sessions).where(eq(sessions.id, sessionId)).get();
  if (!row) throw notFound("No such session", "session_not_found");
  const session = rowToSession(row);
  if (q.turns === undefined) {
    return {
      seq,
      session,
      threads: s.db
        .select()
        .from(threads)
        .where(eq(threads.sessionId, sessionId))
        .all()
        .map(rowToThread),
      // Oldest first, so a thread's last turn is its latest one.
      turns: s.db
        .select()
        .from(turns)
        .where(eq(turns.sessionId, sessionId))
        .orderBy(...turnsOldestFirst)
        .all()
        .map(rowToTurn),
      items: s.db
        .select()
        .from(items)
        .where(eq(items.sessionId, sessionId))
        .orderBy(asc(items.threadId), asc(items.position))
        .all()
        .map((row) => toClient(s, row)),
      earlierTurns: 0,
    };
  }

  const root = s.db
    .select()
    .from(threads)
    .where(
      and(
        eq(threads.sessionId, sessionId),
        session.rootThreadId
          ? eq(threads.id, session.rootThreadId)
          : isNull(threads.parentThreadId),
      ),
    )
    .get();
  const rootId = session.rootThreadId ?? root?.id;
  if (!rootId) {
    if (q.before) throw notFound("No such turn in this session's thread", "turn_not_found");
    return { seq, session, threads: [], turns: [], items: [], earlierTurns: 0 };
  }
  const rootTurns = and(eq(turns.sessionId, sessionId), eq(turns.threadId, rootId));
  const rowId = sql<number>`rowid`;
  const before = q.before
    ? s.db
        .select({ startedAt: turns.startedAt, rowId })
        .from(turns)
        .where(and(rootTurns, eq(turns.id, q.before)))
        .get()
    : undefined;
  if (q.before && !before) {
    throw notFound("No such turn in this session's thread", "turn_not_found");
  }
  // Match turnsOldestFirst, including turns that start in the same millisecond.
  const where = before
    ? and(rootTurns, sql`(${turns.startedAt}, ${rowId}) < (${before.startedAt}, ${before.rowId})`)
    : rootTurns;
  const page = s.db
    .select()
    .from(turns)
    .where(where)
    .orderBy(desc(turns.startedAt), desc(rowId))
    .limit(q.turns)
    .all()
    .reverse();
  const earlierTurns =
    page.length < q.turns
      ? 0
      : (s.db.select({ total: count() }).from(turns).where(where).get()?.total ?? 0) - page.length;
  const live = readPage(s, sessionId, rootId, root, page);
  const focusedTurnId = q.item && rootTurnOf(s, sessionId, q.item, rootId);
  const focused =
    focusedTurnId && !page.some((turn) => turn.id === focusedTurnId)
      ? s.db
          .select()
          .from(turns)
          .where(and(rootTurns, eq(turns.id, focusedTurnId)))
          .get()
      : undefined;
  return {
    seq,
    session,
    ...live,
    earlierTurns,
    ...(focused ? { focused: readPage(s, sessionId, rootId, root, [focused]) } : {}),
  };
}

type ItemRow = typeof items.$inferSelect;
const toClient = (s: Deps, row: ItemRow) => clientItemRecord(rowToItemRecord(row), s.artifacts);

function readPage(
  s: Deps,
  sessionId: string,
  rootId: string,
  root: typeof threads.$inferSelect | undefined,
  page: (typeof turns.$inferSelect)[],
): Pick<SessionSnapshot, "threads" | "turns" | "items"> {
  const rootItems = inChunks(
    page.map((turn) => turn.id),
    (ids) =>
      s.db
        .select()
        .from(items)
        .where(
          and(
            eq(items.sessionId, sessionId),
            eq(items.threadId, rootId),
            inArray(items.turnId, ids),
          ),
        )
        .all(),
  );

  // Subagent threads started by an included item (named by the thread, or by the subagent
  // card), then theirs, all the way down.
  const included = new Set([rootId]);
  const pageThreads: Thread[] = root ? [rowToThread(root)] : [];
  const childItems: ItemRow[] = [];
  let found = rootItems;
  while (found.length > 0) {
    const itemIds = found.map((r) => r.id);
    const cardThreads = found.flatMap((r) =>
      r.data.kind === "subagent" ? [r.data.childThreadId] : [],
    );
    const atItems = inChunks(itemIds, (ids) =>
      s.db
        .select()
        .from(threads)
        .where(and(eq(threads.sessionId, sessionId), inArray(threads.parentItemId, ids)))
        .all(),
    );
    const atCards = inChunks(cardThreads, (ids) =>
      s.db
        .select()
        .from(threads)
        .where(and(eq(threads.sessionId, sessionId), inArray(threads.id, ids)))
        .all(),
    );
    const ids: string[] = [];
    for (const child of [...atItems, ...atCards]) {
      if (!child.parentThreadId || included.has(child.id)) continue;
      included.add(child.id);
      ids.push(child.id);
      pageThreads.push(rowToThread(child));
    }
    found = inChunks(ids, (chunk) =>
      s.db
        .select()
        .from(items)
        .where(and(eq(items.sessionId, sessionId), inArray(items.threadId, chunk)))
        .all(),
    );
    childItems.push(...found);
  }
  const childIds = [...included].filter((id) => id !== rootId);
  const childTurns = inChunks(childIds, (chunk) =>
    s.db
      .select()
      .from(turns)
      .where(and(eq(turns.sessionId, sessionId), inArray(turns.threadId, chunk)))
      .orderBy(...turnsOldestFirst)
      .all()
      .map(rowToTurn),
  );

  return {
    threads: pageThreads,
    // Oldest first like the whole session (a stable sort keeps each thread's own order).
    turns: [...page.map(rowToTurn), ...childTurns].sort(byStart),
    items: [...rootItems, ...childItems].sort(byThreadPosition).map((row) => toClient(s, row)),
  };
}

const byStart = (a: { startedAt: string }, b: { startedAt: string }) =>
  a.startedAt < b.startedAt ? -1 : a.startedAt > b.startedAt ? 1 : 0;

const byThreadPosition = (a: ItemRow, b: ItemRow) =>
  a.threadId === b.threadId ? a.position - b.position : a.threadId < b.threadId ? -1 : 1;

/**
 * The root turn an item belongs to: its own turn in the root thread, or the turn of the subagent
 * card that started its thread (walking up nested subagents). Null when there is none.
 */
function rootTurnOf(s: Deps, sessionId: string, itemId: string, rootId: string): string | null {
  const find = (id: string) =>
    s.db
      .select({ threadId: items.threadId, turnId: items.turnId })
      .from(items)
      .where(and(eq(items.sessionId, sessionId), eq(items.id, id)))
      .get();
  let at = find(itemId);
  for (let depth = 0; at && depth < 16; depth++) {
    if (at.threadId === rootId) return at.turnId;
    const parentItemId = s.db
      .select({ parentItemId: threads.parentItemId })
      .from(threads)
      .where(and(eq(threads.sessionId, sessionId), eq(threads.id, at.threadId)))
      .get()?.parentItemId;
    at = parentItemId ? find(parentItemId) : undefined;
  }
  return null;
}

/** Run a query per chunk of ids and concatenate the rows (none for no ids). */
function inChunks<T>(ids: string[], query: (chunk: string[]) => T[]): T[] {
  const out: T[] = [];
  for (let i = 0; i < ids.length; i += IN_CHUNK) out.push(...query(ids.slice(i, i + IN_CHUNK)));
  return out;
}

import {
  type ToolKind,
  TRANSCRIPT_SEARCH_MIN_TERM,
  type TranscriptSearchHit,
  type TranscriptSearchQuery,
  type TranscriptSearchResponse,
} from "@codeden/contracts";
import { inArray, type SQL, sql } from "drizzle-orm";
import type { Db } from "../../db/client";
import { threads } from "../../db/schema";
import { HIGHLIGHT_CLOSE, HIGHLIGHT_OPEN } from "./item-text";
import { snippetParts } from "./snippet";

/** Most hits one session contributes, so one long session doesn't crowd out the rest. */
export const HITS_PER_SESSION = 3;

/** The search terms of a query: the FTS5 expression and the terms too short for the index. */
export interface ParsedQuery {
  /** FTS5 MATCH expression, or null when no term is long enough to use the index. */
  match: string | null;
  /** Terms shorter than the trigram minimum, matched as plain substrings. */
  short: string[];
}

/**
 * Split a query on whitespace. Terms of three or more characters become quoted FTS5 strings
 * (every one must match), so quotes, `*`, `:`, `-`, parentheses and words like `OR` or `NEAR`
 * are searched literally and never parsed as query syntax. Shorter terms can't use a trigram
 * index; they filter the indexed matches instead.
 */
export function parseQuery(q: string): ParsedQuery {
  const terms = [...new Set(q.split(/\s+/).filter(Boolean))];
  const long = terms.filter((t) => [...t].length >= TRANSCRIPT_SEARCH_MIN_TERM);
  const short = terms.filter((t) => [...t].length < TRANSCRIPT_SEARCH_MIN_TERM);
  const match = long.length > 0 ? long.map((t) => `"${t.replaceAll('"', '""')}"`).join(" ") : null;
  return { match, short };
}

interface HitRow {
  id: number;
  session_id: string;
  thread_id: string;
  item_id: string;
  kind: string;
  tool_kind: string | null;
  created_at: string;
}

/**
 * Full-text search over every transcript (§6, §13), archived sessions included. Best matches
 * first (bm25), newer first among equals, at most `HITS_PER_SESSION` per session.
 */
export function searchTranscripts(db: Db, query: TranscriptSearchQuery): TranscriptSearchResponse {
  const q = query.q.trim();
  const { match, short } = parseQuery(q);
  if (!match) return { query: q, hits: [], truncated: false };

  const rows = db.all<HitRow>(sql`
    WITH m AS MATERIALIZED (
      SELECT rowid AS id, rank AS score FROM item_search_fts WHERE item_search_fts MATCH ${match}
    ),
    ranked AS (
      SELECT s.id, s.session_id, s.thread_id, s.item_id, s.kind, s.tool_kind, s.created_at,
        m.score,
        row_number() OVER (PARTITION BY s.session_id ORDER BY m.score, s.created_at DESC) AS n
      FROM m JOIN item_search s ON s.id = m.id
      ${query.projectId ? sql`JOIN sessions ss ON ss.id = s.session_id` : sql``}
      ${where(query.projectId, short)}
    )
    SELECT id, session_id, thread_id, item_id, kind, tool_kind, created_at FROM ranked
    WHERE n <= ${HITS_PER_SESSION}
    ORDER BY score, created_at DESC
    LIMIT ${query.limit + 1}
  `);
  const page = rows.slice(0, query.limit);
  const marked = highlights(db, match, page);
  const anchors = anchorResolver(db, page);
  const hits = page.map(
    (r): TranscriptSearchHit => ({
      sessionId: r.session_id,
      threadId: r.thread_id,
      itemId: r.item_id,
      anchorItemId: anchors(r.session_id, r.thread_id, r.item_id),
      kind: r.kind,
      ...(r.tool_kind ? { toolKind: r.tool_kind as ToolKind } : {}),
      snippet: snippetParts(marked.get(r.id) ?? ""),
      ts: r.created_at,
    }),
  );
  return { query: q, hits, truncated: rows.length > query.limit };
}

function where(projectId: string | undefined, short: string[]): SQL {
  const conditions: SQL[] = short.map((t) => sql`instr(lower(s.text), ${t.toLowerCase()}) > 0`);
  if (projectId) conditions.push(sql`ss.project_id = ${projectId}`);
  return conditions.length > 0 ? sql`WHERE ${sql.join(conditions, sql` AND `)}` : sql``;
}

/** The highlighted text of just the hits being returned. */
function highlights(db: Db, match: string, page: HitRow[]): Map<number, string> {
  if (page.length === 0) return new Map();
  const ids = sql.join(
    page.map((r) => sql`${r.id}`),
    sql`, `,
  );
  const rows = db.all<{ id: number; marked: string }>(sql`
    SELECT rowid AS id,
      highlight(item_search_fts, 0, ${HIGHLIGHT_OPEN}, ${HIGHLIGHT_CLOSE}) AS marked
    FROM item_search_fts WHERE item_search_fts MATCH ${match} AND rowid IN (${ids})
  `);
  return new Map(rows.map((r) => [r.id, r.marked]));
}

/**
 * Where to open each hit: the item itself in the root thread, or for an item inside a
 * subagent's thread, the subagent card in the root thread that started it.
 */
function anchorResolver(
  db: Db,
  page: HitRow[],
): (sessionId: string, threadId: string, itemId: string) => string {
  const sessionIds = [...new Set(page.map((r) => r.session_id))];
  const rows =
    sessionIds.length === 0
      ? []
      : db
          .select({
            sessionId: threads.sessionId,
            id: threads.id,
            parentThreadId: threads.parentThreadId,
            parentItemId: threads.parentItemId,
          })
          .from(threads)
          .where(inArray(threads.sessionId, sessionIds))
          .all();
  const byKey = new Map(rows.map((t) => [`${t.sessionId}\u0000${t.id}`, t]));
  return (sessionId, threadId, itemId) => {
    let anchor = itemId;
    const seen = new Set<string>();
    let thread = byKey.get(`${sessionId}\u0000${threadId}`);
    while (thread?.parentThreadId && thread.parentItemId && !seen.has(thread.id)) {
      seen.add(thread.id);
      anchor = thread.parentItemId;
      thread = byKey.get(`${sessionId}\u0000${thread.parentThreadId}`);
    }
    return anchor;
  };
}

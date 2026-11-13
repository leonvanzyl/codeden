import type { SQLInputValue } from "node:sqlite";
import {
  cleanSearchQuery,
  foldSearchText,
  searchMatchRanges,
  searchTerms,
  type ToolKind,
  TRANSCRIPT_SEARCH_MIN_TERM,
  type TranscriptSearchHit,
  type TranscriptSearchQuery,
  type TranscriptSearchResponse,
} from "@codeden/contracts";
import { inArray } from "drizzle-orm";
import type { Db } from "../../db/client";
import { threads } from "../../db/schema";
import { HIGHLIGHT_CLOSE, HIGHLIGHT_OPEN } from "./item-text";
import { snippetParts } from "./snippet";

/**
 * Most index candidates one request looks at. Matches come newest first and a request stops
 * once it has a page, so this only bounds searches whose candidates mostly fail the filters or
 * the text check: they return what they found with a cursor to continue, rather than block the
 * event loop (`node:sqlite` is synchronous).
 */
export const CANDIDATE_BUDGET = 2_000;

/** The search terms of a query and the FTS5 expression that finds candidates for them. */
export interface ParsedQuery {
  /** The terms as typed (without control characters, NFC), each once. */
  terms: string[];
  /** The terms folded (lower case, no accents): each must appear in a hit's folded text. */
  folded: string[];
  /**
   * FTS5 MATCH expression: every trigram of every term of 3+ characters, each a quoted string,
   * so quotes, `*`, `:`, `-`, parentheses and words like `OR` or `NEAR` are searched literally
   * and never parsed as query syntax. Null when no term is long enough to use the index.
   */
  match: string | null;
}

/**
 * Split a query into terms. The index (`detail=none`) stores which items hold each trigram,
 * not where, so it finds candidates holding every trigram of the long terms; the text check
 * then requires each term, long or short, as a substring ignoring case and accents.
 */
export function parseQuery(q: string): ParsedQuery {
  const terms = searchTerms(q);
  const folded = [...new Set(terms.map(foldSearchText).filter(Boolean))];
  const trigrams = new Set<string>();
  for (const term of terms) {
    const chars = [...term];
    for (let i = 0; i + TRANSCRIPT_SEARCH_MIN_TERM <= chars.length; i++) {
      trigrams.add(chars.slice(i, i + TRANSCRIPT_SEARCH_MIN_TERM).join(""));
    }
  }
  const match =
    trigrams.size > 0 ? [...trigrams].map((t) => `"${t.replaceAll('"', '""')}"`).join(" ") : null;
  return { terms, folded, match };
}

interface CandidateRow {
  id: number;
  session_id: string;
  item_id: string;
  /** Null when the row fails the session filters. */
  text: string | null;
}

/** What a hit shows besides its text, read from `items`. */
interface ItemRow {
  thread_id: string;
  kind: string;
  tool_kind: string | null;
  created_at: string;
}

/**
 * Full-text search over every transcript (§6, §13), newest match first, a page at a time:
 * `nextCursor` continues below the last item looked at.
 */
export function searchTranscripts(db: Db, query: TranscriptSearchQuery): TranscriptSearchResponse {
  const q = cleanSearchQuery(query.q);
  const parsed = parseQuery(q);
  if (!parsed.match) return { query: q, hits: [], nextCursor: null };

  const { text, params } = candidateQuery(query, parsed.match);
  const found: CandidateRow[] = [];
  let scanned = 0;
  let lastId: number | undefined;
  for (const row of db.$client.prepare(text).iterate(...params) as Iterable<CandidateRow>) {
    scanned++;
    lastId = row.id;
    if (row.text !== null && containsAll(row.text, parsed.folded)) {
      found.push(row);
      if (found.length > query.limit) break;
    }
    if (scanned >= CANDIDATE_BUDGET) break;
  }

  const page = found.slice(0, query.limit);
  const nextCursor =
    found.length > query.limit
      ? String(page.at(-1)?.id)
      : scanned >= CANDIDATE_BUDGET && lastId !== undefined
        ? String(lastId)
        : null;
  const item = db.$client.prepare(
    "SELECT thread_id, kind, json_extract(data, '$.toolKind') AS tool_kind, created_at FROM items WHERE session_id = ? AND id = ?",
  );
  const rows = page.flatMap((r) => {
    const meta = item.get(r.session_id, r.item_id) as ItemRow | undefined;
    return meta ? [{ ...r, ...meta }] : [];
  });
  const anchors = anchorResolver(db, rows);
  const hits = rows.map(
    (r): TranscriptSearchHit => ({
      sessionId: r.session_id,
      threadId: r.thread_id,
      itemId: r.item_id,
      anchorItemId: anchors(r.session_id, r.thread_id, r.item_id),
      kind: r.kind,
      ...(r.kind === "tool_call" && r.tool_kind ? { toolKind: r.tool_kind as ToolKind } : {}),
      snippet: snippetParts(highlighted(r.text ?? "", parsed.terms)),
      ts: r.created_at,
    }),
  );
  return { query: q, hits, nextCursor };
}

/**
 * Candidates newest first: the FTS5 index walks its rowids (ordered by creation time) down from
 * the cursor, so the query streams and stops as soon as the caller has enough. Session filters
 * blank `text` instead of dropping the row, so every row looked at counts against the budget.
 */
function candidateQuery(
  query: TranscriptSearchQuery,
  match: string,
): { text: string; params: SQLInputValue[] } {
  const params: SQLInputValue[] = [];
  const filters: string[] = [];
  if (query.projectId) {
    filters.push("ss.project_id = ?");
    params.push(query.projectId);
  }
  if (query.role) {
    filters.push("ss.role = ?");
    params.push(query.role);
  }
  if (!query.includeArchived) filters.push("ss.archived_at IS NULL");
  const text = filters.length > 0 ? `CASE WHEN ${filters.join(" AND ")} THEN s.text END` : "s.text";
  params.push(match);
  if (query.cursor) params.push(Number(query.cursor));
  return {
    text: `
      SELECT s.id, s.session_id, s.item_id, ${text} AS text
      FROM item_search_fts f
      JOIN item_search s ON s.id = f.rowid
      ${filters.length > 0 ? "LEFT JOIN sessions ss ON ss.id = s.session_id" : ""}
      WHERE item_search_fts MATCH ? ${query.cursor ? "AND f.rowid < ?" : ""}
      ORDER BY f.rowid DESC
    `,
    params,
  };
}

/** True when every folded term is in `text`, ignoring case and accents. */
function containsAll(text: string, folded: string[]): boolean {
  const lower = text.toLowerCase();
  let full: string | undefined;
  for (const term of folded) {
    if (lower.includes(term)) continue;
    full ??= foldSearchText(text);
    if (!full.includes(term)) return false;
  }
  return true;
}

/** `text` with every match of the terms wrapped in the highlight markers. */
function highlighted(text: string, terms: string[]): string {
  let out = "";
  let at = 0;
  for (const [start, end] of searchMatchRanges(text, terms)) {
    out += `${text.slice(at, start)}${HIGHLIGHT_OPEN}${text.slice(start, end)}${HIGHLIGHT_CLOSE}`;
    at = end;
  }
  return out + text.slice(at);
}

/**
 * Where to open each hit: the item itself in the root thread, or for an item inside a
 * subagent's thread, the subagent card in the root thread that started it.
 */
function anchorResolver(
  db: Db,
  page: { session_id: string }[],
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

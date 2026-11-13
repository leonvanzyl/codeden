import {
  foldSearchText,
  type SnippetPart,
  searchableText,
  searchMatchRanges,
  searchTerms,
  TRANSCRIPT_SEARCH_DEFAULT_LIMIT,
  TRANSCRIPT_SEARCH_MIN_TERM,
  type TranscriptSearchHit,
  type TranscriptSearchResponse,
} from "@codeden/contracts";
import type { TranscriptState } from "@/lib/transcript/reducer";
import type { TranscriptSearchRequest } from "../client";
import type { MockWorld } from "./world";

const WIDTH = 160;

/**
 * The mock's transcript search: the same searchable text and matching as the server (every
 * term, ignoring case and accents), the same filters, newest first, paged with a cursor.
 */
export function mockSearch(
  world: MockWorld,
  req: TranscriptSearchRequest,
): TranscriptSearchResponse {
  const terms = searchTerms(req.q);
  const q = terms.join(" ");
  const folded = terms.map(foldSearchText);
  const limit = req.limit ?? TRANSCRIPT_SEARCH_DEFAULT_LIMIT;
  if (!terms.some((t) => [...t].length >= TRANSCRIPT_SEARCH_MIN_TERM)) {
    return { query: q, hits: [], nextCursor: null };
  }
  const sessions = world.snapshot.sessions.filter(
    (s) =>
      (!req.projectId || s.projectId === req.projectId) &&
      (!req.role || s.role === req.role) &&
      (req.includeArchived !== false || !s.archivedAt),
  );
  const hits: TranscriptSearchHit[] = [];
  for (const session of sessions) {
    const t = world.transcripts.get(session.id);
    if (!t) continue;
    for (const [itemId, entry] of Object.entries(t.items)) {
      const text = searchableText(entry.item);
      const all = foldSearchText(text);
      if (!text || !folded.every((term) => all.includes(term))) continue;
      hits.push({
        sessionId: session.id,
        threadId: entry.threadId,
        itemId,
        anchorItemId: anchorOf(t, entry.threadId, itemId),
        kind: entry.item.kind,
        ...(entry.item.kind === "tool_call" ? { toolKind: entry.item.toolKind } : {}),
        snippet: snippet(text, terms),
        ts: t.turns[entry.turnId]?.startedAt ?? session.updatedAt,
      });
    }
  }
  hits.sort((a, b) => b.ts.localeCompare(a.ts));
  const start = req.cursor ? Number(req.cursor) : 0;
  const end = start + limit;
  return {
    query: q,
    hits: hits.slice(start, end),
    nextCursor: end < hits.length ? String(end) : null,
  };
}

function anchorOf(t: TranscriptState, threadId: string, itemId: string): string {
  let anchor = itemId;
  let thread = t.threads[threadId];
  const seen = new Set<string>();
  while (thread?.parentThreadId && thread.parentItemId && !seen.has(thread.id)) {
    seen.add(thread.id);
    anchor = thread.parentItemId;
    thread = t.threads[thread.parentThreadId];
  }
  return anchor;
}

function snippet(text: string, terms: string[]): SnippetPart[] {
  const flat = text.replace(/\s/g, " ");
  const ranges = searchMatchRanges(flat, terms);
  const first = ranges[0]?.[0] ?? 0;
  const start = Math.max(0, Math.min(first - 40, flat.length - WIDTH));
  const end = Math.min(flat.length, start + WIDTH);
  const parts: SnippetPart[] = start > 0 ? [{ text: "…", match: false }] : [];
  let at = start;
  for (const [a, b] of ranges) {
    const from = Math.max(a, start);
    const to = Math.min(b, end);
    if (from >= to) continue;
    if (from > at) parts.push({ text: flat.slice(at, from), match: false });
    parts.push({ text: flat.slice(from, to), match: true });
    at = to;
  }
  if (at < end) parts.push({ text: flat.slice(at, end), match: false });
  if (end < flat.length) parts.push({ text: "…", match: false });
  return parts;
}

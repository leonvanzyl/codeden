import {
  type SnippetPart,
  searchableText,
  TRANSCRIPT_SEARCH_DEFAULT_LIMIT,
  TRANSCRIPT_SEARCH_MIN_TERM,
  type TranscriptSearchHit,
  type TranscriptSearchResponse,
} from "@codeden/contracts";
import type { TranscriptState } from "@/lib/transcript/reducer";
import type { TranscriptSearchRequest } from "../client";
import type { MockWorld } from "./world";

const PER_SESSION = 3;
const WIDTH = 160;

/** Lower case without accents, one UTF-16 unit per unit so offsets line up with the text. */
function fold(text: string): string {
  return text
    .split("")
    .map((ch) => ch.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase()[0] ?? ch)
    .join("");
}

/**
 * The mock's transcript search: the same searchable text as the server, matched as
 * case- and accent-insensitive substrings (every term must appear), newest session first.
 */
export function mockSearch(
  world: MockWorld,
  req: TranscriptSearchRequest,
): TranscriptSearchResponse {
  const q = req.q.trim();
  const terms = [...new Set(q.split(/\s+/).filter(Boolean).map(fold))];
  const limit = req.limit ?? TRANSCRIPT_SEARCH_DEFAULT_LIMIT;
  if (!terms.some((t) => [...t].length >= TRANSCRIPT_SEARCH_MIN_TERM)) {
    return { query: q, hits: [], truncated: false };
  }
  const sessions = world.snapshot.sessions
    .filter((s) => !req.projectId || s.projectId === req.projectId)
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  const hits: TranscriptSearchHit[] = [];
  for (const session of sessions) {
    const t = world.transcripts.get(session.id);
    if (!t) continue;
    let found = 0;
    for (const [itemId, entry] of Object.entries(t.items)) {
      if (found >= PER_SESSION) break;
      const text = searchableText(entry.item);
      const folded = fold(text);
      if (!text || !terms.every((term) => folded.includes(term))) continue;
      found++;
      hits.push({
        sessionId: session.id,
        threadId: entry.threadId,
        itemId,
        anchorItemId: anchorOf(t, entry.threadId, itemId),
        kind: entry.item.kind,
        ...(entry.item.kind === "tool_call" ? { toolKind: entry.item.toolKind } : {}),
        snippet: snippet(text, folded, terms),
        ts: t.turns[entry.turnId]?.startedAt ?? session.updatedAt,
      });
    }
  }
  return { query: q, hits: hits.slice(0, limit), truncated: hits.length > limit };
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

function snippet(text: string, folded: string, terms: string[]): SnippetPart[] {
  const flat = text.replace(/\s/g, " ");
  const first = Math.min(...terms.map((term) => folded.indexOf(term)).filter((i) => i >= 0));
  const start = Math.max(0, Math.min(first - 40, flat.length - WIDTH));
  const end = Math.min(flat.length, start + WIDTH);
  const marks = new Array<boolean>(end - start).fill(false);
  for (const term of terms) {
    for (
      let i = folded.indexOf(term, start);
      i !== -1 && i < end;
      i = folded.indexOf(term, i + 1)
    ) {
      for (let j = i; j < Math.min(end, i + term.length); j++) marks[j - start] = true;
    }
  }
  const parts: SnippetPart[] = start > 0 ? [{ text: "…", match: false }] : [];
  for (let i = start; i < end; i++) {
    const match = marks[i - start] ?? false;
    const prev = parts.at(-1);
    if (prev && prev.match === match) prev.text += flat[i];
    else parts.push({ text: flat[i] ?? "", match });
  }
  if (end < flat.length) parts.push({ text: "…", match: false });
  return parts;
}

import { z } from "zod";
import { Id, Timestamp } from "./common";
import { ToolKind } from "./items";

/**
 * Full-text search over transcripts (§6, §13): what was asked, answered and run in any session,
 * archived ones included. Served by the `item_search` projection and its FTS5 index.
 */

/** Hits per request when `limit` is omitted. */
export const TRANSCRIPT_SEARCH_DEFAULT_LIMIT = 20;
/** Search terms shorter than this can't use the index on their own (trigram index, §6). */
export const TRANSCRIPT_SEARCH_MIN_TERM = 3;

/** `GET /api/search/transcripts` query. */
export const TranscriptSearchQuery = z.object({
  /** What to look for. Whitespace separates terms; every term must appear (in any order). */
  q: z.string().trim().min(1).max(200),
  /** Only sessions of this project. */
  projectId: Id.optional(),
  /** Most hits to return (at most 3 per session). */
  limit: z.coerce.number().int().min(1).max(100).default(TRANSCRIPT_SEARCH_DEFAULT_LIMIT),
});
export type TranscriptSearchQuery = z.infer<typeof TranscriptSearchQuery>;

/** A piece of a snippet: `match` marks text that matched the query (render it highlighted). */
export const SnippetPart = z.object({
  text: z.string(),
  match: z.boolean(),
});
export type SnippetPart = z.infer<typeof SnippetPart>;

/** One transcript item that matched. Session details come from the app snapshot. */
export const TranscriptSearchHit = z.object({
  sessionId: Id,
  /** The thread holding the item: the session's root thread or a subagent's. */
  threadId: Id,
  itemId: Id,
  /**
   * The root-thread item to open: the item itself, or for an item in a subagent's thread the
   * subagent card in the root thread that started it.
   */
  anchorItemId: Id,
  /** Item kind, e.g. `user_message`, `assistant_message`, `tool_call`. */
  kind: z.string(),
  /** For tool calls, what kind of work it was (`command`, `file_edit`, ...). */
  toolKind: ToolKind.optional(),
  /** Text around the first match, in order; never HTML. */
  snippet: z.array(SnippetPart),
  /** When the item was created. */
  ts: Timestamp,
});
export type TranscriptSearchHit = z.infer<typeof TranscriptSearchHit>;

/** `GET /api/search/transcripts` response: best matches first, then newest. */
export const TranscriptSearchResponse = z.object({
  /** The query as searched (trimmed). */
  query: z.string(),
  hits: z.array(TranscriptSearchHit),
  /** True when more hits matched than `limit` allowed. */
  truncated: z.boolean(),
});
export type TranscriptSearchResponse = z.infer<typeof TranscriptSearchResponse>;

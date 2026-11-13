import { z } from "zod";
import { Id, Role, Timestamp } from "./common";
import { ToolKind } from "./items";

/**
 * Full-text search over transcripts (§6, §13): what was asked, answered and run in any session,
 * archived ones included unless left out. Served by the `item_search` projection and its FTS5
 * index, newest match first, a page at a time.
 */

/** Hits per request when `limit` is omitted. */
export const TRANSCRIPT_SEARCH_DEFAULT_LIMIT = 20;
/** Most hits one request returns; page with `cursor` for more. */
export const TRANSCRIPT_SEARCH_MAX_LIMIT = 100;
/** Search terms shorter than this can't use the index on their own (trigram index, §6). */
export const TRANSCRIPT_SEARCH_MIN_TERM = 3;

/** A boolean from a query string (`true`/`false`) or from code. */
const QueryBoolean = z.union([
  z.boolean(),
  z.enum(["true", "false"]).transform((v) => v === "true"),
]);

/** `GET /api/search/transcripts` query. */
export const TranscriptSearchQuery = z.object({
  /**
   * What to look for. Whitespace separates terms; every term must appear (in any order),
   * ignoring case and accents. Control characters are ignored.
   */
  q: z.string().trim().min(1).max(200),
  /** Only sessions of this project. */
  projectId: Id.optional(),
  /** Only sessions with this role (§8.1). */
  role: Role.optional(),
  /** Whether matches in archived sessions are included (they are by default). */
  includeArchived: QueryBoolean.default(true),
  /**
   * Continue after the previous page: its `nextCursor`. Omit for the newest matches. Opaque to
   * clients.
   */
  cursor: z
    .string()
    .regex(/^\d{1,16}$/)
    .optional(),
  /** Most hits to return. */
  limit: z.coerce
    .number()
    .int()
    .min(1)
    .max(TRANSCRIPT_SEARCH_MAX_LIMIT)
    .default(TRANSCRIPT_SEARCH_DEFAULT_LIMIT),
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
   * The root-thread item to scroll to: the item itself, or for an item in a subagent's thread
   * the subagent card in the root thread that started it. Such a hit also opens `threadId` at
   * `itemId`.
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

/** `GET /api/search/transcripts` response: newest matches first. */
export const TranscriptSearchResponse = z.object({
  /** The query as searched (trimmed, without control characters). */
  query: z.string(),
  hits: z.array(TranscriptSearchHit),
  /**
   * Pass as `cursor` to get the next page; null when every match has been returned. A page can
   * hold fewer than `limit` hits and still have a next one: each request looks at a bounded
   * number of candidates so a search never holds up the server.
   */
  nextCursor: z.string().nullable(),
});
export type TranscriptSearchResponse = z.infer<typeof TranscriptSearchResponse>;

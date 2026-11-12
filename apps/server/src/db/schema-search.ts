import { integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

/**
 * Transcript search (§6): the searchable text of each transcript item, a projection written in
 * the same transaction as the item (`services/search/index-items.ts`). The migration adds the
 * FTS5 index `item_search_fts` over `text` (trigram tokenizer) and the triggers that keep it in
 * step with this table, so code only ever writes rows here.
 */
export const itemSearch = sqliteTable(
  "item_search",
  {
    /** Stable row id; it is also the FTS5 rowid. */
    id: integer("id").primaryKey({ autoIncrement: true }),
    sessionId: text("session_id").notNull(),
    itemId: text("item_id").notNull(),
    threadId: text("thread_id").notNull(),
    kind: text("kind").notNull(),
    toolKind: text("tool_kind"),
    text: text("text").notNull(),
    createdAt: text("created_at").notNull(),
  },
  (t) => [uniqueIndex("item_search_item").on(t.sessionId, t.itemId)],
);

import { integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

/**
 * Transcript search (§6): the searchable text of each transcript item, a projection written in
 * the same transaction as the item (`services/search/index-writer.ts`). The migration adds the
 * FTS5 index `item_search_fts` over `text` (trigram tokenizer, `detail=none`) and the triggers
 * that keep it in step with this table, so code only ever writes rows here. Everything else
 * about a hit (thread, kind, time) is read from `items` for the page being returned.
 */
export const itemSearch = sqliteTable(
  "item_search",
  {
    /**
     * Also the FTS5 rowid: the item's rowid in `items`, so ids follow the order items were
     * created in and the index lists matches newest first, however late an item was indexed.
     */
    id: integer("id").primaryKey(),
    sessionId: text("session_id").notNull(),
    itemId: text("item_id").notNull(),
    text: text("text").notNull(),
  },
  (t) => [uniqueIndex("item_search_item").on(t.sessionId, t.itemId)],
);

/**
 * How far the background backfill (§6) has read `items`: every item with a rowid up to
 * `afterRowid` has been indexed. One row, id 1; no row means nothing has been read yet.
 */
export const itemSearchBackfill = sqliteTable("item_search_backfill", {
  id: integer("id").primaryKey(),
  afterRowid: integer("after_rowid").notNull(),
});

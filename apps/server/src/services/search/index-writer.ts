import type { Item } from "@codeden/contracts";
import { and, eq, sql } from "drizzle-orm";
import { items } from "../../db/schema";
import type { Tx } from "../../events/projection-db";
import { indexedText } from "./item-text";

/**
 * Keep one item's search row in step with the item (§6), inside the projection transaction
 * (the `items` row is written first). The FTS5 index follows `item_search` through triggers,
 * and only re-tokenizes when the text changed. An item with nothing to search has no row.
 *
 * A new row takes the item's rowid in `items`, so the index orders matches by when items were
 * created, whether an item is indexed live or later by the backfill. Should that id be taken
 * (rowids renumbered by a manual VACUUM), the row goes after every other one instead of failing
 * the projection.
 */
export function indexItem(tx: Tx, sessionId: string, item: Item): void {
  const itemId = item.id;
  const text = indexedText(item);
  if (!text) {
    tx.run(sql`DELETE FROM item_search WHERE session_id = ${sessionId} AND item_id = ${itemId}`);
    return;
  }
  tx.run(sql`
    INSERT INTO item_search (id, session_id, item_id, text)
    SELECT
      CASE WHEN r IS NULL OR EXISTS (SELECT 1 FROM item_search WHERE id = r)
        THEN (SELECT coalesce(max(id), 0) + 1 FROM item_search)
        ELSE r END,
      ${sessionId}, ${itemId}, ${text}
    FROM (SELECT (SELECT rowid FROM items WHERE session_id = ${sessionId} AND id = ${itemId}) AS r)
    WHERE true
    ON CONFLICT (session_id, item_id) DO UPDATE SET text = excluded.text
      WHERE item_search.text IS NOT excluded.text
  `);
}

/**
 * Index a finished turn's items that are still in progress: a reply cut off mid-stream had only
 * deltas since it started, which skip the index.
 */
export function indexUnfinishedItems(tx: Tx, sessionId: string, turnId: string): void {
  const rows = tx
    .select()
    .from(items)
    .where(
      and(
        eq(items.sessionId, sessionId),
        eq(items.turnId, turnId),
        eq(items.status, "in_progress"),
      ),
    )
    .all();
  for (const row of rows) indexItem(tx, sessionId, row.data);
}

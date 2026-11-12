import type { ItemRecord } from "@codeden/contracts";
import { and, asc, eq, gt, sql } from "drizzle-orm";
import type { Db } from "../../db/client";
import { rowToItemRecord } from "../../db/rows";
import { items } from "../../db/schema";
import { itemSearch } from "../../db/schema-search";
import type { Tx } from "../../events/projection-db";
import { indexedText } from "./item-text";

/**
 * Keep one item's search row in step with the item (§6), inside the projection transaction.
 * The FTS5 index follows `item_search` through triggers, and only re-tokenizes when the text
 * changed. An item with nothing to search has no row.
 */
export function indexItem(tx: Tx, record: ItemRecord): void {
  const { item } = record;
  const text = indexedText(item);
  if (!text) {
    tx.delete(itemSearch)
      .where(and(eq(itemSearch.sessionId, record.sessionId), eq(itemSearch.itemId, item.id)))
      .run();
    return;
  }
  const row = {
    sessionId: record.sessionId,
    itemId: item.id,
    threadId: record.threadId,
    kind: item.kind,
    toolKind: item.kind === "tool_call" ? item.toolKind : null,
    text,
    createdAt: record.createdAt,
  };
  tx.insert(itemSearch)
    .values(row)
    .onConflictDoUpdate({
      target: [itemSearch.sessionId, itemSearch.itemId],
      set: { threadId: row.threadId, kind: row.kind, toolKind: row.toolKind, text },
    })
    .run();
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
  for (const row of rows) indexItem(tx, rowToItemRecord(row));
}

const BACKFILL_BATCH = 500;

/**
 * Index the items stored before transcript search existed: runs when `item_search` is empty
 * but `items` is not (the first start after the upgrade), in one transaction so an interrupted
 * backfill simply runs again. Returns how many items it read.
 */
export function backfillSearchIndex(db: Db): number {
  // A migrations folder from before transcript search (tests stand in for older builds).
  const tables = db.all<{ name: string }>(
    sql`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'item_search'`,
  );
  if (tables.length === 0) return 0;
  if (db.select({ id: itemSearch.id }).from(itemSearch).limit(1).get()) return 0;
  if (!db.select({ id: items.id }).from(items).limit(1).get()) return 0;
  return db.transaction((tx) => {
    const rowid = sql<number>`${items}.rowid`;
    let after = 0;
    let read = 0;
    for (;;) {
      const batch = tx
        .select({ rowid, row: items })
        .from(items)
        .where(gt(rowid, after))
        .orderBy(asc(rowid))
        .limit(BACKFILL_BATCH)
        .all();
      for (const { rowid: id, row } of batch) {
        after = id;
        read++;
        indexStored(tx, rowToItemRecord(row));
      }
      if (batch.length < BACKFILL_BATCH) return read;
    }
  });
}

/** Rows written by older builds may not match today's item shapes: skip what can't be read. */
function indexStored(tx: Tx, record: ItemRecord): void {
  try {
    indexItem(tx, record);
  } catch {
    // Not indexable; the item still shows in its transcript.
  }
}

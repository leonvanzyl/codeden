import type { StatementSync } from "node:sqlite";
import type { Item } from "@codeden/contracts";
import { eq } from "drizzle-orm";
import type { Db } from "../../db/client";
import { itemSearchBackfill } from "../../db/schema-search";
import type { Tx } from "../../events/projection-db";
import { indexItem } from "./index-writer";
import { indexedText } from "./item-text";

/**
 * Items read per transaction. Each batch holds the event loop (`node:sqlite` is synchronous):
 * at this size about 25 ms, now and then a few hundred when FTS5 merges its segments.
 */
export const BACKFILL_BATCH = 500;
/** How often a running backfill logs its progress. */
const PROGRESS_EVERY_MS = 5_000;

export interface SearchBackfillOptions {
  log?: (message: string) => void;
  batchSize?: number;
  /** Clock for the progress log (tests). */
  now?: () => number;
}

interface StoredItem {
  rowid: number;
  session_id: string;
  id: string;
  data: string;
}

interface Statements {
  pending: StatementSync;
  read: StatementSync;
  upsert: StatementSync;
  remove: StatementSync;
}

/**
 * Indexes the items transcript search hasn't seen (§6), in the background once the server
 * listens: every item stored before search existed, and items an older build wrote in between.
 * It reads `items` in rowid order, a batch per transaction that also saves where it got to, so
 * an interrupted backfill continues from there. Search returns what is indexed so far.
 */
export class SearchBackfill {
  private stopped = false;
  private running: Promise<void> | undefined;
  private prepared: Statements | undefined;

  constructor(
    private readonly db: Db,
    private readonly opts: SearchBackfillOptions = {},
  ) {}

  /** Start in the background (once). Failures are logged, never thrown. */
  start(): void {
    this.running ??= this.run().catch((error: unknown) => {
      this.opts.log?.(`search: indexing transcripts stopped: ${String(error)}`);
    });
  }

  /** Stop after the current batch; resolves once it has. */
  async stop(): Promise<void> {
    this.stopped = true;
    await this.running;
  }

  /** How many stored items the backfill hasn't read yet. */
  pending(): number {
    const row = this.statements().pending.get(resumePoint(this.db)) as { n: number };
    return row.n;
  }

  /** Index the next batch in one transaction. Returns how many items it read; 0 when done. */
  step(): number {
    const s = this.statements();
    return this.db.transaction((tx) => {
      const batch = s.read.all(resumePoint(tx), this.opts.batchSize ?? BACKFILL_BATCH);
      const last = batch.at(-1) as StoredItem | undefined;
      if (!last) return 0;
      for (const row of batch) this.index(tx, s, row as unknown as StoredItem);
      tx.insert(itemSearchBackfill)
        .values({ id: 1, afterRowid: last.rowid })
        .onConflictDoUpdate({ target: itemSearchBackfill.id, set: { afterRowid: last.rowid } })
        .run();
      return batch.length;
    });
  }

  /** Read every batch, yielding to the event loop between them, and log the progress. */
  async run(): Promise<void> {
    const log = this.opts.log ?? (() => {});
    const now = this.opts.now ?? Date.now;
    const total = this.pending();
    if (total === 0) return;
    log(`search: indexing ${total} transcript items in the background`);
    const started = now();
    let lastLog = started;
    let read = 0;
    while (!this.stopped) {
      const n = this.step();
      if (n === 0) {
        log(`search: indexed ${read} transcript items in ${seconds(now() - started)}`);
        return;
      }
      read += n;
      if (now() - lastLog >= PROGRESS_EVERY_MS) {
        lastLog = now();
        log(`search: indexed ${Math.min(read, total)} of ${total} transcript items`);
      }
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
  }

  /**
   * One stored item, written straight to `item_search` with its rowid as the row id (as
   * `indexItem` does, with one prepared statement for the whole backfill).
   */
  private index(tx: Tx, s: Statements, row: StoredItem): void {
    let item: Item;
    let text: string;
    try {
      item = JSON.parse(row.data) as Item;
      text = indexedText(item);
    } catch {
      // Rows older builds wrote may not match today's item shapes: not indexable, but the
      // item still shows in its transcript.
      return;
    }
    try {
      if (text) s.upsert.run(row.rowid, row.session_id, row.id, text);
      else s.remove.run(row.session_id, row.id);
    } catch {
      // The rowid is already another row's id (rowids renumbered by a manual VACUUM).
      indexItem(tx, row.session_id, item);
    }
  }

  private statements(): Statements {
    const c = this.db.$client;
    this.prepared ??= {
      pending: c.prepare("SELECT count(*) AS n FROM items WHERE rowid > ?"),
      read: c.prepare(
        "SELECT rowid, session_id, id, data FROM items WHERE rowid > ? ORDER BY rowid LIMIT ?",
      ),
      upsert: c.prepare(`
        INSERT INTO item_search (id, session_id, item_id, text) VALUES (?, ?, ?, ?)
        ON CONFLICT (session_id, item_id) DO UPDATE SET text = excluded.text
          WHERE item_search.text IS NOT excluded.text`),
      remove: c.prepare("DELETE FROM item_search WHERE session_id = ? AND item_id = ?"),
    };
    return this.prepared;
  }
}

function seconds(ms: number): string {
  return `${(ms / 1000).toFixed(1)} s`;
}

/** The rowid of the last item the backfill has read; 0 before it has read any. */
function resumePoint(db: Db | Tx): number {
  return (
    db
      .select({ after: itemSearchBackfill.afterRowid })
      .from(itemSearchBackfill)
      .where(eq(itemSearchBackfill.id, 1))
      .get()?.after ?? 0
  );
}

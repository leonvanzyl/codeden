import type { DatabaseSync, StatementSync } from "node:sqlite";

/**
 * The tokenizer of the transcript search index (`item_search_fts`, created by the
 * `search_newest_first` migration). The trigrams of a query must come from the same one.
 */
export const SEARCH_TOKENIZER = "trigram remove_diacritics 1";

interface Scratch {
  clear: StatementSync;
  insert: StatementSync;
  tokens: StatementSync;
}

const scratchTables = new WeakMap<DatabaseSync, Scratch>();

/**
 * The trigrams the index's tokenizer makes of the terms, in order, each once: case folded,
 * accents removed and combining marks dropped exactly as when the text was indexed. The terms
 * are tokenized in a scratch FTS5 table with the same tokenizer (in the connection's temp
 * schema) and read back through `fts5vocab`, so a term whose marks NFC can't compose (`x` plus
 * a combining acute) still yields the trigrams its text was indexed under. A term with fewer
 * than 3 characters left yields none.
 */
export function termTrigrams(client: DatabaseSync, terms: string[]): string[] {
  const scratch = scratchFor(client);
  scratch.clear.run();
  terms.forEach((term, i) => {
    scratch.insert.run(i + 1, term);
  });
  const rows = scratch.tokens.all() as { term: string }[];
  scratch.clear.run();
  return [...new Set(rows.map((r) => r.term))];
}

function scratchFor(client: DatabaseSync): Scratch {
  let scratch = scratchTables.get(client);
  if (!scratch) {
    client.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS temp.search_query
        USING fts5(text, tokenize='${SEARCH_TOKENIZER}');
      CREATE VIRTUAL TABLE IF NOT EXISTS temp.search_query_tokens
        USING fts5vocab(temp, search_query, instance);
    `);
    scratch = {
      clear: client.prepare("DELETE FROM temp.search_query"),
      insert: client.prepare("INSERT INTO temp.search_query (rowid, text) VALUES (?, ?)"),
      tokens: client.prepare("SELECT term FROM temp.search_query_tokens ORDER BY doc, offset"),
    };
    scratchTables.set(client, scratch);
  }
  return scratch;
}

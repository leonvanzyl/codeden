/**
 * Transcript search at scale: builds a database of synthetic transcript items as an older build
 * left it (before the search index existed), then measures what the first start after the
 * upgrade costs (opening, the background backfill and its longest batch, an interrupted
 * backfill, the size) and how long queries take, filtered and paged.
 *
 *   node --import tsx apps/server/scripts/search-bench.ts [--items 300000] [--keep] [--build-only]
 *
 * Not part of `pnpm test`: it takes minutes and writes hundreds of megabytes to the temp folder.
 */
import { spawn } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";
import { TranscriptSearchQuery } from "@codeden/contracts";
import { findMigrationsDir, openDatabase } from "../src/db/client";
import { SearchBackfill } from "../src/services/search/backfill";
import { searchTranscripts } from "../src/services/search/search";

const args = process.argv.slice(2);
const flag = (name: string) => args.includes(`--${name}`);
const option = (name: string, fallback: number) => {
  const at = args.indexOf(`--${name}`);
  return at === -1 ? fallback : Number(args[at + 1]);
};

const ITEMS = option("items", 300_000);
const ITEMS_PER_SESSION = 100;
const QUERIES = ["the", "prisma", "cart hook a", "useCartHook", "webhook retry", "zzqx"];

const all = findMigrationsDir();
const dir = mkdtempSync(join(tmpdir(), "codeden-search-bench-"));

/** The migrations folder of the build before transcript search. */
function olderMigrations(): string {
  const out = join(dir, "older-migrations");
  for (const name of readdirSync(all).filter((n) => /^\d{14}_/.test(n))) {
    if (/_(transcript_search|search_newest_first)$/.test(name)) continue;
    mkdirSync(join(out, name), { recursive: true });
    copyFileSync(join(all, name, "migration.sql"), join(out, name, "migration.sql"));
  }
  return out;
}

/** Deterministic PRNG (mulberry32) so every run builds the same database. */
function prng(seed: number): () => number {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const COMMON =
  "the a to and of in is it that for on with this be as are at by we not you from or have an was can will if but".split(
    " ",
  );
const TECH =
  "prisma migrate webhook retry cart hook reducer checkout deploy test pnpm build lint typecheck server runner session thread item event projection index query schema table column route handler component state store fetch error warning timeout backoff config setting provider model token cost usage branch commit merge rebase worktree".split(
    " ",
  );
const random = prng(91);
const pick = <T>(list: T[]): T => list[Math.floor(random() ** 2 * list.length)] as T;
const ident = () =>
  `${pick(["use", "get", "set", "make", "handle"])}${cap(pick(TECH))}${cap(pick(TECH))}`;
const cap = (s: string) => s[0]?.toUpperCase() + s.slice(1);

function sentence(words: number): string {
  const out: string[] = [];
  for (let i = 0; i < words; i++) {
    const r = random();
    out.push(r < 0.45 ? pick(COMMON) : r < 0.85 ? pick(TECH) : r < 0.95 ? ident() : "useCartHook");
  }
  return `${cap(out.join(" "))}.`;
}

function item(id: string, n: number): { kind: string; data: object } {
  const r = random();
  if (r < 0.2) {
    return {
      kind: "user_message",
      data: {
        id,
        kind: "user_message",
        status: "completed",
        input: { text: sentence(12 + n), attachments: [] },
      },
    };
  }
  if (r < 0.55) {
    return {
      kind: "assistant_message",
      data: { id, kind: "assistant_message", status: "completed", text: sentence(30 + n * 3) },
    };
  }
  if (r < 0.8) {
    const command = `pnpm ${pick(["test", "build", "lint", "exec prisma migrate dev", "typecheck"])} --filter ${pick(TECH)}`;
    return {
      kind: "tool_call",
      data: {
        id,
        kind: "tool_call",
        status: "completed",
        toolKind: "command",
        toolName: "Bash",
        title: `Run ${command}`,
        command,
        output: sentence(40),
      },
    };
  }
  if (r < 0.9) {
    const path = `src/${pick(TECH)}/${ident()}.ts`;
    return {
      kind: "tool_call",
      data: {
        id,
        kind: "tool_call",
        status: "completed",
        toolKind: "file_read",
        toolName: "Read",
        title: `Read ${path}`,
        path,
      },
    };
  }
  return {
    kind: "reasoning",
    data: { id, kind: "reasoning", status: "completed", text: sentence(60) },
  };
}

function build(file: string): void {
  const old = openDatabase(file, olderMigrations());
  const c = old.client;
  const session = c.prepare(
    "INSERT INTO sessions (id, project_id, role, started_by, purpose, work_key, scope, provider, autonomy, status, cwd, created_at, updated_at, archived_at) VALUES (?, ?, ?, '{\"kind\":\"user\"}', 'bench', ?, '{}', 'fake', 'auto', 'idle', '/tmp', ?, ?, ?)",
  );
  const thread = c.prepare("INSERT INTO threads (session_id, id, created_at) VALUES (?, 't1', ?)");
  const insert = c.prepare(
    "INSERT INTO items (session_id, id, thread_id, turn_id, position, kind, status, data, created_at, updated_at) VALUES (?, ?, 't1', 'u1', ?, ?, 'completed', ?, ?, ?)",
  );
  const start = Date.parse("2026-01-01T00:00:00.000Z");
  c.exec("BEGIN");
  for (let i = 0; i < ITEMS; i++) {
    const s = Math.floor(i / ITEMS_PER_SESSION);
    const sid = `s${s}`;
    const ts = new Date(start + i * 60_000).toISOString();
    if (i % ITEMS_PER_SESSION === 0) {
      const role = s % 20 === 0 ? "pm" : "agent";
      session.run(sid, `p${s % 7}`, role, `k${s}`, ts, ts, s % 3 === 0 ? ts : null);
      thread.run(sid, ts);
    }
    const { kind, data } = item(`i${i}`, i % 9);
    insert.run(sid, `i${i}`, i % ITEMS_PER_SESSION, kind, JSON.stringify(data), ts, ts);
  }
  c.exec("COMMIT");
  c.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  old.close();
}

const mb = (file: string) => {
  let bytes = 0;
  for (const f of [file, `${file}-wal`]) {
    try {
      bytes += statSync(f).size;
    } catch {}
  }
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
};

function count(file: string, sql: string): number {
  const c = new DatabaseSync(file);
  try {
    return (c.prepare(sql).get() as { n: number }).n;
  } finally {
    c.close();
  }
}

/**
 * Start the backfill in a child process, kill it `afterMs` after its first batch committed (so
 * a slow start doesn't eat the time), report what survived.
 */
async function interrupted(file: string, afterMs: number): Promise<number> {
  const src = (path: string) => JSON.stringify(pathToFileURL(join(import.meta.dirname, path)).href);
  const script = `
    import { openDatabase } from ${src("../src/db/client.ts")};
    import { SearchBackfill } from ${src("../src/services/search/backfill.ts")};
    const database = openDatabase(${JSON.stringify(file)});
    const backfill = new SearchBackfill(database.db);
    backfill.step();
    console.log("first batch committed");
    await backfill.run();
    database.close();`;
  const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], {
    stdio: ["ignore", "pipe", "inherit"],
  });
  const exited = new Promise((r) => child.once("exit", r));
  let timer: NodeJS.Timeout | undefined;
  child.stdout.on("data", (chunk: Buffer) => {
    if (!timer && chunk.toString().includes("first batch committed")) {
      timer = setTimeout(() => child.kill("SIGKILL"), afterMs);
    }
  });
  await exited;
  clearTimeout(timer);
  return count(file, "SELECT count(*) AS n FROM item_search");
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)] ?? 0;
}

async function main() {
  const file = join(dir, "codeden.db");
  let t = performance.now();
  build(file);
  const before = mb(file);
  console.log(
    `built ${ITEMS} items in ${((performance.now() - t) / 1000).toFixed(1)} s: ${before}`,
  );
  if (flag("build-only")) {
    console.log(`kept ${file}`);
    return;
  }

  const copy = join(dir, "interrupted.db");
  copyFileSync(file, copy);
  const survived = await interrupted(copy, 4_000);
  const resumed = openDatabase(copy, all);
  const left = new SearchBackfill(resumed.db).pending();
  resumed.close();
  console.log(
    `killed the backfill 4 s after its first batch: ${survived} rows in item_search kept, ${left} items left to read on the next start`,
  );

  t = performance.now();
  const database = openDatabase(file, all);
  const opened = performance.now() - t;
  console.log(`openDatabase (first start after the upgrade): ${opened.toFixed(0)} ms`);

  // The backfill as the server runs it, timing each batch (how long the event loop is held).
  const backfill = new SearchBackfill(database.db);
  const steps: number[] = [];
  t = performance.now();
  for (;;) {
    const start = performance.now();
    const n = backfill.step();
    steps.push(performance.now() - start);
    if (n === 0) break;
  }
  const total = performance.now() - t;
  database.client.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  const indexed = count(file, "SELECT count(*) AS n FROM item_search");
  console.log(
    `backfill: ${indexed} rows in ${(total / 1000).toFixed(1)} s over ${steps.length} batches; longest batch ${Math.max(...steps).toFixed(0)} ms, median ${median(steps).toFixed(0)} ms`,
  );
  console.log(`size: ${before} before, ${mb(file)} after`);
  const sizes = new DatabaseSync(file);
  const part = (sql: string) =>
    `${(((sizes.prepare(sql).get() as { n: number }).n ?? 0) / 1024 / 1024).toFixed(1)} MB`;
  console.log(
    `  index ${part("SELECT sum(length(block)) AS n FROM item_search_fts_data")}, text ${part("SELECT sum(length(text)) AS n FROM item_search")}`,
  );
  sizes.close();

  const plan = database.client
    .prepare(
      "EXPLAIN QUERY PLAN SELECT s.id FROM item_search_fts f JOIN item_search s ON s.id = f.rowid LEFT JOIN sessions ss ON ss.id = s.session_id WHERE item_search_fts MATCH ? AND f.rowid < ? ORDER BY f.rowid DESC",
    )
    .all('"the"', 1e16);
  console.log(`plan: ${plan.map((r) => (r as { detail: string }).detail).join(" | ")}`);

  const run = (q: string, extra: Record<string, unknown> = {}) =>
    searchTranscripts(database.db, TranscriptSearchQuery.parse({ q, ...extra }));
  const cases: [string, Record<string, unknown>][] = [
    ...QUERIES.map((q): [string, Record<string, unknown>] => [q, {}]),
    ["the", { limit: 100 }],
    ["prisma", { role: "pm" }],
    ["prisma", { includeArchived: false }],
    ["prisma", { projectId: "p3" }],
    ["prisma", { role: "orchestrator" }],
    ["foo\u0000bar", {}],
  ];
  for (const [q, extra] of cases) {
    const times: number[] = [];
    let res = run(q, extra);
    for (let i = 0; i < 5; i++) {
      const start = performance.now();
      res = run(q, extra);
      times.push(performance.now() - start);
    }
    const label = `${JSON.stringify(q)} ${JSON.stringify(extra)}`;
    console.log(
      `search ${label.padEnd(40)} median ${median(times).toFixed(1)} ms (${res.hits.length} hits, ${res.nextCursor ? "more" : "end"})`,
    );
  }
  // Page 2 of a common term.
  const first = run("prisma");
  const times: number[] = [];
  for (let i = 0; i < 5; i++) {
    const start = performance.now();
    run("prisma", { cursor: first.nextCursor });
    times.push(performance.now() - start);
  }
  console.log(`search "prisma" page 2 median ${median(times).toFixed(1)} ms`);
  database.close();
  if (!flag("keep")) rmSync(dir, { recursive: true, force: true });
  else console.log(`kept ${dir}`);
}

await main();

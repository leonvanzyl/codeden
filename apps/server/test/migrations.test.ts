import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { findMigrationsDir, openDatabase } from "../src/db/client";
import { SearchBackfill } from "../src/services/search/backfill";
import { SEARCH_TOKENIZER } from "../src/services/search/trigrams";

const all = findMigrationsDir();
const names = readdirSync(all).filter((n) => /^\d{14}_/.test(n));
const temps: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "codeden-migrations-"));
  temps.push(dir);
  return dir;
}

/**
 * A migrations folder with only some of the migrations, to stand in for an older build. Only
 * `migration.sql` is copied: the migrator reads nothing else, and each `snapshot.json` is
 * thousands of lines that a Windows runner's virus scanner checks file by file.
 */
function partialMigrations(keep: (name: string) => boolean): string {
  const dir = tempDir();
  for (const name of names.filter(keep)) {
    mkdirSync(join(dir, name));
    copyFileSync(join(all, name, "migration.sql"), join(dir, name, "migration.sql"));
  }
  return dir;
}

function columns(client: ReturnType<typeof openDatabase>["client"], table: string): string[] {
  return (client.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map(
    (c) => c.name,
  );
}

function expectFullSchema(file: string): void {
  const database = openDatabase(file, all);
  try {
    const tables = (
      database.client.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as {
        name: string;
      }[]
    ).map((t) => t.name);
    expect(tables).toEqual(
      expect.arrayContaining([
        "github_sync_state",
        "notices",
        "conflicts",
        "usage_ledger",
        "rate_limit_windows",
        "automation_schedules",
        "automation_projects",
        "factory_loops",
        "factory_items",
        "factory_digests",
        "runners",
      ]),
    );
    expect(columns(database.client, "automations")).toContain("work_key");
    expect(columns(database.client, "projects")).toEqual(
      expect.arrayContaining(["pinned", "sort_order"]),
    );
    expect(columns(database.client, "github_prs")).toEqual(
      expect.arrayContaining(["review_decision", "linked_issues", "merged_at"]),
    );
    expect(columns(database.client, "notices")).toContain("not_before");
    expect(tables).toEqual(expect.arrayContaining(["item_search", "item_search_fts"]));
    expect(columns(database.client, "runners")).toEqual([
      "id",
      "backend",
      "is_home",
      "runner_id",
      "sandbox_ref",
      "project_id",
      "session_id",
      "state",
      "version",
      "image_version",
      "created_at",
      "last_seen_at",
      "last_error",
    ]);
    const applied = (
      database.client.prepare("SELECT name FROM __drizzle_migrations").all() as { name: string }[]
    ).map((m) => m.name);
    expect(applied.sort()).toEqual([...names].sort());
  } finally {
    database.close();
  }
}

afterEach(() => {
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});

// Each case creates and migrates SQLite databases through every migration; on a busy Windows
// runner that has taken longer than the default 5 s.
describe("migrations", { timeout: 30_000 }, () => {
  it("chain in timestamp order: GitHub sync, orchestration, usage ledger, factory loop, automations", () => {
    expect(names).toEqual([...names].sort());
    const at = (suffix: string) => names.findIndex((n) => n.endsWith(suffix));
    expect(at("_github_sync")).toBeGreaterThan(-1);
    expect(at("_orchestration")).toBeGreaterThan(at("_github_sync"));
    expect(at("_usage_ledger")).toBeGreaterThan(at("_orchestration"));
    expect(at("_factory_loop")).toBeGreaterThan(at("_usage_ledger"));
    expect(at("_automations")).toBeGreaterThan(at("_factory_loop"));
  });

  it("create the full schema on a fresh database", () => {
    expectFullSchema(join(tempDir(), "fresh.db"));
  });

  /**
   * Builds with only one of the GitHub sync, orchestration and usage ledger migrations existed
   * only while those three were separate branches, before any later migration (some of which
   * change their tables).
   */
  const trio = (n: string) => n.slice(0, 14) <= "20261107120509";

  it.each([
    ["orchestration only", (n: string) => trio(n) && !/_(github_sync|usage_ledger)$/.test(n)],
    ["GitHub sync only", (n: string) => trio(n) && !/_(orchestration|usage_ledger)$/.test(n)],
    ["usage ledger only", (n: string) => trio(n) && !/_(github_sync|orchestration)$/.test(n)],
    [
      "everything before the usage ledger",
      // Only migrations that existed then: later ones (e.g. `rate_limit_percent_at`) alter its tables.
      (n: string) =>
        n.slice(0, 14) <= "20261107130421" && !/_(usage_ledger|factory_loop|automations)$/.test(n),
    ],
    // The previous main: automations shipped first, so factory_loop arrives with an older timestamp.
    ["everything but the factory loop", (n: string) => !n.endsWith("_factory_loop")],
    ["everything but automations", (n: string) => !n.endsWith("_automations")],
    ["everything before the factory loop", (n: string) => !/_(factory_loop|automations)$/.test(n)],
  ])("upgrade a database that applied %s", (_label, keep) => {
    const file = join(tempDir(), "old.db");
    openDatabase(file, partialMigrations(keep)).close();
    expectFullSchema(file);
  });

  it("backfill the project order from the old alphabetical listing", () => {
    const file = join(tempDir(), "before-pinning.db");
    const old = openDatabase(
      file,
      partialMigrations((n) => !n.endsWith("_project_pin_order")),
    );
    const insert = old.client.prepare(
      "INSERT INTO projects (id, kind, name, slug, path, created_at, updated_at) VALUES (?, 'local', ?, ?, ?, 'x', 'x')",
    );
    for (const [id, name] of [
      ["p1", "notes-cli"],
      ["p2", "Storefront"],
      ["p4", "Billing API"],
      ["p3", "Billing API"],
    ] as const) {
      insert.run(id, name, id, `/code/${id}`);
    }
    old.close();
    const database = openDatabase(file, all);
    try {
      const rows = database.client
        .prepare("SELECT id, pinned, sort_order FROM projects ORDER BY sort_order")
        .all();
      // Upper case sorts before lower case, as the old `ORDER BY name` did; ids break ties.
      expect(rows).toEqual([
        { id: "p3", pinned: 0, sort_order: 0 },
        { id: "p4", pinned: 0, sort_order: 1 },
        { id: "p2", pinned: 0, sort_order: 2 },
        { id: "p1", pinned: 0, sort_order: 3 },
      ]);
    } finally {
      database.close();
    }
  });

  describe("transcript search", () => {
    const search = (database: ReturnType<typeof openDatabase>, trigrams: string) =>
      database.client
        .prepare(
          "SELECT s.item_id FROM item_search_fts f JOIN item_search s ON s.id = f.rowid WHERE item_search_fts MATCH ? ORDER BY s.item_id",
        )
        .all(trigrams);
    const rows = (database: ReturnType<typeof openDatabase>) =>
      (database.client.prepare("SELECT count(*) AS n FROM item_search").get() as { n: number }).n;

    function storeItems(database: ReturnType<typeof openDatabase>, stored: object[]): void {
      const insert = database.client.prepare(
        "INSERT INTO items (session_id, id, thread_id, turn_id, position, kind, status, data, created_at, updated_at) VALUES ('s1', ?, 't1', 'u1', ?, ?, 'completed', ?, ?, ?)",
      );
      stored.forEach((item, i) => {
        const { id, kind } = item as { id: string; kind: string };
        const ts = new Date(Date.UTC(2026, 10, 1, 10, i)).toISOString();
        insert.run(id, i, kind, JSON.stringify({ status: "completed", ...item }), ts, ts);
      });
    }

    const stored = [
      { id: "m1", kind: "user_message", input: { text: "Where is the webhook retry?" } },
      { id: "a1", kind: "assistant_message", text: "In src/webhooks/retry.ts" },
      { id: "r1", kind: "reasoning", text: "webhook thoughts are not indexed" },
      // An old row this build can't read: skipped, not fatal.
      { id: "x1", kind: "user_message" },
      { id: "a2", kind: "assistant_message", text: "The webhook retries three times" },
      { id: "a3", kind: "assistant_message", text: "Done" },
      { id: "a4", kind: "assistant_message", text: "Retry backoff doubles" },
    ];

    it("add the index; the server indexes stored items in the background, resuming after an interruption", async () => {
      const file = join(tempDir(), "before-search.db");
      const old = openDatabase(
        file,
        partialMigrations((n) => !/_(transcript_search|search_newest_first)$/.test(n)),
      );
      storeItems(old, stored);
      old.close();

      const first = openDatabase(file, all);
      // Opening the database (before the server listens) indexes nothing.
      expect(rows(first)).toBe(0);
      expect(new SearchBackfill(first.db).pending()).toBe(7);
      // The first batch commits, then the process stops.
      expect(new SearchBackfill(first.db, { batchSize: 3 }).step()).toBe(3);
      first.close();

      const database = openDatabase(file, all);
      try {
        const log: string[] = [];
        let clock = 0;
        const backfill = new SearchBackfill(database.db, {
          batchSize: 3,
          log: (m) => log.push(m),
          now: () => (clock += 6_000),
        });
        expect(backfill.pending()).toBe(4);
        await backfill.run();
        expect(log).toEqual([
          "search: indexing 4 transcript items in the background",
          "search: indexed 3 of 4 transcript items",
          "search: indexed 4 of 4 transcript items",
          expect.stringMatching(/^search: indexed 4 transcript items in [\d.]+ s$/),
        ]);
        // Every indexable item once: not the reasoning, not the unreadable row.
        expect(rows(database)).toBe(5);
        expect(search(database, '"web" "ebh" "bho" "hoo" "ook"')).toEqual([
          { item_id: "a1" },
          { item_id: "a2" },
          { item_id: "m1" },
        ]);
        // Newest first follows the items' times, not the order they were indexed in.
        const order = database.client
          .prepare("SELECT item_id FROM item_search ORDER BY id DESC")
          .all()
          .map((r) => (r as { item_id: string }).item_id);
        expect(order).toEqual(["a4", "a3", "a2", "a1", "m1"]);
        const triggers = database.client
          .prepare("SELECT name FROM sqlite_master WHERE type = 'trigger' ORDER BY name")
          .all();
        expect(triggers).toEqual([
          { name: "item_search_ad" },
          { name: "item_search_ai" },
          { name: "item_search_au" },
        ]);
        database.client.exec(
          "INSERT INTO item_search_fts(item_search_fts) VALUES ('integrity-check')",
        );
      } finally {
        database.close();
      }
      // The next start has nothing left to read.
      const reopened = openDatabase(file, all);
      try {
        expect(new SearchBackfill(reopened.db).pending()).toBe(0);
        expect(rows(reopened)).toBe(5);
      } finally {
        reopened.close();
      }
    });

    it("rebuild the first index (ranked, with positions) as the newest-first one", async () => {
      const file = join(tempDir(), "first-search.db");
      const old = openDatabase(
        file,
        partialMigrations((n) => !n.endsWith("_search_newest_first")),
      );
      storeItems(old, stored.slice(0, 2));
      old.client
        .prepare(
          "INSERT INTO item_search (session_id, item_id, thread_id, kind, text, created_at) VALUES ('s1', 'm1', 't1', 'user_message', 'Where is the webhook retry?', 'x')",
        )
        .run();
      old.close();

      const database = openDatabase(file, all);
      try {
        expect(rows(database)).toBe(0);
        await new SearchBackfill(database.db).run();
        expect(search(database, '"ret" "etr" "try"')).toEqual([
          { item_id: "a1" },
          { item_id: "m1" },
        ]);
        const sql = (
          database.client
            .prepare("SELECT sql FROM sqlite_master WHERE name = 'item_search_fts'")
            .get() as { sql: string }
        ).sql;
        expect(sql).toContain("detail='none'");
        // Query trigrams are tokenized with the same tokenizer as the index.
        expect(sql).toContain(`tokenize='${SEARCH_TOKENIZER}'`);
      } finally {
        database.close();
      }
    });
  });

  it("add the runners table to a database from before several runners, keeping its data", () => {
    const file = join(tempDir(), "one-runner.db");
    const old = openDatabase(
      file,
      partialMigrations((n) => !n.endsWith("_runners")),
    );
    old.client
      .prepare(
        "INSERT INTO runner_state (runner_id, last_acked_seq, updated_at) VALUES ('r1', 7, 'x')",
      )
      .run();
    old.close();
    expectFullSchema(file);
    const database = openDatabase(file, all);
    try {
      expect(database.client.prepare("SELECT * FROM runner_state").all()).toEqual([
        { runner_id: "r1", last_acked_seq: 7, updated_at: "x" },
      ]);
      expect(database.client.prepare("SELECT * FROM runners").all()).toEqual([]);
      const index = database.client
        .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'runners'")
        .all();
      expect(index).toEqual(expect.arrayContaining([{ name: "runners_runner_id" }]));
    } finally {
      database.close();
    }
  });

  it("apply the older-timestamped factory loop on a database that already applied automations", () => {
    const file = join(tempDir(), "previous-main.db");
    const old = openDatabase(
      file,
      // The main branch before the factory loop merged: up to automations, without it.
      partialMigrations((n) => !n.endsWith("_factory_loop") && n.slice(0, 14) <= "20261107130421"),
    );
    old.client
      .prepare(
        "INSERT INTO automation_projects (project_id, enabled, updated_at) VALUES ('p1', 1, 'x')",
      )
      .run();
    old.close();
    const database = openDatabase(file, all);
    try {
      const order = (
        database.client.prepare("SELECT name FROM __drizzle_migrations ORDER BY id").all() as {
          name: string;
        }[]
      ).map((m) => m.name);
      // Missing migrations are applied by folder name: factory_loop runs after automations.
      const at = (suffix: string) => order.findIndex((n) => n.endsWith(suffix));
      expect(at("_factory_loop")).toBeGreaterThan(at("_automations"));
      expect(at("_automations")).toBeGreaterThan(-1);
      expect(columns(database.client, "factory_items")).toContain("work_key");
      expect(database.client.prepare("SELECT project_id FROM automation_projects").all()).toEqual([
        { project_id: "p1" },
      ]);
    } finally {
      database.close();
    }
    // Reopening applies nothing new.
    openDatabase(file, all).close();
  });
});

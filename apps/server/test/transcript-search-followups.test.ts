import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type AgentEvent,
  agentEventToNewEvent,
  type Item,
  TranscriptSearchQuery,
  TranscriptSearchResponse,
} from "@codeden/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type Database, openDatabase } from "../src/db/client";
import { EventStore } from "../src/events/store";
import { SearchBackfill } from "../src/services/search/backfill";
import { searchTranscripts } from "../src/services/search/search";
import { sampleSession } from "./helpers";

/**
 * Issue #166: what the review of transcript search (#98) found missing or broken. Each case
 * states the intended behaviour; they failed on the code as merged in #98.
 */

let dir: string;
let database: Database;
let store: EventStore;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "codeden-search-166-"));
  database = openDatabase(join(dir, "codeden.db"));
  store = new EventStore(database.db);
});

afterEach(() => {
  vi.useRealTimers();
  database.close();
  rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

function session(id: string, extra: Partial<typeof sampleSession> & { archivedAt?: string } = {}) {
  store.append([
    {
      type: "session.created",
      sessionId: id,
      payload: { session: { ...sampleSession, id, ...extra } },
    },
  ]);
  agent(id, { type: "thread.started", thread: { id: "t1" } });
  agent(id, { type: "turn.started", threadId: "t1", turnId: "u1" });
}

function agent(sessionId: string, ...events: AgentEvent[]) {
  store.append(events.map((e) => agentEventToNewEvent(sessionId, e)));
}

const say = (id: string, text: string): Item => ({
  id,
  kind: "assistant_message",
  status: "completed",
  text,
});

function completed(sessionId: string, item: Item) {
  agent(sessionId, { type: "item.completed", threadId: "t1", turnId: "u1", item });
}

const search = (q: string, extra: Record<string, unknown> = {}) =>
  TranscriptSearchResponse.parse(
    searchTranscripts(database.db, TranscriptSearchQuery.parse({ q, ...extra })),
  );

const ids = (q: string, extra: Record<string, unknown> = {}) =>
  search(q, extra).hits.map((h) => `${h.sessionId}/${h.itemId}`);

describe("issue #166 (P3): query hygiene and short terms", () => {
  it("strips control characters such as NUL instead of failing the request", () => {
    session("s1");
    completed("s1", say("a1", "The cart hook is fixed"));
    expect(() => search("cart\u0000hook")).not.toThrow();
    expect(ids("cart\u0000 hook")).toEqual(["s1/a1"]);
  });

  it("matches short terms ignoring case and accents, like the index does", () => {
    session("s1");
    completed("s1", say("a1", "Prêt: ÉA build"));
    // The long term matches through the trigram index; the short one must agree with it.
    expect(ids("pret ÉA")).toEqual(["s1/a1"]);
    expect(ids("prêt ea")).toEqual(["s1/a1"]);
  });

  it("finds combining marks NFC can't compose, by the accented and the plain spelling", () => {
    session("s1");
    completed("s1", say("a1", "Note x́yz here"));
    completed("s1", say("a2", "Then ā́bc there"));
    for (const q of ["x́yz", "xyz", "X́YZ"]) expect(ids(q), q).toEqual(["s1/a1"]);
    for (const q of ["ā́bc", "abc", "ábc"]) expect(ids(q), q).toEqual(["s1/a2"]);
    // The highlight covers the marks too.
    for (const q of ["x́yz", "xyz"]) {
      const [hit] = search(q).hits;
      expect(hit?.snippet.filter((p) => p.match).map((p) => p.text)).toEqual(["x́yz"]);
    }
  });
});

describe("issue #166 (P3): items an older build wrote are indexed after upgrading again", () => {
  it("reconciles items missing from the index at startup", async () => {
    session("s1");
    completed("s1", say("a1", "Indexed while search existed"));
    // A start that indexed everything stored so far.
    await new SearchBackfill(database.db).run();
    completed("s1", say("a2", "Indexed live, after the backfill"));
    // Then an older build (no search) wrote this item: it knows nothing about item_search.
    database.client
      .prepare(
        "INSERT INTO items (session_id, id, thread_id, turn_id, position, kind, status, data, created_at, updated_at) VALUES ('s1', 'a3', 't1', 'u1', 9, 'assistant_message', 'completed', ?, ?, ?)",
      )
      .run(
        JSON.stringify(say("a3", "Written by the older build")),
        "2026-11-13T09:00:00.000Z",
        "2026-11-13T09:00:00.000Z",
      );
    database.close();
    database = openDatabase(join(dir, "codeden.db"));
    // The next start (once the server listens) catches up with what it hasn't seen.
    const backfill = new SearchBackfill(database.db);
    expect(backfill.pending()).toBe(2);
    await backfill.run();
    expect(ids("older build")).toEqual(["s1/a3"]);
    expect(ids("indexed")).toHaveLength(2);
    expect(backfill.pending()).toBe(0);
  });
});

describe("search rows keyed by item rowid", () => {
  it("still index an item whose rowid another row holds (rowids renumbered by a VACUUM)", async () => {
    session("s1");
    // Stale rows hold the ids the next two items will get.
    const stale = database.client.prepare(
      "INSERT INTO item_search (id, session_id, item_id, text) VALUES (?, 'old', ?, 'stale')",
    );
    stale.run(1, "gone-1");
    stale.run(2, "gone-2");
    // Live: the projection write must not fail.
    completed("s1", say("a1", "deploy after the vacuum"));
    // The backfill, for an item an older build wrote.
    database.client
      .prepare(
        "INSERT INTO items (session_id, id, thread_id, turn_id, position, kind, status, data, created_at, updated_at) VALUES ('s1', 'a2', 't1', 'u1', 2, 'assistant_message', 'completed', ?, ?, ?)",
      )
      .run(
        JSON.stringify(say("a2", "Older build, after the vacuum too")),
        "2026-11-13T09:00:00.000Z",
        "2026-11-13T09:00:00.000Z",
      );
    await new SearchBackfill(database.db).run();
    expect(ids("after the vacuum").sort()).toEqual(["s1/a1", "s1/a2"]);
    database.client.exec("INSERT INTO item_search_fts(item_search_fts) VALUES ('integrity-check')");
  });
});

describe("issue #166 (P2): filters, newest first and pagination", () => {
  it("excludes archived sessions when asked", () => {
    session("s1", { archivedAt: "2026-11-01T00:00:00.000Z" });
    completed("s1", say("a1", "deploy to production"));
    session("s2");
    completed("s2", say("b1", "deploy to staging"));
    expect(ids("deploy", { includeArchived: false })).toEqual(["s2/b1"]);
    expect(ids("deploy", { includeArchived: true }).sort()).toEqual(["s1/a1", "s2/b1"]);
  });

  it("filters by session role", () => {
    session("s1", { role: "pm" });
    completed("s1", say("a1", "deploy plan"));
    session("s2", { role: "agent" });
    completed("s2", say("b1", "deploy done"));
    expect(ids("deploy", { role: "pm" })).toEqual(["s1/a1"]);
  });

  it("returns the newest matches first, not the best-scored", () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-11-01T10:00:00.000Z"));
    session("s1");
    completed("s1", say("a1", "deploy deploy deploy"));
    vi.setSystemTime(new Date("2026-11-02T10:00:00.000Z"));
    completed("s1", say("a2", "We talked about many things and then, at last, the deploy itself"));
    expect(ids("deploy")).toEqual(["s1/a2", "s1/a1"]);
  });

  it("pages through every match with a cursor", () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    for (let i = 0; i < 5; i++) {
      vi.setSystemTime(new Date(Date.UTC(2026, 10, 1, 10, i)));
      session(`s${i}`);
      completed(`s${i}`, say(`a${i}`, `deploy number ${i}`));
    }
    const seen: string[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < 4; page++) {
      const res = search("deploy", { limit: 2, ...(cursor ? { cursor } : {}) });
      seen.push(...res.hits.map((h) => h.sessionId));
      cursor = res.nextCursor;
      if (!cursor) break;
    }
    expect(seen).toEqual(["s4", "s3", "s2", "s1", "s0"]);
    expect(cursor).toBeNull();
    // Filters apply on every page.
    expect(search("deploy", { limit: 2, role: "pm" })).toMatchObject({
      hits: [],
      nextCursor: null,
    });
  });
});

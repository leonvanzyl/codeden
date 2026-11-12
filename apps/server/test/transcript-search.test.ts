import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type AgentEvent,
  agentEventToNewEvent,
  EventEnvelope,
  type Item,
  TranscriptSearchQuery,
  TranscriptSearchResponse,
} from "@codeden/contracts";
import { asc } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type Database, openDatabase } from "../src/db/client";
import { itemSearch } from "../src/db/schema";
import { applyProjection } from "../src/events/projector";
import { EventStore } from "../src/events/store";
import { parseQuery, searchTranscripts } from "../src/services/search/search";
import { sampleSession } from "./helpers";

let dir: string;
const opened: Database[] = [];
let database: Database;
let store: EventStore;

function open(name: string): Database {
  const db = openDatabase(join(dir, name));
  opened.push(db);
  return db;
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "codeden-search-"));
  database = open("codeden.db");
  store = new EventStore(database.db);
});

afterEach(() => {
  for (const db of opened.splice(0)) db.close();
  rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

/** A session with a root thread `t1` and a running turn `u1`. */
function session(id: string, projectId: string | null = null) {
  store.append([
    {
      type: "session.created",
      sessionId: id,
      payload: { session: { ...sampleSession, id, projectId, scope: { projectId } } },
    },
  ]);
  agent(id, { type: "thread.started", thread: { id: "t1" } });
  agent(id, { type: "turn.started", threadId: "t1", turnId: "u1" });
}

function agent(sessionId: string, ...events: AgentEvent[]) {
  store.append(events.map((e) => agentEventToNewEvent(sessionId, e)));
}

function completed(sessionId: string, item: Item, threadId = "t1", turnId = "u1") {
  agent(sessionId, { type: "item.completed", threadId, turnId, item });
}

const say = (id: string, text: string): Item => ({
  id,
  kind: "assistant_message",
  status: "completed",
  text,
});

const run = (id: string, command: string): Item => ({
  id,
  kind: "tool_call",
  status: "completed",
  toolKind: "command",
  toolName: "Bash",
  title: `Run ${command}`,
  command,
});

const search = (q: string, extra: Record<string, unknown> = {}) =>
  TranscriptSearchResponse.parse(
    searchTranscripts(database.db, TranscriptSearchQuery.parse({ q, ...extra })),
  );

const ids = (q: string, extra: Record<string, unknown> = {}) =>
  search(q, extra).hits.map((h) => `${h.sessionId}/${h.itemId}`);

const indexRows = (db: Database) =>
  db.db
    .select({
      sessionId: itemSearch.sessionId,
      itemId: itemSearch.itemId,
      kind: itemSearch.kind,
      text: itemSearch.text,
    })
    .from(itemSearch)
    .orderBy(asc(itemSearch.sessionId), asc(itemSearch.itemId))
    .all();

describe("transcript search index", () => {
  it("indexes items with their projection, skipping streaming deltas", () => {
    session("s1");
    agent("s1", {
      type: "item.started",
      threadId: "t1",
      turnId: "u1",
      item: { id: "a1", kind: "assistant_message", status: "in_progress", text: "" },
    });
    agent("s1", {
      type: "item.delta",
      threadId: "t1",
      turnId: "u1",
      itemId: "a1",
      delta: { type: "text", text: "I fixed the webhook retry logic" },
    });
    // Only deltas so far: nothing indexed yet.
    expect(indexRows(database)).toEqual([]);

    completed("s1", say("a1", "I fixed the webhook retry logic"));
    expect(indexRows(database)).toEqual([
      {
        sessionId: "s1",
        itemId: "a1",
        kind: "assistant_message",
        text: "I fixed the webhook retry logic",
      },
    ]);
    expect(ids("webhook retry")).toEqual(["s1/a1"]);

    // An update replaces the indexed text: old words stop matching, new ones match.
    completed("s1", say("a1", "Reverted the change to the backoff"));
    expect(ids("webhook")).toEqual([]);
    expect(ids("backoff")).toEqual(["s1/a1"]);
    expect(indexRows(database)).toHaveLength(1);
  });

  it("indexes a reply cut off mid-stream when its turn ends", () => {
    session("s1");
    agent(
      "s1",
      {
        type: "item.started",
        threadId: "t1",
        turnId: "u1",
        item: { id: "a1", kind: "assistant_message", status: "in_progress", text: "" },
      },
      {
        type: "item.delta",
        threadId: "t1",
        turnId: "u1",
        itemId: "a1",
        delta: { type: "text", text: "Looking at the cart reducer" },
      },
    );
    expect(ids("reducer")).toEqual([]);
    agent("s1", { type: "turn.interrupted", threadId: "t1", turnId: "u1", reason: "user" });
    expect(ids("reducer")).toEqual(["s1/a1"]);
  });

  it("rebuilds the same index by replaying the event log", () => {
    session("s1");
    completed("s1", {
      id: "m1",
      kind: "user_message",
      status: "completed",
      input: { text: "Where do we run prisma migrate?", attachments: [] },
    });
    completed("s1", run("c1", "npx prisma migrate dev"));
    completed("s1", say("a1", "First draft"));
    completed("s1", say("a1", "Final answer about migrations"));

    const rebuilt = open("rebuilt.db");
    const log = store.listAfter(0, 10_000);
    rebuilt.db.transaction((tx) => {
      for (const raw of log) applyProjection(tx, EventEnvelope.parse(raw));
    });
    expect(indexRows(rebuilt)).toEqual(indexRows(database));
    expect(indexRows(rebuilt)).toHaveLength(3);
    database = rebuilt;
    expect(ids("prisma migrate")).toEqual(expect.arrayContaining(["s1/m1", "s1/c1"]));
  });
});

describe("transcript search queries", () => {
  it("matches case- and accent-insensitively, and inside identifiers and paths", () => {
    session("s1");
    completed("s1", say("a1", "Moved the logic into useCartHook in src/hooks/cart.ts"));
    completed("s1", say("a2", "Le café est prêt"));
    expect(ids("cart hook")).toEqual(["s1/a1"]);
    expect(ids("CARTHOOK")).toEqual(["s1/a1"]);
    expect(ids("hooks/cart.ts")).toEqual(["s1/a1"]);
    expect(ids("cafe pret")).toEqual(["s1/a2"]);

    const [hit] = search("carthook").hits;
    expect(hit?.snippet.filter((p) => p.match).map((p) => p.text)).toEqual(["CartHook"]);
    expect(hit?.snippet.map((p) => p.text).join("")).toBe(
      "Moved the logic into useCartHook in src/hooks/cart.ts",
    );
  });

  it("treats FTS5 syntax as literal text and never fails", () => {
    session("s1");
    completed("s1", say("a1", 'Ran "pnpm test" (all green): NEAR done -- OR not, a*b ^x'));
    for (const q of [
      '"pnpm',
      '"pnpm test"',
      "(all",
      "green):",
      "NEAR",
      "OR",
      "AND",
      "a*b",
      "^x",
      "--",
      '"""',
      "NEAR(a b)",
      "col:umn",
    ]) {
      expect(() => search(q), q).not.toThrow();
    }
    expect(ids('"pnpm')).toEqual(["s1/a1"]);
    expect(ids("(all green):")).toEqual(["s1/a1"]);
    expect(ids("NEAR")).toEqual(["s1/a1"]);
    expect(ids("a*b")).toEqual(["s1/a1"]);
    expect(ids("AND")).toEqual([]);
  });

  it("returns nothing for queries without a 3-character term, and filters by short terms", () => {
    session("s1");
    completed("s1", say("a1", "Open a PR for the cart fix"));
    completed("s1", say("a2", "The cart total is wrong"));
    expect(search("pr")).toEqual({ query: "pr", hits: [], truncated: false });
    expect(search("a b")).toMatchObject({ hits: [] });
    expect(ids("cart pr")).toEqual(["s1/a1"]);
    expect(parseQuery('say "hi" to NEAR to')).toEqual({
      match: '"say" """hi""" "NEAR"',
      short: ["to"],
    });
  });

  it("caps hits per session, limits the response and filters by project", () => {
    session("s1", "p1");
    for (let i = 0; i < 6; i++) completed("s1", say(`a${i}`, `deploy step ${i}`));
    session("s2", "p2");
    completed("s2", say("b1", "deploy to staging"));

    const all = search("deploy");
    expect(all.hits.filter((h) => h.sessionId === "s1")).toHaveLength(3);
    expect(all.hits.filter((h) => h.sessionId === "s2")).toHaveLength(1);
    expect(all.truncated).toBe(false);

    const limited = search("deploy", { limit: 2 });
    expect(limited.hits).toHaveLength(2);
    expect(limited.truncated).toBe(true);

    expect(ids("deploy", { projectId: "p2" })).toEqual(["s2/b1"]);
    expect(search("deploy", { projectId: "p1" }).hits.every((h) => h.sessionId === "s1")).toBe(
      true,
    );
  });

  it("anchors a hit in a subagent's thread at the subagent card in the root thread", () => {
    session("s1");
    completed("s1", {
      id: "sub1",
      kind: "subagent",
      status: "in_progress",
      childThreadId: "t2",
      description: "Review the checkout",
    });
    agent(
      "s1",
      { type: "thread.started", thread: { id: "t2", parentThreadId: "t1", parentItemId: "sub1" } },
      { type: "turn.started", threadId: "t2", turnId: "u2" },
    );
    completed("s1", run("c9", "rg checkoutTotals"), "t2", "u2");
    // A subagent of the subagent.
    completed(
      "s1",
      { id: "sub2", kind: "subagent", status: "in_progress", childThreadId: "t3" },
      "t2",
      "u2",
    );
    agent(
      "s1",
      { type: "thread.started", thread: { id: "t3", parentThreadId: "t2", parentItemId: "sub2" } },
      { type: "turn.started", threadId: "t3", turnId: "u3" },
    );
    completed("s1", say("deep", "checkoutTotals rounding"), "t3", "u3");

    const hits = search("checkoutTotals").hits;
    expect(hits.map((h) => [h.itemId, h.threadId, h.anchorItemId]).sort()).toEqual([
      ["c9", "t2", "sub1"],
      ["deep", "t3", "sub1"],
    ]);
    const root = search("checkout").hits.find((h) => h.itemId === "sub1");
    expect(root).toMatchObject({ threadId: "t1", anchorItemId: "sub1", kind: "subagent" });
    expect(search("checkoutTotals").hits.find((h) => h.itemId === "c9")).toMatchObject({
      kind: "tool_call",
      toolKind: "command",
    });
  });
});

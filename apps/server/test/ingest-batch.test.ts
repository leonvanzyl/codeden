import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentEvent, RunnerEvent, RunnerEventMessage } from "@codeden/contracts";
import { asc } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type Database, openDatabase } from "../src/db/client";
import { items } from "../src/db/schema";
import { ingestRunnerEvent, lastAckedSeq } from "../src/events/ingest";
import {
  ingestRunnerEvents,
  MERGED_DELTA_MAX_CHARS,
  mergeStreamedDeltas,
} from "../src/events/ingest-batch";
import { EventStore } from "../src/events/store";
import { RunnerEventIntake } from "../src/runner/event-intake";
import { sampleSession } from "./helpers";
import { removeTree } from "./support/remove-tree";

let dir: string;
const open: Database[] = [];

function freshStore(): { database: Database; store: EventStore } {
  const database = openDatabase(join(dir, `codeden-${open.length}.db`));
  open.push(database);
  const store = new EventStore(database.db);
  store.append([
    { type: "session.created", sessionId: "s1", payload: { session: sampleSession } },
    {
      type: "session.created",
      sessionId: "s2",
      payload: { session: { ...sampleSession, id: "s2" } },
    },
  ]);
  return { database, store };
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "codeden-ingest-batch-"));
});

afterEach(async () => {
  for (const database of open.splice(0)) database.close();
  await removeTree(dir);
});

let seq = 0;
const msg = (event: RunnerEvent): RunnerEventMessage => ({
  type: "event",
  seq: ++seq,
  ts: "2026-11-07T10:00:00.000Z",
  event,
});
const agent = (sessionId: string, event: AgentEvent) => msg({ kind: "agent", sessionId, event });
const text = (sessionId: string, itemId: string, t: string) =>
  agent(sessionId, {
    type: "item.delta",
    threadId: "t",
    turnId: "u",
    itemId,
    delta: { type: "text", text: t },
  });
const started = (sessionId: string, itemId: string) =>
  agent(sessionId, {
    type: "item.started",
    threadId: "t",
    turnId: "u",
    item: { id: itemId, kind: "assistant_message", status: "in_progress", text: "" },
  });

/** Two sessions streaming interleaved, with another event in the middle of one stream. */
function script(): RunnerEventMessage[] {
  seq = 0;
  return [
    agent("s1", { type: "thread.started", thread: { id: "t" } }),
    agent("s2", { type: "thread.started", thread: { id: "t" } }),
    started("s1", "a"),
    started("s2", "b"),
    text("s1", "a", "one "),
    text("s2", "b", "uno "),
    text("s1", "a", "two "),
    text("s2", "b", "dos "),
    started("s1", "c"),
    text("s1", "a", "three"),
    text("s1", "c", "other"),
    msg({ kind: "runner.draining", reason: "upgrade" }),
    text("s2", "b", "tres"),
  ];
}

const transcript = (database: Database) =>
  database.db
    .select()
    .from(items)
    .orderBy(asc(items.sessionId), asc(items.position))
    .all()
    .map((row) => ({
      session: row.sessionId,
      id: row.id,
      text: (row.data as { text?: string }).text,
    }));

describe("mergeStreamedDeltas", () => {
  it("joins each session's run of deltas for one item and keeps every other event", () => {
    const merged = mergeStreamedDeltas(script());
    const shape = merged.map((m) =>
      m.event.kind === "agent" && m.event.event.type === "item.delta"
        ? `${m.event.sessionId}:${m.event.event.itemId}:${(m.event.event.delta as { text: string }).text}`
        : m.event.kind === "agent"
          ? `${m.event.sessionId}:${m.event.event.type}`
          : m.event.kind,
    );
    expect(shape).toEqual([
      "s1:thread.started",
      "s2:thread.started",
      "s1:item.started",
      "s2:item.started",
      // s1's run ends at its next item.started; s2's at the event of no session.
      "s1:a:one two ",
      "s2:b:uno dos ",
      "s1:item.started",
      "s1:a:three",
      "s1:c:other",
      "runner.draining",
      "s2:b:tres",
    ]);
  });
  it("splits a long run of one item's deltas into merged events within the cap, in order", () => {
    seq = 0;
    // 256 deltas of 1-5 KiB of one item: about 770 KiB of text.
    const pieces = Array.from({ length: 256 }, (_, i) =>
      String.fromCharCode(97 + (i % 26)).repeat(1024 * (1 + (i % 5))),
    );
    const merged = mergeStreamedDeltas(pieces.map((p) => text("s1", "a", p)));
    const texts = merged.map((m) =>
      m.event.kind === "agent" && m.event.event.type === "item.delta"
        ? (m.event.event.delta as { text: string }).text
        : "",
    );
    const total = pieces.join("").length;
    expect(texts.length).toBeGreaterThanOrEqual(Math.ceil(total / MERGED_DELTA_MAX_CHARS));
    expect(texts.length).toBeLessThan(pieces.length);
    for (const t of texts) expect(t.length).toBeLessThanOrEqual(MERGED_DELTA_MAX_CHARS);
    expect(texts.join("")).toBe(pieces.join(""));
    // Each merged event carries the seq of the last delta it holds, so seqs keep rising.
    const seqs = merged.map((m) => m.seq);
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
    expect(seqs.at(-1)).toBe(256);
  });
});

describe("ingestRunnerEvents", () => {
  it("projects the same transcript as storing each event on its own, in one commit", () => {
    const one = freshStore();
    for (const m of script()) ingestRunnerEvent(one.database.db, one.store, "r1", m);
    const batch = freshStore();
    const result = ingestRunnerEvents(batch.database.db, batch.store, "r1", script());

    expect(transcript(batch.database)).toEqual(transcript(one.database));
    expect(transcript(batch.database).map((r) => r.text)).toEqual([
      "one two three",
      "other",
      "uno dos tres",
    ]);
    expect(result.ackSeq).toBe(13);
    expect(lastAckedSeq(batch.database.db, "r1")).toBe(13);
    // Fewer stored events: the deltas were merged.
    expect(batch.store.headSeq()).toBeLessThan(one.store.headSeq());
  });

  it("skips events at or below the stored ack position (a replay after a reconnect)", () => {
    const { database, store } = freshStore();
    const events = script();
    ingestRunnerEvents(database.db, store, "r1", events.slice(0, 6));
    const head = store.headSeq();
    const replay = ingestRunnerEvents(database.db, store, "r1", events.slice(0, 6));
    expect(replay).toMatchObject({ events: [], stored: [], ackSeq: 6 });
    expect(store.headSeq()).toBe(head);
    ingestRunnerEvents(database.db, store, "r1", events.slice(3));
    expect(transcript(database).map((r) => r.text)).toEqual([
      "one two three",
      "other",
      "uno dos tres",
    ]);
  });

  it("drops an untrusted runner's events for sessions not routed to it, acking them", () => {
    const { database, store } = freshStore();
    seq = 0;
    const result = ingestRunnerEvents(
      database.db,
      store,
      "r-sbx",
      [agent("s1", { type: "thread.started", thread: { id: "t" } })],
      { recordId: "rn-1", untrusted: true },
    );
    expect(result.refused.map((r) => r.reason)).toEqual([
      "session s1 is not routed to this runner",
    ]);
    expect(result.stored).toEqual([]);
    expect(lastAckedSeq(database.db, "r-sbx")).toBe(1);
  });

  it("refuses a second exit of an untrusted runner's pty in the same batch", () => {
    const { database, store } = freshStore();
    seq = 0;
    const exit = () => msg({ kind: "pty.exited", ptyId: "p1", exitCode: 0 });
    const result = ingestRunnerEvents(database.db, store, "r-sbx", [exit(), exit()], {
      recordId: "rn-1",
      untrusted: true,
      ownsPty: (ptyId) => ptyId === "p1",
    });
    expect(result.stored.map((m) => m.seq)).toEqual([1]);
    expect(result.refused.map((r) => r.reason)).toEqual(["pty p1 is not open on this runner"]);
    expect(lastAckedSeq(database.db, "r-sbx")).toBe(2);
  });
});

describe("RunnerEventIntake", () => {
  it("stores what arrived together as one batch, and flush stores the queue at once", async () => {
    const batches: number[][] = [];
    const intake = new RunnerEventIntake((b) => batches.push(b.map((m) => m.seq)), 2);
    const events = script();
    for (const m of events.slice(0, 3)) intake.push(m);
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    expect(batches).toEqual([[1, 2], [3]]);
    for (const m of events.slice(3, 6)) intake.push(m);
    intake.flush();
    expect(batches).toEqual([[1, 2], [3], [4, 5], [6]]);
    await new Promise((r) => setImmediate(r));
    expect(batches).toHaveLength(4);
  });
});

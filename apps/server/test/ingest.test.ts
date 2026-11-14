import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentEvent, RunnerEvent, RunnerEventMessage } from "@codeden/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type Database, openDatabase } from "../src/db/client";
import { ingestRunnerEvent, lastAckedSeq } from "../src/events/ingest";
import { EventStore } from "../src/events/store";
import { sampleSession } from "./helpers";

let dir: string;
let database: Database;
let store: EventStore;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "codeden-ingest-"));
  database = openDatabase(join(dir, "codeden.db"));
  store = new EventStore(database.db);
  store.append([{ type: "session.created", sessionId: "s1", payload: { session: sampleSession } }]);
});

afterEach(() => {
  database.close();
  rmSync(dir, { recursive: true, force: true });
});

let seq = 0;
const msg = (event: RunnerEvent): RunnerEventMessage => ({
  type: "event",
  seq: ++seq,
  ts: "2026-11-07T10:00:00.000Z",
  event,
});
const agent = (event: AgentEvent): RunnerEventMessage =>
  msg({ kind: "agent", sessionId: "s1", event });

describe("ingestRunnerEvent", () => {
  beforeEach(() => {
    seq = 0;
  });

  it("stores agent events with projections and derived domain events atomically", () => {
    const thread = ingestRunnerEvent(
      database.db,
      store,
      "r1",
      agent({ type: "thread.started", thread: { id: "t" } }),
    );
    expect(thread.events.map((e) => e.type)).toEqual(["agent.thread.started", "session.updated"]);
    const approval = ingestRunnerEvent(
      database.db,
      store,
      "r1",
      agent({
        type: "item.started",
        threadId: "t",
        turnId: "u",
        item: {
          id: "a",
          kind: "approval_request",
          status: "in_progress",
          requestId: "r",
          action: "command",
          title: "Approve?",
          options: ["allow_once", "deny"],
        },
      }),
    );
    expect(approval.events.map((e) => e.type)).toEqual([
      "agent.item.started",
      "inbox.created",
      "session.updated",
    ]);
    expect(lastAckedSeq(database.db, "r1")).toBe(2);
  });

  it("is idempotent by runner seq", () => {
    const first = agent({ type: "thread.started", thread: { id: "t" } });
    expect(ingestRunnerEvent(database.db, store, "r1", first).stored).toBe(true);
    const head = store.headSeq();
    const again = ingestRunnerEvent(database.db, store, "r1", first);
    expect(again).toMatchObject({ stored: false, ackSeq: 1 });
    expect(store.headSeq()).toBe(head);
    // Another runner id has its own sequence.
    expect(ingestRunnerEvent(database.db, store, "r2", first).stored).toBe(true);
  });

  it("stores an untrusted runner's events only for sessions routed to it, acking the rest", () => {
    store.append([
      {
        type: "session.created",
        sessionId: "s2",
        payload: { session: { ...sampleSession, id: "s2", runnerId: "r-sbx" } },
      },
    ]);
    const sandbox = { recordId: "rn-1", untrusted: true };
    const head = store.headSeq();
    const thread = (sessionId: string) =>
      msg({ kind: "agent", sessionId, event: { type: "thread.started", thread: { id: "t" } } });

    // s1 has no runner (the home runner's), and s3 doesn't exist.
    expect(ingestRunnerEvent(database.db, store, "r-sbx", thread("s1"), sandbox)).toEqual({
      stored: false,
      events: [],
      ackSeq: 1,
      refused: "session s1 is not routed to this runner",
    });
    expect(ingestRunnerEvent(database.db, store, "r-sbx", thread("s3"), sandbox).refused).toBe(
      "session s3 does not exist",
    );
    expect(store.headSeq()).toBe(head);
    expect(lastAckedSeq(database.db, "r-sbx")).toBe(2);

    expect(ingestRunnerEvent(database.db, store, "r-sbx", thread("s2"), sandbox).stored).toBe(true);
    // Runner-level events name no session.
    const draining = msg({ kind: "runner.draining", reason: "upgrade" });
    expect(ingestRunnerEvent(database.db, store, "r-sbx", draining, sandbox).stored).toBe(true);
    // The home runner (trusted) writes for any session, as before.
    expect(ingestRunnerEvent(database.db, store, "r-home", thread("s1")).stored).toBe(true);
  });

  it("maps provider crashes to a failed session and an inbox item", () => {
    const result = ingestRunnerEvent(
      database.db,
      store,
      "r1",
      msg({ kind: "session.process", sessionId: "s1", state: "crashed", error: { message: "x" } }),
    );
    expect(result.events.map((e) => e.type)).toEqual(["session.updated", "inbox.created"]);
    // Events that produce nothing still advance the ack position.
    ingestRunnerEvent(
      database.db,
      store,
      "r1",
      msg({ kind: "runner.draining", reason: "upgrade" }),
    );
    expect(lastAckedSeq(database.db, "r1")).toBe(2);
  });
});

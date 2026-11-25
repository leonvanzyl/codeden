import { once } from "node:events";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import {
  CODEDEN_VERSION,
  encodeLinkFrame,
  LinkFrameDecoder,
  RUNNER_PROTOCOL_VERSION,
  type RunnerEvent,
  type RunnerStream,
  type RunnerWelcome,
} from "@codeden/contracts";
import { asc } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type Database, openDatabase } from "../src/db/client";
import { items } from "../src/db/schema";
import { lastAckedSeq } from "../src/events/ingest";
import { EventStore } from "../src/events/store";
import { RunnerClient } from "../src/runner/client";
import { INTAKE_MAX_BATCH } from "../src/runner/event-intake";
import type { LinkProcess } from "../src/runner/transport-exec";
import { sampleSession } from "./helpers";
import { waitUntil } from "./support/harness";
import { removeTree } from "./support/remove-tree";

/**
 * `RunnerClient`'s event intake against a scripted exec link: the test writes runner frames
 * to the link's stdout in one chunk, so they reach the client in one read, as a burst does.
 */

const TS = "2026-11-07T10:00:00.000Z";
const RUNNER_ID = "r-intake";

interface ScriptedLink {
  /** Write these runner messages in one chunk; resolves once the client has read it. */
  write: (messages: unknown[]) => Promise<void>;
  /** Write the messages, then end the link (as a runner going away right after them). */
  drop: (messages: unknown[]) => Promise<void>;
  /** Seqs the client acked, and the stored ack position when each ack arrived. */
  acks: { seq: number; stored: number }[];
}

let dir: string;
let database: Database;
let store: EventStore;
let client: RunnerClient | undefined;
let links: ScriptedLink[];
let streams: { stream: RunnerStream; storedTexts: (string | undefined)[] }[];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "codeden-runner-intake-"));
  database = openDatabase(join(dir, "codeden.db"));
  store = new EventStore(database.db);
  store.append([{ type: "session.created", sessionId: "s1", payload: { session: sampleSession } }]);
  links = [];
  streams = [];
});

afterEach(async () => {
  await client?.stop();
  client = undefined;
  database.close();
  await removeTree(dir);
});

function welcome(): RunnerWelcome {
  return {
    type: "welcome",
    protocolVersion: RUNNER_PROTOCOL_VERSION,
    runnerId: RUNNER_ID,
    runnerVersion: CODEDEN_VERSION,
    pid: process.pid,
    startedAt: TS,
    capabilities: { pty: true, browser: true, git: true, mcpProxy: false },
    providers: [],
    sessions: [],
    journal: { lastSeq: 0, unacked: 0 },
    draining: false,
  };
}

/** A link that welcomes the client and records its acks; nothing else is answered. */
function scriptedLink(): LinkProcess {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const decoder = new LinkFrameDecoder();
  const exitListeners: Array<(code: number | null) => void> = [];
  let exited = false;
  const exit = () => {
    if (exited) return;
    exited = true;
    for (const listener of exitListeners.splice(0)) listener(0);
  };
  const write = async (messages: unknown[]) => {
    const read = once(stdout, "data");
    stdout.write(messages.map((m) => encodeLinkFrame(m)).join(""));
    await read; // the client's own `data` listener came first
  };
  const link: ScriptedLink = {
    write,
    drop: async (messages) => {
      await write(messages);
      exit();
    },
    acks: [],
  };
  links.push(link);
  stdin.on("data", (chunk: Buffer) => {
    for (const msg of decoder.push(chunk) as { type: string; seq?: number }[]) {
      if (msg.type === "hello") stdout.write(encodeLinkFrame(welcome()) ?? "");
      if (msg.type === "ack" && msg.seq !== undefined) {
        link.acks.push({ seq: msg.seq, stored: lastAckedSeq(database.db, RUNNER_ID) });
      }
    }
  });
  stdin.on("finish", exit);
  return {
    stdin,
    stdout,
    stderr: null,
    kill: exit,
    onExit: (listener) => {
      if (exited) listener(0);
      else exitListeners.push(listener);
    },
  };
}

async function connect(): Promise<ScriptedLink> {
  client = new RunnerClient({
    home: dir,
    lockFile: join(dir, "runner.json"),
    launch: null,
    db: database.db,
    store,
    link: { kind: "exec", start: scriptedLink },
    onStream: (stream) => streams.push({ stream, storedTexts: transcript() }),
  });
  await client.start();
  const link = links.at(-1);
  if (!link) throw new Error("no link");
  return link;
}

const event = (seq: number, e: RunnerEvent) => ({ type: "event", seq, ts: TS, event: e });
const started = (seq: number, itemId: string) =>
  event(seq, {
    kind: "agent",
    sessionId: "s1",
    event: {
      type: "item.started",
      threadId: "t",
      turnId: "u",
      item: { id: itemId, kind: "assistant_message", status: "in_progress", text: "" },
    },
  });
const delta = (seq: number, itemId: string, text: string) =>
  event(seq, {
    kind: "agent",
    sessionId: "s1",
    event: {
      type: "item.delta",
      threadId: "t",
      turnId: "u",
      itemId,
      delta: { type: "text", text },
    },
  });
const ptyOutput = (data: string) => ({
  type: "stream",
  ts: TS,
  stream: { kind: "pty.output", ptyId: "p1", data },
});

function transcript(): (string | undefined)[] {
  return database.db
    .select()
    .from(items)
    .orderBy(asc(items.position))
    .all()
    .map((row) => (row.data as { text?: string }).text);
}

/** Server events stored for the runner's agent events, by type. */
const storedTypes = () =>
  store
    .listAfter(0, 10_000)
    .map((e) => e.type)
    .filter((t) => t.startsWith("agent.item."));

describe("RunnerClient event intake", () => {
  it("stores queued events before a runner message that came after them is handled", async () => {
    const link = await connect();
    await link.write([started(1, "a"), delta(2, "a", "hello"), ptyOutput("$ ")]);
    // The stream was handled in the same read, before the next turn of the event loop.
    expect(streams.map((s) => s.storedTexts)).toEqual([["hello"]]);
  });

  it("acks once per batch, after its commit, with the batch's highest seq", async () => {
    const link = await connect();
    await link.write([started(1, "a"), delta(2, "a", "one "), delta(3, "a", "two")]);
    await waitUntil(() => link.acks.length > 0, 15_000);
    expect(link.acks).toEqual([{ seq: 3, stored: 3 }]);
    expect(transcript()).toEqual(["one two"]);
  });

  it("stores a failed batch's events one at a time, each once", async () => {
    const link = await connect();
    await link.write([started(1, "a"), delta(2, "a", "one ")]);
    await waitUntil(() => link.acks.length === 1, 15_000);

    // The batch's transaction fails: nothing of it is committed, so each event is stored alone.
    // Seq 2 is a replay of an event already stored, and is skipped.
    const appendSteps = store.appendSteps.bind(store);
    const spy = vi.spyOn(store, "appendSteps").mockImplementationOnce(() => {
      throw new Error("disk I/O error");
    });
    await link.write([delta(2, "a", "one "), delta(3, "a", "two "), delta(4, "a", "three ")]);
    await waitUntil(() => link.acks.length === 4, 15_000);
    expect(link.acks.slice(1).map((a) => a.seq)).toEqual([2, 3, 4]);
    expect(transcript()).toEqual(["one two three "]);
    spy.mockImplementation(appendSteps);

    // The batch commits, then a subscriber throws: the per-event path finds every event stored.
    let thrown = false;
    const unsubscribe = store.subscribe(() => {
      if (thrown) return;
      thrown = true;
      throw new Error("listener failed");
    });
    const before = storedTypes().length;
    await link.write([delta(5, "a", "four "), delta(6, "a", "five")]);
    await waitUntil(() => link.acks.length === 6, 15_000);
    unsubscribe();
    expect(thrown).toBe(true);
    expect(transcript()).toEqual(["one two three four five"]);
    // One merged delta for the batch, never stored again by the fallback.
    expect(storedTypes().length).toBe(before + 1);
  });

  it("stores the queue when the link closes, before recording the disconnect", async () => {
    const link = await connect();
    await link.drop([started(1, "a"), delta(2, "a", "last words")]);
    const types = store.listAfter(0, 10_000).map((e) => e.type);
    expect(transcript()).toEqual(["last words"]);
    const disconnected = types.indexOf("runner.disconnected");
    expect(disconnected).toBeGreaterThan(-1);
    expect(types.lastIndexOf("agent.item.delta")).toBeGreaterThan(-1);
    expect(types.lastIndexOf("agent.item.delta")).toBeLessThan(disconnected);
  });

  it("stores the queue on stop", async () => {
    const link = await connect();
    await link.write([started(1, "a"), delta(2, "a", "bye")]);
    expect(transcript()).toEqual([]); // still queued
    const stopping = client?.stop();
    expect(transcript()).toEqual(["bye"]);
    await stopping;
    expect(lastAckedSeq(database.db, RUNNER_ID)).toBe(2);
  });

  it("splits a burst of more than one batch's events and stores every one in order", async () => {
    const link = await connect();
    const count = INTAKE_MAX_BATCH * 2 + 50;
    const pieces = Array.from({ length: count }, (_, i) => `${i} `);
    await link.write([started(1, "a"), ...pieces.map((p, i) => delta(i + 2, "a", p))]);
    const last = count + 1;
    await waitUntil(() => link.acks.at(-1)?.seq === last, 15_000);
    expect(link.acks.map((a) => a.seq)).toEqual([INTAKE_MAX_BATCH, INTAKE_MAX_BATCH * 2, last]);
    expect(transcript()).toEqual([pieces.join("")]);
  });
});

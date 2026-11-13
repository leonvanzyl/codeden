import { readFileSync } from "node:fs";
import { join } from "node:path";
import type {
  AgentEvent,
  ItemStatus,
  RunnerCommandOf,
  RunnerEventMessage,
} from "@codeden/contracts";
import {
  FakeProvider,
  type ProviderAdapter,
  ProviderRegistry,
  type ProviderSession,
} from "@codeden/providers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Journal, type RunningRunner, startRunner } from "../src";
import { DeltaBatcher } from "../src/delta-batcher";
import { SessionHost } from "../src/session-host";
import { makeRepo, removeDir, TestServer, tempDir } from "./helpers";

const THREAD = "t-root";
const TURN = "turn-1";
const at = { threadId: THREAD, turnId: TURN };
const message = (id: string, text: string, status: ItemStatus) => ({
  id,
  kind: "assistant_message" as const,
  text,
  status,
});
const delta = (itemId: string, text: string): AgentEvent => ({
  type: "item.delta",
  ...at,
  itemId,
  delta: { type: "text", text },
});
const opening: AgentEvent[] = [
  { type: "thread.started", thread: { id: THREAD } },
  { type: "turn.started", ...at },
  { type: "item.started", ...at, item: message("m1", "", "in_progress") },
  delta("m1", "Hel"),
  delta("m1", "lo"),
];

/**
 * A provider whose session streams `events` and then stalls mid-stream: the stream stays open
 * with nothing more coming until the session closes. `streamed` resolves once the runner has
 * taken every event (the generator only resumes once the previous event was handled).
 */
function stallingProvider(events: AgentEvent[]): {
  adapter: ProviderAdapter;
  streamed: Promise<void>;
} {
  let markStreamed: () => void = () => {};
  const streamed = new Promise<void>((resolve) => {
    markStreamed = resolve;
  });
  let release: () => void = () => {};
  const closed = new Promise<void>((resolve) => {
    release = resolve;
  });
  async function* stream(): AsyncGenerator<AgentEvent> {
    for (const event of events) yield event;
    markStreamed();
    await closed;
  }
  const session: ProviderSession = {
    events: stream(),
    send: async () => {},
    interrupt: async () => {},
    respond: async () => {},
    close: async () => release(),
    resumeToken: () => "stalling-1",
  };
  const adapter: ProviderAdapter = {
    id: "stalling",
    displayName: "Stalling",
    detect: () => new FakeProvider().detect(),
    capabilities: () => new FakeProvider().capabilities(),
    models: () => [],
    openSession: async () => session,
  };
  return { adapter, streamed };
}

const start = (cwd: string, providerId = "stalling"): RunnerCommandOf<"session.start"> => ({
  name: "session.start",
  sessionId: "s1",
  providerId,
  checkpoints: false,
  options: {
    sessionId: "s1",
    role: "agent",
    cwd,
    autonomy: "auto",
    mcpServers: [],
    additionalDirectories: [],
    planMode: false,
  },
});

/** `agent:<event type>` or the runner event kind. */
const label = (m: RunnerEventMessage) =>
  m.event.kind === "agent" ? `agent:${m.event.event.type}` : m.event.kind;

let home: string;
let runner: RunningRunner | undefined;
let server: TestServer | undefined;
const cleanup: string[] = [];

beforeEach(() => {
  home = tempDir("codeden-streaming-");
});
afterEach(async () => {
  await server?.close();
  await runner?.close();
  server = undefined;
  runner = undefined;
  removeDir(home);
  for (const dir of cleanup.splice(0)) removeDir(dir);
});

/** A runner whose batching window outlasts the test: only other events pass batches on. */
async function attach(adapter: ProviderAdapter): Promise<TestServer> {
  runner = await startRunner({ home, adapters: [adapter], deltaBatching: { windowMs: 60_000 } });
  server = await TestServer.attach(runner);
  return server;
}

describe("streamed deltas through the runner", () => {
  it("are journaled before a manual checkpoint that arrives while they wait", async () => {
    const repo = makeRepo();
    cleanup.push(repo);
    const { adapter, streamed } = stallingProvider(opening);
    const server = await attach(adapter);
    await server.request(start(repo));
    await streamed; // "Hel" and "lo" wait in the batching window

    await server.request({ name: "git.checkpoint", sessionId: "s1", cwd: repo, index: 1 });
    const events = server.events();
    expect(events.map(label)).toEqual([
      "session.process",
      "session.process",
      "agent:thread.started",
      "agent:turn.started",
      "agent:item.started",
      "agent:item.delta",
      "checkpoint.created",
    ]);
    expect(events[5]?.event).toEqual({
      kind: "agent",
      sessionId: "s1",
      event: delta("m1", "Hello"),
    });
  });
});

/**
 * A provider whose session streams whatever the test feeds it. `feed` resolves once the
 * session host has taken every event (the generator only moves on once the previous event was
 * handled), so the test knows exactly what has reached the batcher.
 */
function fedProvider(): {
  adapter: ProviderAdapter;
  feed: (...events: AgentEvent[]) => Promise<void>;
} {
  const queue: AgentEvent[] = [];
  let wake: () => void = () => {};
  let taken: () => void = () => {};
  async function* stream(): AsyncGenerator<AgentEvent> {
    for (;;) {
      for (let next = queue.shift(); next; next = queue.shift()) yield next;
      taken();
      await new Promise<void>((resolve) => {
        wake = resolve;
      });
    }
  }
  const session: ProviderSession = {
    events: stream(),
    send: async () => {},
    interrupt: async () => {},
    respond: async () => {},
    close: async () => {},
    resumeToken: () => "fed-1",
  };
  const adapter: ProviderAdapter = {
    id: "fed",
    displayName: "Fed",
    detect: () => new FakeProvider().detect(),
    capabilities: () => new FakeProvider().capabilities(),
    models: () => [],
    openSession: async () => session,
  };
  const feed = (...events: AgentEvent[]) => {
    const done = new Promise<void>((resolve) => {
      taken = resolve;
    });
    queue.push(...events);
    wake();
    return done;
  };
  return { adapter, feed };
}

describe("a runner killed mid-stream", () => {
  // Batching windows and the journal's persist interval run on controlled time.
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("replays every journaled event the server had not stored, merged deltas included", async () => {
    // Wired like the runner: session host -> delta batcher -> journal append, then delivery.
    const dir = join(home, "runner");
    const journal = new Journal(dir);
    const delivered: RunnerEventMessage[] = [];
    const batcher = new DeltaBatcher((event) => delivered.push(journal.append(event)));
    const { adapter, feed } = fedProvider();
    const host = new SessionHost(new ProviderRegistry([adapter]), (event) => batcher.push(event));
    await host.start(start(home, "fed"));

    await feed(...opening); // "Hel" + "lo" wait in the batching window...
    vi.advanceTimersByTime(50); // ...until it closes: one merged delta
    const threadStarted = delivered[2]?.seq ?? 0;
    journal.ack(threadStarted); // the server stored the thread start
    await feed(delta("m1", " wor"), delta("m1", "ld"));
    // Another event of the session journals the waiting " wor" + "ld" first.
    await feed({ type: "item.completed", ...at, item: message("m1", "Hello world", "completed") });
    vi.advanceTimersByTime(250); // the journal persists that ack
    const turnStarted = delivered[3]?.seq ?? 0;
    journal.ack(turnStarted); // acked in memory; its persist is still 250 ms away
    await feed(
      { type: "item.started", ...at, item: message("m2", "", "in_progress") },
      delta("m2", "Still"),
      delta("m2", " typing"), // left waiting in the batching window
    );
    vi.advanceTimersByTime(30);
    expect(delivered.map(label)).toEqual([
      "session.process",
      "session.process",
      "agent:thread.started",
      "agent:turn.started",
      "agent:item.started",
      "agent:item.delta",
      "agent:item.delta",
      "agent:item.completed",
      "agent:item.started",
    ]);
    expect(stateOf(dir)).toMatchObject({ ackedSeq: threadStarted });

    // Killed: its timers die with it (the waiting batch and the pending persist), nothing is
    // closed or flushed, and the host, batcher and journal are never used again. Only the
    // files on disk survive.
    vi.clearAllTimers();

    const restarted = new Journal(dir);
    expect(restarted.lastSeq).toBe(delivered.at(-1)?.seq);
    // The acked position on disk is behind: the turn start still counts as unacked...
    expect(restarted.unacked).toBe(delivered.length - 3);
    // ...until the server resumes from the last event it stored.
    restarted.ack(turnStarted);
    const replay = restarted.after(turnStarted);
    expect(replay).toEqual(delivered.slice(4)); // complete messages: seq, ts and payload
    const agent = (event: AgentEvent) => ({ kind: "agent", sessionId: "s1", event });
    expect(replay.map((m) => m.event)).toEqual([
      agent({ type: "item.started", ...at, item: message("m1", "", "in_progress") }),
      agent(delta("m1", "Hello")),
      agent(delta("m1", " world")),
      agent({ type: "item.completed", ...at, item: message("m1", "Hello world", "completed") }),
      agent({ type: "item.started", ...at, item: message("m2", "", "in_progress") }),
    ]);
    // "Still" + " typing" were never journaled or sent, so they are gone, along with the turn
    // the kill cut off. Seqs carry on after the last journaled event.
    expect(restarted.append({ kind: "runner.draining", reason: "restarted" }).seq).toBe(
      (delivered.at(-1)?.seq ?? 0) + 1,
    );
  });
});

function stateOf(dir: string): unknown {
  return JSON.parse(readFileSync(join(dir, "state.json"), "utf8"));
}

import { join } from "node:path";
import type {
  AgentEvent,
  ItemStatus,
  RunnerCommandOf,
  RunnerEventMessage,
} from "@codeden/contracts";
import { FakeProvider, type ProviderAdapter, type ProviderSession } from "@codeden/providers";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Journal, type RunningRunner, startRunner } from "../src";
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

const start = (cwd: string): RunnerCommandOf<"session.start"> => ({
  name: "session.start",
  sessionId: "s1",
  providerId: "stalling",
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

  it("are replayed in full and in order after the runner is killed mid-stream", async () => {
    const { adapter, streamed } = stallingProvider([
      ...opening,
      { type: "item.completed", ...at, item: message("m1", "Hello", "completed") },
      { type: "item.started", ...at, item: message("m2", "", "in_progress") },
      delta("m2", "wor"),
      delta("m2", "ld"),
    ]);
    const server = await attach(adapter);
    await server.request(start(home));
    await streamed;
    await server.waitFor(
      (m) =>
        m.type === "event" &&
        m.event.kind === "agent" &&
        m.event.event.type === "item.started" &&
        m.event.event.item.id === "m2",
    );
    const received = server.events();
    expect(received.map(label).slice(2)).toEqual([
      "agent:thread.started",
      "agent:turn.started",
      "agent:item.started",
      "agent:item.delta", // "Hel" + "lo", merged
      "agent:item.completed",
      "agent:item.started",
    ]);

    // The server stores events up to the merged delta and acks them; the runner only moves its
    // acked position in memory (the status round trip makes sure it has seen the ack).
    const stored = received[5]?.seq ?? 0;
    expect(received[5]?.event).toEqual({
      kind: "agent",
      sessionId: "s1",
      event: delta("m1", "Hello"),
    });
    server.send({ type: "ack", seq: stored });
    const status = await server.request({ name: "runner.status" });
    expect(status.journal.unacked).toBe(2);

    // Killed now: a new runner process loads the journal as it is on disk and the server
    // resumes from what it stored. "wor" + "ld" were still waiting in the batching window:
    // never journaled or sent, they end with the runner, as does the turn they belong to.
    const restarted = new Journal(join(home, "runner"));
    expect(restarted.lastSeq).toBe(received.at(-1)?.seq);
    restarted.ack(stored);
    const replay = restarted.after(stored);
    expect(replay).toEqual(received.filter((m) => m.seq > stored));
    expect(replay.map((m) => m.event)).toEqual([
      {
        kind: "agent",
        sessionId: "s1",
        event: { type: "item.completed", ...at, item: message("m1", "Hello", "completed") },
      },
      {
        kind: "agent",
        sessionId: "s1",
        event: { type: "item.started", ...at, item: message("m2", "", "in_progress") },
      },
    ]);
  });
});

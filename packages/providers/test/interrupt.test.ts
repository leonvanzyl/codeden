import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Options, Query, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import type { AgentEvent, SessionOptions } from "@codeden/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { ClaudeSession } from "../src/claude/session";
import { CodexSession } from "../src/codex/session";

const base: SessionOptions = {
  sessionId: "s1",
  role: "agent",
  cwd: tmpdir(),
  autonomy: "auto",
  mcpServers: [],
  additionalDirectories: [],
  planMode: false,
};

type InterruptOpts = { cancelQueued?: boolean } | undefined;

/**
 * A stand-in for the SDK's `query()` whose turns never finish on their own. It records the
 * prompts the session pushes and the options of each interrupt; `onInterrupt` decides the answer.
 */
function stubSdk(onInterrupt: (prompts: SDKUserMessage[]) => Promise<unknown>) {
  const prompts: SDKUserMessage[] = [];
  const interrupts: InterruptOpts[] = [];
  const query = ((params: { prompt: AsyncIterable<SDKUserMessage>; options: Options }) => {
    void (async () => {
      for await (const message of params.prompt) prompts.push(message);
    })();
    let finish = () => {};
    const done = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const q = {
      [Symbol.asyncIterator]: () => ({
        next: async () => {
          await done;
          return { done: true as const, value: undefined };
        },
      }),
      interrupt: (opts?: InterruptOpts) => {
        interrupts.push(opts);
        return onInterrupt(prompts);
      },
      supportedModels: async () => [],
      supportedCommands: async () => [],
      close: () => finish(),
    };
    return q as unknown as Query;
  }) as unknown as ConstructorParameters<typeof ClaudeSession>[1]["query"];
  return { query, prompts, interrupts };
}

const sessions: Array<{ close(): Promise<void> }> = [];
afterEach(async () => {
  await Promise.all(sessions.splice(0).map((s) => s.close()));
  delete process.env.FAKE_CODEX_TURN;
  delete process.env.FAKE_CODEX_REQUESTS;
  delete process.env.FAKE_CODEX_LOG;
});

function collect(events: AsyncIterable<AgentEvent>): AgentEvent[] {
  const seen: AgentEvent[] = [];
  void (async () => {
    for await (const e of events) seen.push(e);
  })();
  return seen;
}

const settle = () => new Promise((r) => setTimeout(r, 20));

describe("Claude interrupt", () => {
  it("closes the turn when the CLI never answers the interrupt", async () => {
    const sdk = stubSdk(() => new Promise(() => {}));
    const session = new ClaudeSession(base, {
      executable: { kind: "native", path: "/bin/claude" } as never,
      query: sdk.query,
      interruptTimeoutMs: 30,
    });
    sessions.push(session);
    const events = collect(session.events);
    await session.send({ text: "go", attachments: [] });

    const started = Date.now();
    await session.interrupt();
    expect(Date.now() - started).toBeLessThan(2000);
    await settle();
    expect(events.filter((e) => e.type === "turn.interrupted")).toHaveLength(1);
    expect(sdk.interrupts).toEqual([{ cancelQueued: true }]);
    // The session can take the next turn.
    await session.send({ text: "again", attachments: [] });
  });

  it("cancels steered messages still queued and says so in the transcript", async () => {
    const sdk = stubSdk(async (prompts) => ({
      still_queued: [],
      cancelled: prompts.map((p) => p.uuid).filter((u): u is NonNullable<typeof u> => !!u),
    }));
    const session = new ClaudeSession(base, {
      executable: { kind: "native", path: "/bin/claude" } as never,
      query: sdk.query,
      interruptTimeoutMs: 30,
    });
    sessions.push(session);
    const events = collect(session.events);
    await session.send({ text: "go", attachments: [] });
    await session.steer({ text: "also this", attachments: [] });
    await settle();
    expect(sdk.prompts[1]?.uuid).toMatch(/^[0-9a-f-]{36}$/);

    await session.interrupt();
    const notice = events.find((e) => e.type === "item.completed" && e.item.kind === "notice");
    expect(notice).toMatchObject({ item: { code: "queued_messages_cancelled" } });
    await settle();
    await settle();
    expect(events.filter((e) => e.type === "turn.interrupted")).toHaveLength(1);
  });
});

// Each test drives a fake Codex process, which takes seconds to start on a busy machine.
describe("Codex interrupt", { timeout: 30_000 }, () => {
  it("closes the turn when app-server never answers turn/interrupt", async () => {
    process.env.FAKE_CODEX_TURN = "hang";
    const session = new CodexSession(base, {
      executable: {
        kind: "node-script",
        path: process.execPath,
        script: join(import.meta.dirname, "fixtures", "fake-codex", "app-server.mjs"),
      },
      interruptTimeoutMs: 50,
    });
    sessions.push(session);
    const events = collect(session.events);
    await session.start();
    await session.send({ text: "go", attachments: [] });
    const deadline = Date.now() + 5000;
    while (!events.some((e) => e.type === "turn.started")) {
      if (Date.now() > deadline) throw new Error("turn did not start");
      await settle();
    }

    const started = Date.now();
    await session.interrupt();
    expect(Date.now() - started).toBeLessThan(2000);
    await settle();
    expect(events.filter((e) => e.type === "turn.interrupted")).toHaveLength(1);
  });

  const notify = (method: string, params: object, afterInterrupt = false) => ({
    notify: true,
    method,
    params,
    ...(afterInterrupt ? { afterInterrupt } : {}),
  });

  /**
   * A session on the fake app-server whose turn sends `script`, ready once `ready` holds.
   * Returns the session, its events and the `turn/interrupt` requests it made (`interrupts`).
   */
  async function scriptedSession(
    script: object[],
    ready: (events: AgentEvent[]) => boolean,
    turnMode?: "open",
  ) {
    const dir = mkdtempSync(join(tmpdir(), "codeden-codex-stop-"));
    writeFileSync(join(dir, "requests.json"), JSON.stringify(script));
    process.env.FAKE_CODEX_REQUESTS = join(dir, "requests.json");
    process.env.FAKE_CODEX_LOG = join(dir, "requests.log");
    if (turnMode) process.env.FAKE_CODEX_TURN = turnMode;
    const session = new CodexSession(base, { executable: fakeCodex, interruptTimeoutMs: 50 });
    sessions.push(session);
    const events = collect(session.events);
    await session.start();
    await session.send({ text: "go", attachments: [] });
    await waitFor(() => ready(events));
    const logged = () =>
      readFileSync(join(dir, "requests.log"), "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line))
        .filter((r) => r.method === "turn/interrupt")
        .map((r) => r.params);
    // The fake app-server logs a request a moment after the session sent it, which can be
    // after the session's own deadline closed the turn on a busy machine: wait for `count`.
    const interrupts = async (count: number) => {
      await waitFor(() => logged().length >= count);
      return logged();
    };
    return { session, events, interrupts };
  }

  /** A turn that spawns a sub-agent (`child-1`) and leaves its turn running a command. */
  function withRunningSubagent(turnMode?: "open") {
    return scriptedSession(
      [
        notify("item/completed", {
          item: {
            type: "subAgentActivity",
            id: "call-1",
            kind: "started",
            agentThreadId: "child-1",
            agentPath: "/root/auditor",
          },
        }),
        notify("turn/started", {
          threadId: "child-1",
          turn: { id: "ct-1", status: "inProgress", items: [], error: null },
        }),
        notify("item/started", {
          threadId: "child-1",
          turnId: "ct-1",
          item: {
            type: "commandExecution",
            id: "cmd-1",
            command: "pnpm test",
            cwd: "/w",
            status: "inProgress",
            commandActions: [],
            aggregatedOutput: null,
            exitCode: null,
            durationMs: null,
          },
        }),
      ],
      (events) => events.some((e) => e.type === "item.started" && e.item.id === "cmd-1"),
      turnMode,
    );
  }

  /** A v1 spawn of `child-2` whose agent isn't known yet: no receiver, no turn. */
  const spawnCall = (status: string, receivers: string[]) => ({
    type: "collabAgentToolCall",
    id: "call-2",
    tool: "spawnAgent",
    status,
    senderThreadId: "thread-1",
    receiverThreadIds: receivers,
    prompt: "Audit the parser",
    model: null,
    reasoningEffort: null,
    agentsStates: {},
  });
  const pendingCard = (events: AgentEvent[]) =>
    events.some((e) => e.type === "item.started" && e.item.id === "call-2");
  const cards = (events: AgentEvent[], id: string) =>
    events.flatMap((e) =>
      (e.type === "item.completed" || e.type === "item.updated") && e.item.id === id
        ? [{ type: e.type, item: e.item }]
        : [],
    );

  const childEnded = (events: AgentEvent[]) =>
    events.some((e) => e.type === "turn.interrupted" && e.threadId === "s1:thread-call-1");

  it("stops running sub-agents too, closing a child turn its interrupt never ends", async () => {
    const { session, events, interrupts } = await withRunningSubagent("open");
    await session.interrupt();
    // The root confirms at once; the child never does, so its deadline closes it.
    await waitFor(() => childEnded(events));
    expect(await interrupts(2)).toEqual(
      expect.arrayContaining([
        { threadId: "child-1", turnId: "ct-1" },
        { threadId: "thread-1", turnId: "turn-1" },
      ]),
    );
    expect(
      events.filter((e) => e.type === "turn.interrupted").map((e) => [e.threadId, e.turnId]),
    ).toEqual(
      expect.arrayContaining([
        ["s1:thread-root", "turn-1"],
        ["s1:thread-call-1", "ct-1"],
      ]),
    );
    const card = events.filter((e) => e.type === "item.completed" && e.item.kind === "subagent");
    expect(card.at(-1)).toMatchObject({
      threadId: "s1:thread-root",
      // The command the turn's end closed still counts as a tool call.
      item: { id: "call-1", status: "cancelled", stats: { toolUses: 1 } },
    });
  });

  it("cancels a spawn still pending when Stop comes", async () => {
    const { session, events, interrupts } = await scriptedSession(
      [notify("item/started", { item: spawnCall("inProgress", []) })],
      pendingCard,
      "open",
    );
    await session.interrupt();
    expect(cards(events, "call-2").at(-1)).toMatchObject({
      type: "item.completed",
      item: { status: "cancelled" },
    });
    await waitFor(() =>
      events.some((e) => e.type === "turn.interrupted" && e.threadId === "s1:thread-root"),
    );
    expect(await interrupts(1)).toEqual([{ threadId: "thread-1", turnId: "turn-1" }]);
  });

  it("stops the agent of a pending spawn that starts after Stop", async () => {
    const { session, events, interrupts } = await scriptedSession(
      [
        notify("item/started", { item: spawnCall("inProgress", []) }),
        // After the root turn is interrupted, the spawn completes and its agent starts.
        notify("item/completed", { item: spawnCall("completed", ["child-2"]) }, true),
        notify(
          "turn/started",
          {
            threadId: "child-2",
            turn: { id: "ct-2", status: "inProgress", items: [], error: null },
          },
          true,
        ),
      ],
      pendingCard,
      "open",
    );
    await session.interrupt();
    // Its interrupt is never confirmed, so the deadline closes that turn.
    await waitFor(() =>
      events.some((e) => e.type === "turn.interrupted" && e.threadId === "s1:thread-call-2"),
    );
    expect(await interrupts(2)).toEqual(
      expect.arrayContaining([
        { threadId: "thread-1", turnId: "turn-1" },
        { threadId: "child-2", turnId: "ct-2" },
      ]),
    );
    // The card stayed cancelled: it never showed the stopped agent as working again.
    expect(cards(events, "call-2").map((e) => e.item.status)).not.toContain("in_progress");
    expect(cards(events, "call-2").at(-1)).toMatchObject({ item: { status: "cancelled" } });
  });

  it("stops sub-agents still working after the session's own turn ended", async () => {
    const { session, events, interrupts } = await withRunningSubagent();
    await waitFor(() =>
      events.some((e) => e.type === "turn.completed" && e.threadId === "s1:thread-root"),
    );
    await session.interrupt();
    await waitFor(() => childEnded(events));
    expect(await interrupts(1)).toEqual([{ threadId: "child-1", turnId: "ct-1" }]);
    expect(
      events.filter((e) => e.type === "item.completed" && e.item.kind === "subagent").at(-1),
    ).toMatchObject({ item: { status: "cancelled" } });
  });
});

const fakeCodex = {
  kind: "node-script" as const,
  path: process.execPath,
  script: join(import.meta.dirname, "fixtures", "fake-codex", "app-server.mjs"),
};

async function waitFor(check: () => boolean): Promise<void> {
  const deadline = Date.now() + 20_000;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("timed out waiting");
    await settle();
  }
}

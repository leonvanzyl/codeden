import { AgentEvent } from "@codeden/contracts";
import { describe, expect, it } from "vitest";
import { mapThreadItem } from "../src/codex/items";
import { CodexEventMapper } from "../src/codex/mapper";
import type { ServerNotification } from "../src/codex/protocol";
import { CodexTurnUsage } from "../src/codex/usage";

const T = "thread-x";
const TURN = "turn-1";

function setup() {
  const events: AgentEvent[] = [];
  const mapper = new CodexEventMapper("s1", (e) => events.push(AgentEvent.parse(e)));
  mapper.codexThreadId = T;
  const feed = (method: string, params: object) =>
    mapper.handle({ method, params: { threadId: T, ...params } } as unknown as ServerNotification);
  return { mapper, events, feed };
}

const turn = (status: string, error: object | null = null) => ({
  id: TURN,
  items: [],
  itemsView: "summary",
  status,
  error,
  startedAt: 1,
  completedAt: 2,
  durationMs: 1000,
});

describe("CodexEventMapper", () => {
  it("keeps the sender of an input on its echoed user message", () => {
    const { mapper, events, feed } = setup();
    const userMessage = (id: string, clientId: string | null) =>
      feed("item/completed", {
        turnId: TURN,
        item: {
          type: "userMessage",
          id,
          clientId,
          content: [{ type: "text", text: "## Brief", text_elements: [] }],
        },
      });
    expect(mapper.clientMessageId({ text: "typed", attachments: [] })).toBeUndefined();
    const clientId = mapper.clientMessageId({ text: "## Brief", attachments: [], from: "factory" });
    expect(clientId).toBeTruthy();
    userMessage("u1", clientId ?? null);
    userMessage("u2", null);
    // An id is used once: a second echo with it is the user's.
    userMessage("u3", clientId ?? null);
    const inputs = events.flatMap((e) =>
      e.type === "item.completed" && e.item.kind === "user_message" ? [e.item.input] : [],
    );
    expect(inputs.map((i) => i.from)).toEqual(["factory", undefined, undefined]);
  });

  it("maps a turn with streamed text, a patch and a command", () => {
    const { events, feed } = setup();
    feed("turn/started", { turn: turn("inProgress") });
    feed("item/completed", {
      turnId: TURN,
      item: {
        type: "userMessage",
        id: "u1",
        clientId: null,
        content: [{ type: "text", text: "hi", text_elements: [] }],
      },
    });
    feed("item/started", {
      turnId: TURN,
      item: {
        type: "agentMessage",
        id: "m1",
        text: "",
        phase: null,
        memoryCitation: null,
        delivery: null,
        questions: null,
      },
    });
    feed("item/agentMessage/delta", { turnId: TURN, itemId: "m1", delta: "Hel" });
    feed("item/agentMessage/delta", { turnId: TURN, itemId: "m1", delta: "lo" });
    feed("item/completed", {
      turnId: TURN,
      item: {
        type: "agentMessage",
        id: "m1",
        text: "Hello",
        phase: null,
        memoryCitation: null,
        delivery: null,
        questions: null,
      },
    });
    const patch = {
      type: "fileChange",
      id: "p1",
      changes: [{ path: "/w/hello.txt", kind: { type: "add" }, diff: "hi\n" }],
      status: "inProgress",
    };
    feed("item/started", { turnId: TURN, item: patch });
    feed("item/completed", { turnId: TURN, item: { ...patch, status: "completed" } });
    const cmd = {
      type: "commandExecution",
      id: "c1",
      pluginId: null,
      scriptPath: null,
      command: "pwsh -Command 'echo done'",
      cwd: "/w",
      processId: null,
      source: "agent",
      status: "inProgress",
      commandActions: [{ type: "unknown", command: "echo done" }],
      aggregatedOutput: null,
      exitCode: null,
      durationMs: null,
    };
    feed("item/started", { turnId: TURN, item: cmd });
    feed("item/commandExecution/outputDelta", { turnId: TURN, itemId: "c1", delta: "done\n" });
    feed("item/completed", {
      turnId: TURN,
      item: {
        ...cmd,
        status: "completed",
        aggregatedOutput: "done\n",
        exitCode: 0,
        durationMs: 84,
      },
    });
    feed("thread/tokenUsage/updated", {
      turnId: TURN,
      tokenUsage: {
        total: {
          totalTokens: 100,
          inputTokens: 90,
          cachedInputTokens: 50,
          cacheWriteInputTokens: 0,
          outputTokens: 10,
          reasoningOutputTokens: 2,
        },
        last: {
          totalTokens: 60,
          inputTokens: 55,
          cachedInputTokens: 50,
          cacheWriteInputTokens: 0,
          outputTokens: 5,
          reasoningOutputTokens: 1,
        },
        modelContextWindow: 258400,
      },
    });
    feed("turn/completed", { turn: turn("completed") });

    expect(events[0]).toMatchObject({
      type: "turn.started",
      threadId: "s1:thread-root",
      turnId: TURN,
    });
    const completed = events.flatMap((e) => (e.type === "item.completed" ? [e.item] : []));
    expect(completed.map((i) => i.kind)).toEqual([
      "user_message",
      "assistant_message",
      "tool_call",
      "tool_call",
    ]);
    expect(completed[2]).toMatchObject({
      toolKind: "file_edit",
      changes: [{ path: "/w/hello.txt", change: "add", additions: 1 }],
    });
    expect(completed[3]).toMatchObject({
      toolKind: "command",
      command: "echo done",
      exitCode: 0,
      output: { text: "done\n" },
      durationMs: 84,
    });
    expect(events.find((e) => e.type === "usage.updated")).toMatchObject({
      // First report of this process: only the last request counts (the rest predates it).
      usage: {
        inputTokens: 5,
        outputTokens: 5,
        cachedInputTokens: 50,
        reasoningTokens: 1,
        contextTokens: 60,
        contextWindow: 258400,
      },
    });
    expect(events.at(-1)).toMatchObject({ type: "turn.completed" });
  });

  it("charges each turn the growth of the thread total and ignores repeats", () => {
    const acc = new CodexTurnUsage();
    const b = (input: number, cached: number, output: number) => ({
      totalTokens: input + output,
      inputTokens: input,
      cachedInputTokens: cached,
      cacheWriteInputTokens: 0,
      outputTokens: output,
      reasoningOutputTokens: 0,
    });
    const report = (total: ReturnType<typeof b>, last: ReturnType<typeof b>) => ({
      total,
      last,
      modelContextWindow: null,
    });
    acc.add("t1", report(b(100, 0, 10), b(100, 0, 10)));
    expect(acc.add("t1", report(b(100, 0, 10), b(100, 0, 10)))).toMatchObject({
      inputTokens: 100,
      outputTokens: 10,
    });
    expect(acc.add("t2", report(b(250, 100, 30), b(150, 100, 20)))).toMatchObject({
      inputTokens: 50,
      cachedInputTokens: 100,
      outputTokens: 20,
    });
  });

  it("maps plans to a todo list and finishes dangling items on interrupt", () => {
    const { events, feed } = setup();
    feed("turn/started", { turn: turn("inProgress") });
    feed("turn/plan/updated", {
      turnId: TURN,
      explanation: null,
      plan: [{ step: "A", status: "inProgress" }],
    });
    feed("turn/plan/updated", {
      turnId: TURN,
      explanation: null,
      plan: [
        { step: "A", status: "completed" },
        { step: "B", status: "pending" },
      ],
    });
    feed("item/started", {
      turnId: TURN,
      item: { type: "reasoning", id: "r1", summary: [], content: [] },
    });
    feed("turn/completed", { turn: turn("interrupted") });
    expect(
      events.filter((e) => "item" in e && e.item.kind === "todo_list").map((e) => e.type),
    ).toEqual(["item.started", "item.updated", "item.completed"]);
    expect(
      events.find((e) => e.type === "item.completed" && e.item.kind === "reasoning"),
    ).toMatchObject({ item: { status: "cancelled" } });
    expect(events.at(-1)).toMatchObject({ type: "turn.interrupted", reason: "user" });
  });

  it("fails turns with the Codex error and ignores unclaimed threads", () => {
    const { events, feed, mapper } = setup();
    mapper.handle({
      method: "turn/started",
      params: { threadId: "other", turn: turn("inProgress") },
    } as unknown as ServerNotification);
    expect(events).toHaveLength(0);
    feed("turn/started", { turn: turn("inProgress") });
    feed("turn/completed", {
      turn: turn("failed", {
        message: "Boom",
        codexErrorInfo: null,
        additionalDetails: "x",
        misalignment: null,
      }),
    });
    expect(events.at(-1)).toMatchObject({
      type: "turn.failed",
      error: { message: "Boom", detail: "x" },
    });
  });

  it("reports a root turn Codex ended as its own fork point, never one CodeDen closed", () => {
    const { events, feed, mapper } = setup();
    feed("turn/started", { turn: turn("inProgress") });
    feed("turn/completed", { turn: turn("completed") });
    expect(events.at(-1)).toMatchObject({ type: "turn.completed", turnId: TURN, forkPoint: TURN });
    feed("turn/started", { turn: turn("inProgress") });
    feed("turn/completed", { turn: turn("interrupted") });
    expect(events.at(-1)).toMatchObject({ type: "turn.interrupted", forkPoint: TURN });

    // The process died mid-turn: Codex may not have finished it, so it can't be forked at.
    feed("turn/started", { turn: turn("inProgress") });
    mapper.endAll({ type: "failed", message: "codex app-server exited" });
    expect(events.at(-1)?.type).toBe("turn.failed");
    expect(events.at(-1)).not.toHaveProperty("forkPoint");
  });

  it("maps rate limits", () => {
    const { events, feed } = setup();
    feed("account/rateLimits/updated", {
      rateLimits: {
        limitId: "codex",
        primary: { usedPercent: 85, windowDurationMins: 300, resetsAt: 1794465315 },
        secondary: null,
        rateLimitReachedType: null,
      },
    });
    expect(events[0]).toMatchObject({
      usage: { rateLimits: [{ id: "5h", status: "warning", usedPercent: 85 }] },
    });
  });
});

describe("Codex items", () => {
  it("classifies read and search command actions", () => {
    const base = {
      type: "commandExecution",
      id: "c",
      pluginId: null,
      scriptPath: null,
      command: "x",
      cwd: "/w",
      processId: null,
      source: "agent",
      status: "completed",
      aggregatedOutput: "",
      exitCode: 0,
      durationMs: 1,
    } as const;
    expect(
      mapThreadItem({
        ...base,
        commandActions: [{ type: "read", command: "cat a.ts", name: "a.ts", path: "/w/a.ts" }],
      } as never),
    ).toMatchObject({ toolKind: "file_read", path: "/w/a.ts" });
    expect(
      mapThreadItem({
        ...base,
        commandActions: [{ type: "search", command: "rg foo", query: "foo", path: null }],
      } as never),
    ).toMatchObject({ toolKind: "search", query: "foo" });
    expect(mapThreadItem({ ...base, exitCode: 1, commandActions: [] } as never)).toMatchObject({
      toolKind: "command",
      status: "failed",
    });
  });
});

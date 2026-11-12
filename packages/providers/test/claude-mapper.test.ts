import { AgentEvent } from "@codeden/contracts";
import { describe, expect, it } from "vitest";
import { ClaudeEventMapper } from "../src/claude/mapper";

function setup() {
  const events: AgentEvent[] = [];
  let n = 0;
  const mapper = new ClaudeEventMapper({
    sessionId: "s1",
    cwd: "/work/repo",
    emit: (e) => events.push(AgentEvent.parse(e)),
    newId: () => `id${++n}`,
  });
  mapper.start();
  return { mapper, events };
}

const se = (event: object, parent: string | null = null) => ({
  type: "stream_event",
  event,
  parent_tool_use_id: parent,
});
const assistant = (id: string, content: object[], parent: string | null = null) => ({
  type: "assistant",
  message: { id, content, usage: { input_tokens: 10, cache_read_input_tokens: 90 } },
  parent_tool_use_id: parent,
});
const toolResult = (
  id: string,
  content: unknown,
  extra: object = {},
  parent: string | null = null,
) => ({
  type: "user",
  message: {
    role: "user",
    content: [{ type: "tool_result", tool_use_id: id, content, is_error: false }],
  },
  parent_tool_use_id: parent,
  ...extra,
});
const result = (extra: object = {}) => ({
  type: "result",
  subtype: "success",
  is_error: false,
  stop_reason: "end_turn",
  total_cost_usd: 0.12,
  modelUsage: {
    m: {
      inputTokens: 5,
      outputTokens: 7,
      cacheReadInputTokens: 100,
      cacheCreationInputTokens: 50,
      contextWindow: 200000,
    },
  },
  ...extra,
});

describe("ClaudeEventMapper", () => {
  it("streams assistant text and completes it from the full message", () => {
    const { mapper, events } = setup();
    mapper.beginTurn();
    mapper.handle({ type: "system", subtype: "init", session_id: "claude-1", model: "claude-x" });
    mapper.handle(se({ type: "message_start", message: { id: "m1" } }));
    mapper.handle(
      se({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }),
    );
    mapper.handle(
      se({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Hel" } }),
    );
    mapper.handle(
      se({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "lo" } }),
    );
    mapper.handle(assistant("m1", [{ type: "text", text: "Hello" }]));
    mapper.handle(result());

    expect(mapper.resumeToken).toBe("claude-1");
    const types = events.map((e) => e.type);
    expect(types).toEqual([
      "thread.started",
      "turn.started",
      "session.updated",
      "item.started",
      "item.delta",
      "item.delta",
      "item.completed",
      "usage.updated",
      "turn.completed",
    ]);
    const done = events[6];
    expect(done?.type === "item.completed" && done.item).toMatchObject({
      id: "m1:0",
      kind: "assistant_message",
      text: "Hello",
    });
    const usage = events[7];
    expect(usage?.type === "usage.updated" && usage.usage).toMatchObject({
      inputTokens: 5,
      outputTokens: 7,
      cachedInputTokens: 100,
      cacheWriteTokens: 50,
      contextTokens: 100,
      contextWindow: 200000,
      costUsd: 0.12,
    });
  });

  it("maps tool calls with streamed input and results, including file edits", () => {
    const { mapper, events } = setup();
    mapper.beginTurn();
    mapper.handle(se({ type: "message_start", message: { id: "m1" } }));
    mapper.handle(
      se({
        type: "content_block_start",
        index: 0,
        content_block: { type: "tool_use", id: "t1", name: "Bash", input: {} },
      }),
    );
    mapper.handle(
      se({
        type: "content_block_delta",
        index: 0,
        delta: { type: "input_json_delta", partial_json: '{"command":"ls"}' },
      }),
    );
    mapper.handle(
      assistant("m1", [{ type: "tool_use", id: "t1", name: "Bash", input: { command: "ls" } }]),
    );
    mapper.handle(toolResult("t1", "a\nb"));
    mapper.handle(
      assistant("m2", [
        {
          type: "tool_use",
          id: "t2",
          name: "Write",
          input: { file_path: "/work/repo/hello.txt", content: "hi" },
        },
      ]),
    );
    mapper.handle(
      toolResult("t2", "File created", {
        tool_use_result: {
          type: "create",
          filePath: "/work/repo/hello.txt",
          content: "hi",
          structuredPatch: [],
        },
      }),
    );

    const items = events.flatMap((e) => (e.type === "item.completed" ? [e.item] : []));
    expect(items[0]).toMatchObject({
      kind: "tool_call",
      toolKind: "command",
      command: "ls",
      status: "completed",
      output: { text: "a\nb" },
    });
    expect(items[1]).toMatchObject({
      kind: "tool_call",
      toolKind: "file_edit",
      changes: [{ path: "/work/repo/hello.txt", change: "add", additions: 1 }],
    });
    expect(events.some((e) => e.type === "item.updated" && e.item.id === "t1")).toBe(true);
    expect(events.some((e) => e.type === "item.delta" && e.delta.type === "tool_input")).toBe(true);
  });

  it("turns TodoWrite into a todo_list updated in place", () => {
    const { mapper, events } = setup();
    mapper.beginTurn();
    const todos = (s: string) => [
      { content: "A", status: "completed", activeForm: "A" },
      { content: "B", status: s, activeForm: "B" },
    ];
    mapper.handle(
      assistant("m1", [
        { type: "tool_use", id: "t1", name: "TodoWrite", input: { todos: todos("pending") } },
      ]),
    );
    mapper.handle(toolResult("t1", "ok"));
    mapper.handle(
      assistant("m2", [
        { type: "tool_use", id: "t2", name: "TodoWrite", input: { todos: todos("completed") } },
      ]),
    );
    mapper.handle(result());
    const todoEvents = events.filter((e) => "item" in e && e.item.kind === "todo_list");
    expect(todoEvents.map((e) => e.type)).toEqual([
      "item.started",
      "item.updated",
      "item.completed",
    ]);
    expect(events.some((e) => "item" in e && e.item.kind === "tool_call")).toBe(false);
  });

  it("runs background subagents as child threads until task_notification", () => {
    const { mapper, events } = setup();
    mapper.beginTurn();
    mapper.handle(
      assistant("m1", [
        {
          type: "tool_use",
          id: "a1",
          name: "Agent",
          input: { description: "Run echo", prompt: "echo hi", subagent_type: "general-purpose" },
        },
      ]),
    );
    mapper.handle({
      type: "system",
      subtype: "task_started",
      task_id: "k",
      tool_use_id: "a1",
      is_backgrounded: true,
    });
    mapper.handle(
      toolResult("a1", "Async agent launched", {
        tool_use_result: { status: "async_launched", isAsync: true },
      }),
    );
    mapper.handle(
      assistant(
        "c1",
        [{ type: "tool_use", id: "t9", name: "Bash", input: { command: "echo hi" } }],
        "a1",
      ),
    );
    mapper.handle(toolResult("t9", "hi", {}, "a1"));
    mapper.handle(assistant("c2", [{ type: "text", text: "Output: hi" }], "a1"));
    mapper.handle(result());
    mapper.handle({
      type: "system",
      subtype: "task_notification",
      tool_use_id: "a1",
      status: "completed",
      summary: "Output: hi",
      usage: { total_tokens: 1520, tool_uses: 1, duration_ms: 4210 },
    });

    const child = "s1:thread-a1";
    expect(events.find((e) => e.type === "thread.started" && e.thread.id === child)).toMatchObject({
      thread: {
        parentThreadId: "s1:thread-root",
        parentItemId: "a1",
        agentType: "general-purpose",
      },
    });
    const childItems = events.filter((e) => "threadId" in e && e.threadId === child);
    expect(childItems.map((e) => e.type)).toEqual([
      "turn.started",
      "item.started",
      "item.completed",
      "item.completed",
      "turn.completed",
    ]);
    const sub = events.filter((e) => "item" in e && e.item.kind === "subagent");
    expect(sub.map((e) => e.type)).toEqual(["item.started", "item.completed"]);
    expect(sub[1]?.type === "item.completed" && sub[1].item).toMatchObject({
      status: "completed",
      summary: "Output: hi",
      childThreadId: child,
      stats: { totalTokens: 1520, toolUses: 1, durationMs: 4210 },
    });
    // The root turn completed before the background subagent finished.
    const order = events.map((e) => `${e.type}:${"threadId" in e ? e.threadId : ""}`);
    expect(order.indexOf("turn.completed:s1:thread-root")).toBeLessThan(
      order.indexOf(`turn.completed:${child}`),
    );
  });

  it("completes foreground subagents from their tool_result", () => {
    const { mapper, events } = setup();
    mapper.beginTurn();
    mapper.handle(
      assistant("m1", [
        { type: "tool_use", id: "a1", name: "Task", input: { description: "Review", prompt: "p" } },
      ]),
    );
    const trailer = "<usage>total_tokens: 99\ntool_uses: 9\nduration_ms: 999</usage>";
    mapper.handle(
      toolResult("a1", [{ type: "text", text: `All good\nagentId: abc\n${trailer}` }], {
        tool_use_result: {
          status: "completed",
          totalTokens: 48213,
          totalToolUseCount: 23,
          totalDurationMs: 72000,
        },
      }),
    );
    const sub = events.filter((e) => e.type === "item.completed" && e.item.kind === "subagent");
    // The structured result wins over the text trailer, which stays out of the summary.
    expect(sub[0]?.type === "item.completed" && sub[0].item).toMatchObject({
      summary: "All good",
      stats: { totalTokens: 48213, toolUses: 23, durationMs: 72000 },
    });
  });

  it("reads subagent figures from the usage trailer, and leaves them out when none came", () => {
    const { mapper, events } = setup();
    mapper.beginTurn();
    mapper.handle(
      assistant("m1", [
        { type: "tool_use", id: "a1", name: "Agent", input: { description: "One", prompt: "p" } },
        { type: "tool_use", id: "a2", name: "Agent", input: { description: "Two", prompt: "p" } },
        { type: "tool_use", id: "a3", name: "Agent", input: { description: "Three", prompt: "p" } },
      ]),
    );
    mapper.handle(
      toolResult("a1", "Done\nagentId: x\n<usage>total_tokens: 1200\ntool_uses: 3</usage>"),
    );
    mapper.handle(toolResult("a2", "Done", { tool_use_result: { status: "completed" } }));
    mapper.endTurn({ type: "interrupted", reason: "user" });

    const done = new Map(
      events.flatMap((e) =>
        e.type === "item.completed" && e.item.kind === "subagent" ? [[e.item.id, e.item]] : [],
      ),
    );
    expect(done.get("a1")).toMatchObject({
      summary: "Done",
      stats: { totalTokens: 1200, toolUses: 3 },
    });
    expect(done.get("a1")?.stats).not.toHaveProperty("durationMs");
    expect(done.get("a2")).not.toHaveProperty("stats");
    expect(done.get("a3")).toMatchObject({ status: "cancelled" });
    expect(done.get("a3")).not.toHaveProperty("stats");
  });

  it("keeps the turn open while queued input is pending, and ends interrupted turns", () => {
    const { mapper, events } = setup();
    mapper.beginTurn();
    mapper.handle(result({ queued_turn_count: 1 }));
    expect(mapper.turnId).toBeDefined();
    mapper.handle(result({ queued_turn_count: 0 }));
    expect(mapper.turnId).toBeUndefined();

    mapper.beginTurn();
    mapper.handle(se({ type: "message_start", message: { id: "m9" } }));
    mapper.handle(
      se({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }),
    );
    mapper.handle(
      se({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "partial" } }),
    );
    mapper.requestInterrupt();
    mapper.handle(result({ subtype: "error_during_execution", is_error: true }));
    const last = events.at(-1);
    expect(last).toMatchObject({ type: "turn.interrupted", reason: "user" });
    expect(events.at(-2)).toMatchObject({
      type: "item.completed",
      item: { status: "cancelled", text: "partial" },
    });
  });

  it("fails turns on error results and opens implicit turns for CLI-started work", () => {
    const { mapper, events } = setup();
    mapper.handle(assistant("m1", [{ type: "thinking", thinking: "", signature: "x" }]));
    expect(events[1]).toMatchObject({ type: "turn.started" });
    expect(events[2]).toMatchObject({
      type: "item.completed",
      item: { kind: "reasoning", redacted: true },
    });
    mapper.handle(
      result({ subtype: "error_max_turns", is_error: true, errors: ["Reached max turns"] }),
    );
    expect(events.at(-1)).toMatchObject({
      type: "turn.failed",
      error: { code: "error_max_turns", message: "Reached max turns" },
    });
  });

  it("reports each turn's own usage from the query's running totals", () => {
    const { mapper, events } = setup();
    mapper.beginTurn();
    mapper.handle(result());
    mapper.beginTurn();
    mapper.handle(
      result({
        total_cost_usd: 0.2,
        modelUsage: {
          m: {
            inputTokens: 8,
            outputTokens: 17,
            cacheReadInputTokens: 400,
            cacheCreationInputTokens: 50,
          },
        },
      }),
    );
    const usages = events.flatMap((e) => (e.type === "usage.updated" ? [e.usage] : []));
    expect(usages[1]).toMatchObject({
      inputTokens: 3,
      outputTokens: 10,
      cachedInputTokens: 300,
      cacheWriteTokens: 0,
      costUsd: 0.08,
    });
  });

  it("maps rate limit events", () => {
    const { mapper, events } = setup();
    mapper.handle({
      type: "rate_limit_event",
      rate_limit_info: {
        status: "allowed_warning",
        rateLimitType: "five_hour",
        utilization: 0.8,
        resetsAt: 1794283200,
      },
    });
    expect(events.at(-1)).toMatchObject({
      type: "usage.updated",
      usage: {
        rateLimits: [
          { id: "5h", status: "warning", usedPercent: 80, resetsAt: "2026-11-10T04:00:00.000Z" },
        ],
      },
    });
  });

  it("reports the root turn's last main-chain message as its fork point", () => {
    const { mapper, events } = setup();
    mapper.beginTurn();
    mapper.handle({ ...assistant("m1", [{ type: "text", text: "Let me look" }]), uuid: "a1" });
    mapper.handle({
      ...assistant("m2", [{ type: "tool_use", id: "toolu_1", name: "Read", input: {} }]),
      uuid: "a2",
    });
    mapper.handle({ ...toolResult("toolu_1", "file contents"), uuid: "u1" });
    // A subagent's messages live in its own transcript: never a fork point of the session.
    mapper.handle({ ...assistant("m3", [{ type: "text", text: "sub" }], "toolu_1"), uuid: "s1" });
    mapper.handle(result({ uuid: "r1" }));
    expect(events.at(-1)).toMatchObject({ type: "turn.completed", forkPoint: "u1" });

    // A turn that streamed no transcript message has none; the next turn starts afresh.
    mapper.beginTurn();
    mapper.handle(result({ subtype: "error_during_execution", is_error: true }));
    expect(events.at(-1)?.type).toBe("turn.failed");
    expect(events.at(-1)).not.toHaveProperty("forkPoint");

    mapper.beginTurn();
    mapper.handle({ ...assistant("m4", [{ type: "text", text: "Stopping" }]), uuid: "a4" });
    mapper.requestInterrupt();
    mapper.handle(result());
    expect(events.at(-1)).toMatchObject({ type: "turn.interrupted", forkPoint: "a4" });
  });
});

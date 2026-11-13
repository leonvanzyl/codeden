import { AgentEvent, type Item } from "@codeden/contracts";
import { describe, expect, it } from "vitest";
import { ApprovalBroker } from "../src/approvals";
import { handleServerRequest } from "../src/codex/approvals";
import { CodexEventMapper } from "../src/codex/mapper";
import type { ServerNotification, ServerRequest } from "../src/codex/protocol";

const ROOT = "codex-root";
const CHILD = "codex-child";
const RT = "turn-root";
const CT = "turn-child";
const ROOT_THREAD = "s1:thread-root";
const CHILD_THREAD = "s1:thread-call-spawn";

function setup() {
  let clock = 1_000;
  const events: AgentEvent[] = [];
  /** Sub-agent turns the mapper asked the session to stop. */
  const stopped: [codexThreadId: string, turnId: string][] = [];
  const mapper = new CodexEventMapper("s1", (e) => events.push(AgentEvent.parse(e)), {
    now: () => clock,
    stopTurn: (codexThreadId, turnId) => stopped.push([codexThreadId, turnId]),
  });
  mapper.codexThreadId = ROOT;
  const feed = (threadId: string, method: string, params: object) =>
    mapper.handle({ method, params: { threadId, ...params } } as unknown as ServerNotification);
  const tick = (ms: number) => {
    clock += ms;
  };
  const items = (kind: Item["kind"], type?: AgentEvent["type"]) =>
    events.flatMap((e) =>
      "item" in e && e.item.kind === kind && (!type || e.type === type) ? [e] : [],
    );
  return { mapper, events, feed, tick, items, stopped };
}

const turn = (id: string, status: string, error: object | null = null) => ({
  id,
  items: [],
  itemsView: "summary",
  status,
  error,
  startedAt: 1,
  completedAt: null,
  durationMs: null,
});

const spawn = (status: string, receivers: string[], states: object = {}) => ({
  type: "collabAgentToolCall",
  id: "call-spawn",
  tool: "spawnAgent",
  status,
  senderThreadId: ROOT,
  receiverThreadIds: receivers,
  prompt: "Find every caller of parseConfig\nand list them with their files",
  model: "gpt-5.2",
  reasoningEffort: null,
  agentsStates: states,
});

const activity = (kind: string, id = "call-spawn") => ({
  type: "subAgentActivity",
  id,
  kind,
  agentThreadId: CHILD,
  agentPath: "/root/explorer",
});

const message = (id: string, text: string) => ({
  type: "agentMessage",
  id,
  text,
  phase: null,
  memoryCitation: null,
  delivery: null,
  questions: null,
});

const command = (id: string, status: string) => ({
  type: "commandExecution",
  id,
  pluginId: null,
  scriptPath: null,
  command: "rg parseConfig",
  cwd: "/w",
  processId: null,
  source: "agent",
  status,
  commandActions: [{ type: "unknown", command: "rg parseConfig" }],
  aggregatedOutput: status === "completed" ? "a.ts\n" : null,
  exitCode: status === "completed" ? 0 : null,
  durationMs: null,
});

const usage = (total: number) => ({
  total: {
    totalTokens: total,
    inputTokens: total - 100,
    cachedInputTokens: 0,
    cacheWriteInputTokens: 0,
    outputTokens: 100,
    reasoningOutputTokens: 0,
  },
  last: {
    totalTokens: total,
    inputTokens: total - 100,
    cachedInputTokens: 0,
    cacheWriteInputTokens: 0,
    outputTokens: 100,
    reasoningOutputTokens: 0,
  },
  modelContextWindow: 258_400,
});

/** A v1 call from the root agent to others (message, wait, close, …). */
const collabCall = (
  tool: string,
  receivers: string[],
  states: object = {},
  id = `call-${tool}`,
) => ({
  type: "collabAgentToolCall",
  id,
  tool,
  status: "completed",
  senderThreadId: ROOT,
  receiverThreadIds: receivers,
  prompt: tool === "sendInput" ? "Also check tests" : null,
  model: null,
  reasoningEffort: null,
  agentsStates: states,
});

const subagentCards = (events: AgentEvent[]) =>
  events.flatMap((e) =>
    e.type === "item.completed" && e.item.kind === "subagent" ? [e.item] : [],
  );

/** A root turn that spawned the v2 way: card claimed and bound to CHILD in one step. */
function spawnedV2() {
  const s = setup();
  s.feed(ROOT, "turn/started", { turn: turn(RT, "inProgress") });
  s.feed(ROOT, "item/completed", { turnId: RT, item: activity("started") });
  return s;
}

describe("Codex sub-agents", () => {
  it("maps a spawn to a subagent card whose child thread gets the agent's work", () => {
    const { mapper, events, feed, tick, items } = setup();
    feed(ROOT, "turn/started", { turn: turn(RT, "inProgress") });
    feed(ROOT, "item/started", { turnId: RT, item: spawn("inProgress", []) });

    // The agent's first events arrive before its parent's spawn call completes.
    feed(CHILD, "turn/started", { turn: turn(CT, "inProgress") });
    feed(CHILD, "item/completed", {
      turnId: CT,
      item: {
        type: "userMessage",
        id: "u1",
        clientId: null,
        content: [{ type: "text", text: "Find every caller", text_elements: [] }],
      },
    });
    feed(CHILD, "item/started", { turnId: CT, item: message("m0", "") });
    feed(CHILD, "item/agentMessage/delta", { turnId: CT, itemId: "m0", delta: "Looking" });
    expect(events.filter((e) => "threadId" in e && e.threadId === CHILD_THREAD)).toEqual([]);

    feed(ROOT, "item/completed", {
      turnId: RT,
      item: spawn("completed", [CHILD], { [CHILD]: { status: "running", message: null } }),
    });
    feed(CHILD, "item/started", { turnId: CT, item: command("c1", "inProgress") });
    feed(CHILD, "item/commandExecution/outputDelta", { turnId: CT, itemId: "c1", delta: "a.ts" });
    feed(CHILD, "item/completed", { turnId: CT, item: command("c1", "completed") });
    feed(CHILD, "turn/plan/updated", {
      turnId: CT,
      explanation: null,
      plan: [{ step: "Search", status: "inProgress" }],
    });
    feed(CHILD, "thread/tokenUsage/updated", { turnId: CT, tokenUsage: usage(4_200) });
    feed(CHILD, "item/completed", { turnId: CT, item: message("m0", "Looking") });
    feed(CHILD, "item/completed", { turnId: CT, item: message("m1", "Found 3 callers.") });
    tick(5_000);
    feed(CHILD, "turn/completed", { turn: turn(CT, "completed") });

    expect(events.find((e) => e.type === "thread.started")).toEqual({
      type: "thread.started",
      thread: {
        id: CHILD_THREAD,
        parentThreadId: ROOT_THREAD,
        parentItemId: "call-spawn",
        title: "Find every caller of parseConfig",
      },
    });
    expect(items("subagent", "item.started")).toEqual([
      expect.objectContaining({
        threadId: ROOT_THREAD,
        turnId: RT,
        item: expect.objectContaining({
          id: "call-spawn",
          status: "in_progress",
          childThreadId: CHILD_THREAD,
        }),
      }),
    ]);
    // The spawn call is the card, never a tool call.
    expect(
      events.some((e) => "item" in e && e.item.kind === "tool_call" && e.item.id === "call-spawn"),
    ).toBe(false);

    // Held events replay in order, then the rest follow, all on the child thread.
    const child = events.filter((e) => "threadId" in e && e.threadId === CHILD_THREAD);
    expect(child.map((e) => e.type)).toEqual([
      "turn.started",
      "item.started",
      "item.delta",
      "item.started",
      "item.delta",
      "item.completed",
      "item.started",
      "usage.updated",
      "item.completed",
      "item.completed",
      "item.completed",
      "turn.completed",
    ]);
    expect(child.every((e) => !("turnId" in e) || e.turnId === CT)).toBe(true);
    // The parent agent's message to it is on the card, not shown as the user's.
    expect(items("user_message")).toEqual([]);
    // Its tokens count for the session, but the context meter stays the root agent's.
    const childUsage = child.find((e) => e.type === "usage.updated");
    expect(childUsage).toMatchObject({ usage: { inputTokens: 4_100, outputTokens: 100 } });
    expect(childUsage && "usage" in childUsage && childUsage.usage.contextTokens).toBeUndefined();

    expect(items("subagent", "item.completed").at(-1)).toMatchObject({
      threadId: ROOT_THREAD,
      turnId: RT,
      item: {
        status: "completed",
        summary: "Found 3 callers.",
        prompt: expect.stringContaining("parseConfig"),
        stats: {
          totalTokens: 4_200,
          toolUses: 1,
          durationMs: 5_000,
          // By category, with the model the spawn asked for, for the card's cost.
          usage: [
            {
              model: "gpt-5.2",
              inputTokens: 4_100,
              outputTokens: 100,
              cacheReadTokens: 0,
              cacheWriteTokens: 0,
            },
          ],
        },
      },
    });
    // The root turn never moved.
    expect(mapper.currentTurnId).toBe(RT);
    expect(
      events.some(
        (e) =>
          "threadId" in e &&
          e.threadId === ROOT_THREAD &&
          (e.type === "turn.completed" || e.type === "turn.interrupted"),
      ),
    ).toBe(false);
  });

  it("reports the agent's uncached input, cache and reasoning tokens; no model when none was asked", () => {
    const { feed, events } = spawnedV2();
    const breakdown = {
      totalTokens: 52_000,
      inputTokens: 50_000,
      cachedInputTokens: 46_000,
      cacheWriteInputTokens: 1_500,
      outputTokens: 2_000,
      reasoningOutputTokens: 800,
    };
    feed(CHILD, "turn/started", { turn: turn(CT, "inProgress") });
    feed(CHILD, "thread/tokenUsage/updated", {
      turnId: CT,
      tokenUsage: { total: breakdown, last: breakdown, modelContextWindow: null },
    });
    feed(CHILD, "item/completed", { turnId: CT, item: message("m1", "Done.") });
    feed(CHILD, "turn/completed", { turn: turn(CT, "completed") });

    const card = subagentCards(events).at(-1);
    expect(card?.status).toBe("completed");
    expect(card?.stats?.totalTokens).toBe(52_000);
    // OpenAI counts cached input inside `inputTokens`; the card's input is the uncached part.
    expect(card?.stats?.usage).toEqual([
      {
        inputTokens: 4_000,
        outputTokens: 2_000,
        cacheReadTokens: 46_000,
        cacheWriteTokens: 1_500,
        reasoningTokens: 800,
      },
    ]);
  });

  it("fails the card when the spawn starts no agent", () => {
    const { feed, items } = setup();
    feed(ROOT, "turn/started", { turn: turn(RT, "inProgress") });
    feed(ROOT, "item/completed", { turnId: RT, item: spawn("failed", []) });
    expect(items("subagent", "item.completed")).toEqual([
      expect.objectContaining({
        item: expect.objectContaining({ status: "failed", summary: "Could not start the agent" }),
      }),
    ]);
  });

  it("drops threads no spawn claims", () => {
    const { events, feed } = setup();
    feed(ROOT, "turn/started", { turn: turn(RT, "inProgress") });
    const before = events.length;
    feed("internal-reviewer", "turn/started", { turn: turn("x", "inProgress") });
    feed("internal-reviewer", "item/completed", { turnId: "x", item: message("r1", "ok") });
    feed("internal-reviewer", "turn/completed", { turn: turn("x", "completed") });
    expect(events.length).toBe(before);
  });

  it("follows the agent's turns from v2 activity reports", () => {
    const { events, feed, items, tick } = spawnedV2();
    expect(events.find((e) => e.type === "thread.started")).toMatchObject({
      thread: { id: CHILD_THREAD, parentItemId: "call-spawn", title: "explorer" },
    });
    expect(items("subagent", "item.started")).toEqual([
      expect.objectContaining({
        item: expect.objectContaining({ description: "explorer", childThreadId: CHILD_THREAD }),
      }),
    ]);

    feed(CHILD, "turn/started", { turn: turn(CT, "inProgress") });
    feed(CHILD, "item/completed", { turnId: CT, item: message("m1", "Done.") });
    // Codex reports the agent finished: the card closes at once, its turn still running.
    feed(ROOT, "item/completed", { turnId: RT, item: activity("completed", "act-2") });
    expect(items("subagent", "item.completed").at(-1)).toMatchObject({
      item: { status: "completed", summary: "Done." },
    });
    // What that turn still sends lands in the child thread, and its end refreshes the card.
    tick(2_000);
    feed(CHILD, "item/completed", { turnId: CT, item: message("m2", "Done, with notes.") });
    feed(CHILD, "turn/completed", { turn: turn(CT, "completed") });
    expect(items("subagent", "item.updated")).toEqual([]);
    expect(items("subagent", "item.completed").at(-1)).toMatchObject({
      item: {
        status: "completed",
        summary: "Done, with notes.",
        stats: { toolUses: 0, durationMs: 2_000 },
      },
    });

    // The parent gives it more work: the card is working again, then fails with the turn.
    feed(CHILD, "turn/started", { turn: turn("turn-child-2", "inProgress") });
    expect(items("subagent", "item.updated").at(-1)).toMatchObject({
      item: { status: "in_progress" },
    });
    expect(items("subagent", "item.updated").at(-1)?.item).not.toHaveProperty("summary");
    feed(CHILD, "turn/completed", {
      turn: turn("turn-child-2", "failed", {
        message: "Boom",
        codexErrorInfo: null,
        additionalDetails: null,
      }),
    });
    expect(items("subagent", "item.completed").at(-1)).toMatchObject({
      item: { status: "failed", summary: "Boom" },
    });
    // Activity reports are never their own items.
    expect(
      events.some(
        (e) =>
          "item" in e && ["act-2", "call-spawn"].includes(e.item.id) && e.item.kind !== "subagent",
      ),
    ).toBe(false);
  });

  it("closes the card when an agent is reported stopped", () => {
    const { feed, items } = spawnedV2();
    feed(ROOT, "item/completed", { turnId: RT, item: activity("interrupted", "act-3") });
    expect(items("subagent", "item.completed")).toEqual([
      expect.objectContaining({ item: expect.objectContaining({ status: "cancelled" }) }),
    ]);
    // It never ran a turn, so there are no figures to show.
    expect(items("subagent", "item.completed")[0]?.item).not.toHaveProperty("stats");

    // Also while a turn of it runs.
    const running = spawnedV2();
    running.feed(CHILD, "turn/started", { turn: turn(CT, "inProgress") });
    running.feed(ROOT, "item/completed", { turnId: RT, item: activity("interrupted", "act-4") });
    expect(running.items("subagent", "item.completed").at(-1)).toMatchObject({
      item: { status: "cancelled" },
    });
  });

  it("closes the card from the final state a v1 spawn reports", () => {
    const { events, feed } = setup();
    feed(ROOT, "turn/started", { turn: turn(RT, "inProgress") });
    const states = (status: string, message: string | null) => ({ status, message });
    const spawned = (id: string, child: string, state: object) => ({
      ...spawn("completed", [child], { [child]: state }),
      id,
    });
    feed(ROOT, "item/completed", {
      turnId: RT,
      item: spawned("call-a", "codex-a", states("completed", "All done")),
    });
    feed(ROOT, "item/completed", {
      turnId: RT,
      item: spawned("call-b", "codex-b", states("shutdown", null)),
    });
    feed(ROOT, "item/completed", {
      turnId: RT,
      item: { ...spawned("call-c", "codex-c", states("errored", "Crashed")), status: "failed" },
    });
    feed(ROOT, "item/completed", {
      turnId: RT,
      item: spawned("call-d", "codex-d", states("notFound", null)),
    });
    expect(subagentCards(events).map((c) => [c.id, c.status, c.summary])).toEqual([
      ["call-a", "completed", "All done"],
      ["call-b", "cancelled", undefined],
      ["call-c", "failed", "Crashed"],
      ["call-d", "failed", undefined],
    ]);
  });

  it("keeps a reported final message as the summary, in either order", () => {
    const report = collabCall("wait", [CHILD], {
      [CHILD]: { status: "completed", message: "3 callers" },
    });

    // Reported while the agent's turn still runs, then the turn ends without a message.
    const before = spawnedV2();
    before.feed(CHILD, "turn/started", { turn: turn(CT, "inProgress") });
    before.feed(ROOT, "item/completed", { turnId: RT, item: report });
    expect(subagentCards(before.events)).toEqual([]);
    before.feed(CHILD, "turn/completed", { turn: turn(CT, "completed") });
    expect(subagentCards(before.events).at(-1)).toMatchObject({
      status: "completed",
      summary: "3 callers",
    });

    // The turn ends without a message first, then the report arrives.
    const after = spawnedV2();
    after.feed(CHILD, "turn/started", { turn: turn(CT, "inProgress") });
    after.feed(CHILD, "turn/completed", { turn: turn(CT, "completed") });
    expect(subagentCards(after.events).at(-1)).not.toHaveProperty("summary");
    after.feed(ROOT, "item/completed", { turnId: RT, item: report });
    expect(subagentCards(after.events).at(-1)).toMatchObject({
      status: "completed",
      summary: "3 callers",
    });

    // A spawn whose replayed turn still runs keeps its reported message for the turn's end.
    const spawnedRunning = setup();
    spawnedRunning.feed(ROOT, "turn/started", { turn: turn(RT, "inProgress") });
    spawnedRunning.feed(CHILD, "turn/started", { turn: turn(CT, "inProgress") });
    spawnedRunning.feed(ROOT, "item/completed", {
      turnId: RT,
      item: spawn("completed", [CHILD], { [CHILD]: { status: "completed", message: "Fine" } }),
    });
    expect(subagentCards(spawnedRunning.events)).toEqual([]);
    spawnedRunning.feed(CHILD, "turn/completed", { turn: turn(CT, "completed") });
    expect(subagentCards(spawnedRunning.events).at(-1)).toMatchObject({ summary: "Fine" });
  });

  it("titles calls between agents after the agents they target", () => {
    const { feed, items } = spawnedV2();
    const call = (tool: string, receivers: string[], states: object = {}) =>
      collabCall(tool, receivers, states);
    feed(ROOT, "item/completed", { turnId: RT, item: call("sendInput", [CHILD]) });
    feed(ROOT, "item/completed", { turnId: RT, item: call("wait", [CHILD, "other"]) });
    feed(ROOT, "item/completed", {
      turnId: RT,
      item: call("wait", [CHILD], { [CHILD]: { status: "completed", message: "All done" } }),
    });
    feed(ROOT, "item/completed", { turnId: RT, item: call("listAgents", []) });
    const calls = items("tool_call", "item.completed").map((e) => ("item" in e ? e.item : null));
    expect(calls.map((c) => c?.kind === "tool_call" && c.title)).toEqual([
      "Message agent: explorer",
      "Wait for 2 agents",
      "Wait for agent: explorer",
      "List agents",
    ]);
    expect(calls[2]).toMatchObject({ output: { text: "explorer (completed): All done" } });
    // A final status for an agent with no running turn closes its card.
    expect(items("subagent", "item.completed").at(-1)).toMatchObject({
      item: { status: "completed", summary: "All done" },
    });
  });

  it("nests agents that sub-agents spawn", () => {
    const { feed, events } = spawnedV2();
    feed(CHILD, "turn/started", { turn: turn(CT, "inProgress") });
    feed(CHILD, "item/completed", {
      turnId: CT,
      item: { ...activity("started", "call-nested"), agentThreadId: "codex-grandchild" },
    });
    feed("codex-grandchild", "turn/started", { turn: turn("turn-gc", "inProgress") });
    expect(events.filter((e) => e.type === "thread.started").at(-1)).toMatchObject({
      thread: { id: "s1:thread-call-nested", parentThreadId: CHILD_THREAD },
    });
    expect(events.at(-1)).toMatchObject({
      type: "turn.started",
      threadId: "s1:thread-call-nested",
      turnId: "turn-gc",
    });
  });

  it("keeps the session model and root turn when a sub-agent reroutes or fails", () => {
    const { mapper, events, feed } = spawnedV2();
    feed(CHILD, "turn/started", { turn: turn(CT, "inProgress") });
    feed(CHILD, "model/rerouted", {
      turnId: CT,
      fromModel: "a",
      toModel: "b",
      reason: "highRiskCyberActivity",
    });
    expect(events.some((e) => e.type === "session.updated")).toBe(false);
    feed(ROOT, "model/rerouted", { turnId: RT, fromModel: "a", toModel: "b", reason: "x" });
    expect(events.at(-1)).toEqual({ type: "session.updated", model: "b" });
    expect(mapper.currentTurnId).toBe(RT);
  });

  it("takes a turn's actual outcome after Codex reported the agent done", () => {
    const failed = spawnedV2();
    failed.feed(CHILD, "turn/started", { turn: turn(CT, "inProgress") });
    failed.feed(ROOT, "item/completed", { turnId: RT, item: activity("completed", "act-5") });
    expect(subagentCards(failed.events).at(-1)).toMatchObject({ status: "completed" });
    failed.feed(CHILD, "turn/completed", {
      turn: turn(CT, "failed", { message: "Boom", codexErrorInfo: null, additionalDetails: null }),
    });
    expect(subagentCards(failed.events).at(-1)).toMatchObject({
      status: "failed",
      summary: "Boom",
    });

    // Closing the turn itself (session close, exit) doesn't overrule what Codex reported.
    const closed = spawnedV2();
    closed.feed(CHILD, "turn/started", { turn: turn(CT, "inProgress") });
    closed.feed(ROOT, "item/completed", { turnId: RT, item: activity("completed", "act-6") });
    closed.mapper.endAll({ type: "interrupted" });
    expect(subagentCards(closed.events).at(-1)).toMatchObject({ status: "completed" });
  });

  it("cancels agents with no turn yet on Stop, and stops the turn they start late", () => {
    const { mapper, events, feed, items, stopped } = setup();
    feed(ROOT, "turn/started", { turn: turn(RT, "inProgress") });
    // A v1 spawn still pending, and a v2 agent that has not started a turn.
    feed(ROOT, "item/started", { turnId: RT, item: spawn("inProgress", []) });
    feed(ROOT, "item/completed", {
      turnId: RT,
      item: { ...activity("started", "call-v2"), agentThreadId: "codex-v2" },
    });

    expect(mapper.stopSubagents()).toEqual([]);
    expect(subagentCards(events).map((c) => [c.id, c.status])).toEqual([
      ["call-spawn", "cancelled"],
      ["call-v2", "cancelled"],
    ]);
    mapper.endTurn({ type: "interrupted" });

    // The pending spawn completes and its agent starts after Stop: that turn is stopped too.
    feed(ROOT, "item/completed", { turnId: RT, item: spawn("completed", [CHILD]) });
    feed(CHILD, "turn/started", { turn: turn(CT, "inProgress") });
    expect(stopped).toEqual([[CHILD, CT]]);
    expect(items("subagent", "item.updated")).toEqual([]);
    feed(CHILD, "turn/completed", { turn: turn(CT, "interrupted") });
    expect(subagentCards(events).at(-1)).toMatchObject({ id: "call-spawn", status: "cancelled" });

    // The session's next turn is new work: the other agent may run again.
    mapper.beginTurn("turn-root-2");
    feed("codex-v2", "turn/started", { turn: turn("turn-v2", "inProgress") });
    expect(stopped).toEqual([[CHILD, CT]]);
    expect(items("subagent", "item.updated").at(-1)).toMatchObject({
      item: { id: "call-v2", status: "in_progress" },
    });
  });

  it("routes a sub-agent's approvals to its child thread", async () => {
    const { mapper, feed } = spawnedV2();
    feed(CHILD, "turn/started", { turn: turn(CT, "inProgress") });
    const ask = async (threadId: string, turnId: string) => {
      const events: AgentEvent[] = [];
      const broker = new ApprovalBroker((e) => events.push(AgentEvent.parse(e)));
      const pending = handleServerRequest(
        {
          method: "item/commandExecution/requestApproval",
          id: 1,
          params: {
            threadId,
            turnId,
            itemId: `c-${threadId}`,
            command: "rm -rf build",
            cwd: "/w",
            commandActions: [],
          },
        } as unknown as ServerRequest,
        {
          broker,
          risk: { cwd: "/w", platform: "linux" },
          ctx: (t, turn) => mapper.requestCtx(t, turn),
          filePaths: () => undefined,
        },
      );
      const started = events[0];
      if (started?.type !== "item.started" || started.item.kind !== "approval_request")
        throw new Error("no request");
      broker.respond(started.item.requestId, { kind: "approval", decision: "deny" });
      await pending;
      return started;
    };
    expect(await ask(CHILD, CT)).toMatchObject({ threadId: CHILD_THREAD, turnId: CT });
    expect(await ask(ROOT, RT)).toMatchObject({ threadId: ROOT_THREAD, turnId: RT });
    expect(await ask("unknown", "t9")).toMatchObject({ threadId: ROOT_THREAD, turnId: RT });
  });

  it("stops sub-agents with the session, and fails them when Codex exits", () => {
    const stopped = spawnedV2();
    stopped.feed(CHILD, "turn/started", { turn: turn(CT, "inProgress") });
    // A root turn that ends normally leaves running agents alone.
    stopped.feed(ROOT, "turn/completed", { turn: turn(RT, "completed") });
    expect(stopped.mapper.runningSubagentTurns()).toEqual([{ codexThreadId: CHILD, turnId: CT }]);
    stopped.mapper.endAll({ type: "interrupted" });
    expect(stopped.events.filter((e) => e.type === "turn.interrupted")).toEqual([
      expect.objectContaining({ threadId: CHILD_THREAD, turnId: CT }),
    ]);
    expect(stopped.items("subagent", "item.completed").at(-1)).toMatchObject({
      item: { status: "cancelled" },
    });

    const exited = spawnedV2();
    exited.feed(CHILD, "turn/started", { turn: turn(CT, "inProgress") });
    exited.feed(CHILD, "item/started", { turnId: CT, item: command("c1", "inProgress") });
    exited.mapper.endAll({
      type: "failed",
      code: "provider_exited",
      kind: "transient",
      message: "codex app-server exited (code 1)",
    });
    expect(exited.events.filter((e) => e.type === "turn.failed").map((e) => e.threadId)).toEqual([
      ROOT_THREAD,
      CHILD_THREAD,
    ]);
    expect(exited.items("subagent", "item.completed").at(-1)).toMatchObject({
      // The command the exit cut short still counts, once.
      item: {
        status: "failed",
        summary: "codex app-server exited (code 1)",
        stats: { toolUses: 1 },
      },
    });
    expect(exited.mapper.runningSubagentTurns()).toEqual([]);
  });
});

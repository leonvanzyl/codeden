import {
  AgentEvent,
  type RuntimeResponse,
  type SessionOptions,
  UserInput,
} from "@codeden/contracts";
import { describe, expect, it } from "vitest";
import { FakeProvider, ProviderRegistry, type ProviderSession, providerInfo } from "../src";

const options: SessionOptions = {
  sessionId: "s1",
  role: "agent",
  cwd: "/tmp/work",
  autonomy: "auto",
  mcpServers: [],
  additionalDirectories: [],
  planMode: false,
};

/** Collect events until `until` matches (inclusive). */
async function collectUntil(
  session: ProviderSession,
  until: (e: AgentEvent) => boolean,
  onEvent?: (e: AgentEvent) => void,
): Promise<AgentEvent[]> {
  const out: AgentEvent[] = [];
  for await (const event of session.events) {
    AgentEvent.parse(event); // every emitted event must satisfy the contract
    out.push(event);
    onEvent?.(event);
    if (until(event)) break;
  }
  return out;
}

const isTurnEnd = (e: AgentEvent) =>
  (e.type === "turn.completed" || e.type === "turn.failed" || e.type === "turn.interrupted") &&
  e.threadId === "s1:thread-root";

describe("FakeProvider", () => {
  it("detects as installed and describes itself", async () => {
    const provider = new FakeProvider();
    const status = await provider.detect();
    expect(status.installed && status.loggedIn).toBe(true);
    expect(providerInfo(provider).capabilities.subagents).toBe(true);
    const registry = new ProviderRegistry([provider]);
    expect(registry.get("fake")).toBe(provider);
    expect(() => registry.register(new FakeProvider())).toThrow();
  });

  it("streams a deterministic turn", async () => {
    const session = await new FakeProvider().openSession(options);
    await session.send(UserInput.parse({ text: "hello world" }));
    const events = await collectUntil(session, isTurnEnd);
    expect(session.resumeToken()).toBe("fake-s1");

    const types = events.map((e) => e.type);
    expect(types.slice(0, 3)).toEqual(["thread.started", "session.updated", "turn.started"]);
    expect(types.at(-1)).toBe("turn.completed");

    const text = events
      .filter((e) => e.type === "item.delta" && e.delta.type === "text")
      .map((e) => (e.type === "item.delta" && e.delta.type === "text" ? e.delta.text : ""))
      .join("");
    expect(text).toBe("Echo: hello world");

    const completed = events.flatMap((e) => (e.type === "item.completed" ? [e.item] : []));
    const kinds = completed.map((i) => i.kind);
    expect(kinds).toEqual([
      "user_message",
      "assistant_message",
      "tool_call",
      "todo_list",
      "followups",
    ]);
    const tool = completed.find((i) => i.kind === "tool_call");
    expect(tool?.kind === "tool_call" && tool.toolKind === "command" && tool.exitCode).toBe(0);

    // Determinism: a second identical session yields the same event sequence.
    const again = await new FakeProvider().openSession(options);
    await again.send(UserInput.parse({ text: "hello world" }));
    expect(await collectUntil(again, isTurnEnd)).toEqual(events);
    await session.close();
    await again.close();
  });

  it("waits for an approval and continues when allowed", async () => {
    const session = await new FakeProvider().openSession(options);
    await session.send(UserInput.parse({ text: "do it [approval]" }));
    const events = await collectUntil(session, isTurnEnd, (e) => {
      if (e.type === "item.started" && e.item.kind === "approval_request") {
        void session.respond(e.item.requestId, { kind: "approval", decision: "allow_once" });
      }
    });
    const approval = events.find(
      (e) => e.type === "item.completed" && e.item.kind === "approval_request",
    );
    expect(approval?.type === "item.completed" && approval.item.status).toBe("completed");
    expect(events.some((e) => e.type === "item.completed" && e.item.kind === "tool_call")).toBe(
      true,
    );
    await session.close();
  });

  it("skips the tool call when an approval is denied", async () => {
    const session = await new FakeProvider({ approval: true }).openSession(options);
    await session.send(UserInput.parse({ text: "x" }));
    const events = await collectUntil(session, isTurnEnd, (e) => {
      if (e.type === "item.started" && e.item.kind === "approval_request") {
        void session.respond(e.item.requestId, { kind: "approval", decision: "deny" });
      }
    });
    expect(events.some((e) => e.type === "item.completed" && e.item.kind === "tool_call")).toBe(
      false,
    );
    expect(events.at(-1)?.type).toBe("turn.completed");
    await expect(session.respond("nope", { kind: "cancel" })).rejects.toThrow(/Unknown request/);
    await session.close();
  });

  it("plans first in plan mode: approve to do the work, deny to keep planning", async () => {
    expect(new FakeProvider().capabilities().planMode).toBe(true);
    const session = await new FakeProvider().openSession({ ...options, planMode: true });
    const events: AgentEvent[] = [];
    let answer: RuntimeResponse = { kind: "approval", decision: "deny", message: "Add tests" };
    void (async () => {
      for await (const e of session.events) {
        events.push(AgentEvent.parse(e));
        if (e.type === "item.started" && e.item.kind === "approval_request") {
          void session.respond(e.item.requestId, answer);
        }
      }
    })();
    /** Run a turn and return its events. */
    const turn = async (text: string) => {
      const from = events.length;
      const ends = events.filter(isTurnEnd).length;
      await session.send(UserInput.parse({ text }));
      while (events.filter(isTurnEnd).length === ends) await new Promise((r) => setImmediate(r));
      return events.slice(from);
    };
    const kinds = (list: AgentEvent[]) =>
      list.flatMap((e) => (e.type === "item.completed" ? [e.item.kind] : []));

    const declined = await turn("add a README");
    expect(kinds(declined)).toEqual([
      "user_message",
      "plan",
      "approval_request",
      "assistant_message",
    ]);
    expect(declined.some((e) => e.type === "session.updated" && e.planMode !== undefined)).toBe(
      false,
    );

    answer = { kind: "approval", decision: "allow_once" };
    const approved = await turn("add a README with tests");
    const approval = approved.find(
      (e) => e.type === "item.completed" && e.item.kind === "approval_request",
    );
    expect(approval?.type === "item.completed" && approval.item).toMatchObject({
      action: "plan",
      status: "completed",
    });
    expect(approved).toContainEqual({ type: "session.updated", planMode: false });
    expect(kinds(approved)).toContain("tool_call");

    // Out of plan mode, the next turn does the work straight away.
    expect(kinds(await turn("more"))).not.toContain("plan");
    await session.close();
  });

  it("runs a subagent as a linked child thread", async () => {
    const session = await new FakeProvider().openSession(options);
    await session.send(UserInput.parse({ text: "review [subagent]" }));
    const events = await collectUntil(session, isTurnEnd);
    const child = events.find((e) => e.type === "thread.started" && e.thread.parentThreadId);
    expect(child?.type).toBe("thread.started");
    if (child?.type !== "thread.started") return;
    const subItem = events.find((e) => e.type === "item.completed" && e.item.kind === "subagent");
    expect(subItem?.type === "item.completed" && subItem.item.id).toBe(child.thread.parentItemId);
    expect(events.some((e) => e.type === "turn.completed" && e.threadId === child.thread.id)).toBe(
      true,
    );
    await session.close();
  });

  it("adds an MCP tool call with a long JSON result on [mcp]", async () => {
    const session = await new FakeProvider().openSession(options);
    await session.send(UserInput.parse({ text: "triage [mcp]" }));
    const events = await collectUntil(session, isTurnEnd);
    const tools = events.flatMap((e) =>
      e.type === "item.completed" && e.item.kind === "tool_call" ? [e.item] : [],
    );
    expect(tools.map((t) => t.toolKind)).toEqual(["mcp", "command"]);
    const mcp = tools[0];
    if (mcp?.toolKind !== "mcp") throw new Error("expected an MCP tool call");
    expect(mcp).toMatchObject({ server: "codeden", tool: "triage_issue" });
    const text = mcp.output?.text ?? "";
    expect(text.length).toBeGreaterThan(1500);
    expect(text).not.toContain("\n");
    expect(JSON.parse(text)).toMatchObject({ issue: { number: 3 } });
    await session.close();
  });

  it("interrupts a running turn", async () => {
    const session = await new FakeProvider({ delayMs: 5 }).openSession(options);
    await session.send(UserInput.parse({ text: "a long reply with many words in it" }));
    await expect(session.send(UserInput.parse({ text: "again" }))).rejects.toThrow(/already/);
    const events = await collectUntil(session, isTurnEnd, (e) => {
      if (e.type === "item.delta") void session.interrupt();
    });
    expect(events.at(-1)).toMatchObject({ type: "turn.interrupted", reason: "user" });
    await session.close();
  });

  it("fails a turn on [fail] and ends the stream on close", async () => {
    const session = await new FakeProvider().openSession(options);
    await session.send(UserInput.parse({ text: "[fail]" }));
    const events = await collectUntil(session, isTurnEnd);
    expect(events.at(-1)?.type).toBe("turn.failed");
    await session.close();
    const rest: AgentEvent[] = [];
    for await (const e of session.events) rest.push(e);
    expect(rest).toEqual([]);
    await expect(session.send(UserInput.parse({ text: "x" }))).rejects.toThrow(/closed/);
  });
});

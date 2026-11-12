import type { AgentEvent, Item } from "@codeden/contracts";
import { beforeEach, describe, expect, it } from "vitest";
import { applyDelta, latestFollowups, runFailedInbox } from "../src/events/reducer/items";
import { FACTORY_STARTER } from "../src/services/factory/starter";
import { sampleSession } from "./helpers";
import { MemoryProjection } from "./support/memory-projection";

const T = "t-root";
const U = "u1";

let p: MemoryProjection;

beforeEach(() => {
  p = new MemoryProjection();
  p.addSession({ ...sampleSession, status: "starting", projectId: "p1" });
  p.apply(
    "s1",
    { type: "thread.started", thread: { id: T } },
    { type: "turn.started", threadId: T, turnId: U },
  );
});

const started = (item: Item, turnId = U, threadId = T): AgentEvent => ({
  type: "item.started",
  threadId,
  turnId,
  item,
});
const completed = (item: Item, turnId = U, threadId = T): AgentEvent => ({
  type: "item.completed",
  threadId,
  turnId,
  item,
});

const approval = (status: Item["status"], extra: object = {}): Item =>
  ({
    id: "a1",
    kind: "approval_request",
    status,
    requestId: "r1",
    action: "command",
    title: "Run rm -rf build",
    command: "rm -rf build",
    reason: "Deletes files",
    options: ["allow_once", "allow_session", "deny"],
    ...extra,
  }) as Item;

describe("threads and turns", () => {
  it("records the root thread on the session and marks it running", () => {
    expect(p.session().rootThreadId).toBe(T);
    expect(p.session().status).toBe("running");
    expect(p.turn(U)?.status).toBe("running");
  });

  it("creates subagent child threads without touching the session's root or status", () => {
    p.apply(
      "s1",
      started({
        id: "sub1",
        kind: "subagent",
        status: "in_progress",
        childThreadId: "t-child",
        agentType: "reviewer",
      }),
      {
        type: "thread.started",
        thread: { id: "t-child", parentThreadId: T, parentItemId: "sub1", agentType: "reviewer" },
      },
      { type: "turn.started", threadId: "t-child", turnId: "u-child" },
      completed(
        { id: "c1", kind: "assistant_message", status: "completed", text: "Looks fine" },
        "u-child",
        "t-child",
      ),
      { type: "turn.completed", threadId: "t-child", turnId: "u-child" },
    );
    const child = p.threads.get("s1/t-child");
    expect(child).toMatchObject({ parentThreadId: T, parentItemId: "sub1", agentType: "reviewer" });
    expect(p.session().rootThreadId).toBe(T);
    // The child turn completing must not make the parent session idle.
    expect(p.session().status).toBe("running");
    expect(p.item("c1")).toMatchObject({ threadId: "t-child", position: 0 });
    expect(p.item("sub1")).toMatchObject({ threadId: T, position: 0 });
  });

  it("sets idle on completion, failed (with an inbox item) on failure", () => {
    p.apply("s1", { type: "turn.completed", threadId: T, turnId: U, stopReason: "end_turn" });
    expect(p.session().status).toBe("idle");
    expect(p.turn(U)).toMatchObject({ status: "completed", error: null });

    p.apply(
      "s1",
      { type: "turn.started", threadId: T, turnId: "u2" },
      { type: "turn.failed", threadId: T, turnId: "u2", error: { message: "boom" } },
    );
    expect(p.session().status).toBe("failed");
    expect(p.turn("u2")).toMatchObject({ status: "failed", error: { message: "boom" } });
    const failed = [...p.inbox.values()].find((i) => i.kind === "run_failed");
    expect(failed).toMatchObject({
      status: "open",
      notify: "failure",
      body: "boom",
      projectId: "p1",
      sessionId: "s1",
    });
  });

  it("marks a factory session's failed run as factory activity, the factory handles it", () => {
    const ts = "2026-11-12T10:00:00.000Z";
    const factory = { ...sampleSession, startedBy: FACTORY_STARTER };
    expect(runFailedInbox(factory, "i1", "boom", null, ts).notify).toBe("factory");
    expect(runFailedInbox(sampleSession, "i2", "boom", null, ts).notify).toBe("failure");
  });

  it("distinguishes user interrupts from runner restarts", () => {
    p.apply("s1", { type: "turn.interrupted", threadId: T, turnId: U, reason: "user" });
    expect(p.session().status).toBe("idle");
    p.apply(
      "s1",
      { type: "turn.started", threadId: T, turnId: "u2" },
      { type: "turn.interrupted", threadId: T, turnId: "u2", reason: "runner_restart" },
    );
    expect(p.session().status).toBe("interrupted");
  });

  it("never revives a stopped session", () => {
    p.addSession({ ...p.session(), status: "stopped" });
    p.apply("s1", { type: "turn.started", threadId: T, turnId: "u9" });
    expect(p.session().status).toBe("stopped");
  });

  it("applies session.updated metadata", () => {
    p.apply("s1", { type: "session.updated", resumeToken: "r-1", model: "m", title: "Hi" });
    expect(p.session()).toMatchObject({ resumeToken: "r-1", model: "m", title: "Hi" });
  });
});

describe("items", () => {
  it("folds text deltas into an assistant message, and completion is authoritative", () => {
    p.apply(
      "s1",
      started({ id: "m1", kind: "assistant_message", status: "in_progress", text: "" }),
      {
        type: "item.delta",
        threadId: T,
        turnId: U,
        itemId: "m1",
        delta: { type: "text", text: "Hel" },
      },
      {
        type: "item.delta",
        threadId: T,
        turnId: U,
        itemId: "m1",
        delta: { type: "text", text: "lo" },
      },
    );
    const live = p.item("m1")?.item;
    expect(live?.kind === "assistant_message" && live.text).toBe("Hello");
    p.apply(
      "s1",
      completed({ id: "m1", kind: "assistant_message", status: "completed", text: "Hi!" }),
    );
    const done = p.item("m1");
    expect(done?.item.kind === "assistant_message" && done.item.text).toBe("Hi!");
    expect(done?.position).toBe(0);
  });

  it("folds tool output deltas and ignores deltas for unknown items", () => {
    p.apply(
      "s1",
      started({
        id: "c1",
        kind: "tool_call",
        toolKind: "command",
        status: "in_progress",
        toolName: "shell",
        command: "ls",
      }),
      {
        type: "item.delta",
        threadId: T,
        turnId: U,
        itemId: "c1",
        delta: { type: "tool_output", text: "a\n", stream: "stdout" },
      },
      {
        type: "item.delta",
        threadId: T,
        turnId: U,
        itemId: "c1",
        delta: { type: "tool_output", text: "b\n" },
      },
    );
    const item = p.item("c1")?.item;
    expect(item?.kind === "tool_call" && item.output?.text).toBe("a\nb\n");
    const none = p.apply("s1", {
      type: "item.delta",
      threadId: T,
      turnId: U,
      itemId: "ghost",
      delta: { type: "text", text: "x" },
    });
    expect(none).toEqual([]);
  });

  it("assigns increasing positions per thread", () => {
    p.apply(
      "s1",
      completed({ id: "x1", kind: "notice", status: "completed", level: "info", message: "a" }),
      completed({ id: "x2", kind: "notice", status: "completed", level: "info", message: "b" }),
    );
    expect([p.item("x1")?.position, p.item("x2")?.position]).toEqual([0, 1]);
  });

  it("applyDelta covers reasoning summaries and leaves mismatches unchanged", () => {
    const reasoning: Item = { id: "r", kind: "reasoning", status: "in_progress", text: "" };
    const next = applyDelta(reasoning, { type: "reasoning_summary", text: "sum" });
    expect(next.kind === "reasoning" && next.summary).toBe("sum");
    const notice: Item = {
      id: "n",
      kind: "notice",
      status: "completed",
      level: "info",
      message: "m",
    };
    expect(applyDelta(notice, { type: "text", text: "x" })).toBe(notice);
  });
});

describe("approvals and questions", () => {
  it("creates an inbox item and sets waiting, then resolves on completion", () => {
    p.apply("s1", started(approval("in_progress")));
    expect(p.session().status).toBe("waiting");
    const inbox = p.inbox.get("inbox:s1:a1");
    expect(inbox).toMatchObject({
      kind: "approval",
      status: "open",
      requestId: "r1",
      itemId: "a1",
      threadId: T,
      projectId: "p1",
      title: "Run rm -rf build",
    });
    expect(inbox?.body).toContain("$ rm -rf build");

    p.apply("s1", completed(approval("completed", { decision: "allow_once", decidedBy: "user" })));
    expect(p.session().status).toBe("running");
    expect(p.inbox.get("inbox:s1:a1")).toMatchObject({
      status: "resolved",
      resolution: { status: "completed", decision: "allow_once", decidedBy: "user" },
    });
  });

  it("surfaces approvals raised inside a subagent thread", () => {
    p.apply(
      "s1",
      { type: "thread.started", thread: { id: "t-child", parentThreadId: T, parentItemId: "sub" } },
      { type: "turn.started", threadId: "t-child", turnId: "u-child" },
      started(approval("in_progress"), "u-child", "t-child"),
    );
    expect(p.inbox.get("inbox:s1:a1")).toMatchObject({ threadId: "t-child", status: "open" });
    expect(p.session().status).toBe("waiting");
  });

  it("turns user questions into inbox items and records answers", () => {
    const question = (status: Item["status"], answers?: Record<string, string[]>): Item => ({
      id: "q1",
      kind: "user_question",
      status,
      requestId: "rq",
      questions: [
        {
          id: "db",
          question: "Which database?",
          options: [{ label: "SQLite" }],
          multiSelect: false,
          allowFreeText: true,
        },
      ],
      ...(answers ? { answers } : {}),
    });
    p.apply("s1", started(question("in_progress")));
    expect(p.inbox.get("inbox:s1:q1")).toMatchObject({
      kind: "question",
      title: "Which database?",
      status: "open",
    });
    p.apply("s1", completed(question("completed", { db: ["SQLite"] })));
    expect(p.inbox.get("inbox:s1:q1")).toMatchObject({
      status: "resolved",
      resolution: { answers: { db: ["SQLite"] } },
    });
  });

  it("dismisses requests left open when the turn ends", () => {
    p.apply("s1", started(approval("in_progress")), {
      type: "turn.interrupted",
      threadId: T,
      turnId: U,
      reason: "user",
    });
    expect(p.item("a1")?.item.status).toBe("cancelled");
    expect(p.inbox.get("inbox:s1:a1")?.status).toBe("dismissed");
    expect(p.session().status).toBe("idle");
  });

  it("does not recreate an inbox item when the request is updated", () => {
    p.apply("s1", started(approval("in_progress")));
    const mutations = p.apply("s1", {
      type: "item.updated",
      threadId: T,
      turnId: U,
      item: approval("in_progress"),
    });
    expect(mutations.some((m) => m.type === "inbox")).toBe(false);
  });
});

describe("follow-ups", () => {
  it("stores the followups item on its turn and finds the latest", () => {
    const followups = (id: string, prompt: string): Item => ({
      id,
      kind: "followups",
      status: "completed",
      source: "agent",
      suggestions: [{ prompt }],
    });
    p.apply("s1", completed(followups("f1", "Add tests")), {
      type: "turn.completed",
      threadId: T,
      turnId: U,
    });
    expect(p.item("f1")).toMatchObject({ turnId: U, threadId: T });
    p.apply(
      "s1",
      { type: "turn.started", threadId: T, turnId: "u2" },
      completed(followups("f2", "Open a PR"), "u2"),
    );
    const records = [...p.items.values()].sort((a, b) => a.position - b.position);
    expect(latestFollowups(records)?.suggestions[0]?.prompt).toBe("Open a PR");
  });
});

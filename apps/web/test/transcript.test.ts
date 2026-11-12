import type { AgentEvent } from "@codeden/contracts";
import { describe, expect, it } from "vitest";
import { MockWorld } from "@/lib/api/mock/world";
import {
  activeTurn,
  applyAgentEvent,
  emptyTranscript,
  threadItems,
  transcriptFromSnapshot,
} from "@/lib/transcript/reducer";
import {
  buildTimeline,
  finalAssistantText,
  latestFollowups,
  summarizeWork,
  type WorkEntry,
} from "@/lib/transcript/timeline";

const T = "t1";
const U = "u1";

function run(events: AgentEvent[]) {
  return events.reduce(
    (s, e, i) => applyAgentEvent(s, e, { seq: i + 1, ts: `2026-11-07T10:00:0${i}.000Z` }),
    emptyTranscript("s1"),
  );
}

describe("applyAgentEvent", () => {
  it("builds threads, turns and items and applies deltas", () => {
    const s = run([
      { type: "thread.started", thread: { id: T } },
      { type: "turn.started", threadId: T, turnId: U },
      {
        type: "item.started",
        threadId: T,
        turnId: U,
        item: { id: "a", kind: "assistant_message", status: "in_progress", text: "Hel" },
      },
      {
        type: "item.delta",
        threadId: T,
        turnId: U,
        itemId: "a",
        delta: { type: "text", text: "lo" },
      },
      {
        type: "item.started",
        threadId: T,
        turnId: U,
        item: {
          id: "c",
          kind: "tool_call",
          toolKind: "command",
          status: "in_progress",
          toolName: "Bash",
          command: "ls",
        },
      },
      {
        type: "item.delta",
        threadId: T,
        turnId: U,
        itemId: "c",
        delta: { type: "tool_output", text: "a.ts\n" },
      },
      {
        type: "item.delta",
        threadId: T,
        turnId: U,
        itemId: "c",
        delta: { type: "tool_output", text: "b.ts\n" },
      },
    ]);
    expect(s.rootThreadId).toBe(T);
    expect(s.seq).toBe(7);
    const items = threadItems(s, T).map((e) => e.item);
    expect(items).toHaveLength(2);
    expect(items[0]).toMatchObject({ kind: "assistant_message", text: "Hello" });
    expect(items[1]).toMatchObject({ output: { text: "a.ts\nb.ts\n" } });
    expect(activeTurn(s, T)?.id).toBe(U);
  });

  it("completion replaces accumulated state and ends the turn", () => {
    const s = run([
      { type: "turn.started", threadId: T, turnId: U },
      {
        type: "item.started",
        threadId: T,
        turnId: U,
        item: { id: "a", kind: "assistant_message", status: "in_progress", text: "dra" },
      },
      {
        type: "item.completed",
        threadId: T,
        turnId: U,
        item: { id: "a", kind: "assistant_message", status: "completed", text: "Final" },
      },
      { type: "turn.completed", threadId: T, turnId: U },
    ]);
    expect(threadItems(s, T)).toHaveLength(1);
    expect(finalAssistantText(s, U)).toBe("Final");
    expect(activeTurn(s, T)).toBeNull();
    expect(s.turns[U]?.status).toBe("completed");
  });

  it("does not mutate the previous state", () => {
    const before = run([{ type: "turn.started", threadId: T, turnId: U }]);
    const frozen = JSON.stringify(before);
    applyAgentEvent(before, {
      type: "item.started",
      threadId: T,
      turnId: U,
      item: { id: "x", kind: "notice", status: "completed", level: "info", message: "hi" },
    });
    expect(JSON.stringify(before)).toBe(frozen);
  });

  it("round-trips through a session snapshot", () => {
    const world = new MockWorld();
    const snap = world.sessionSnapshot("s-checkout");
    const t = transcriptFromSnapshot(snap);
    expect(t.rootThreadId).toBe("t-checkout");
    expect(Object.keys(t.threads)).toContain("t-checkout-review");
    expect(threadItems(t, "t-checkout").length).toBe(
      threadItems(world.transcript("s-checkout"), "t-checkout").length,
    );
  });
});

describe("buildTimeline", () => {
  const world = new MockWorld();
  const t = world.transcript("s-checkout");
  const rows = buildTimeline(t, "t-checkout");

  it("groups consecutive tool calls into work groups and keeps cards separate", () => {
    const types = rows.map((r) => r.type);
    expect(types[0]).toBe("user");
    expect(types).toContain("work");
    const cards = rows.flatMap((r) => (r.type === "card" ? [r.item.kind] : []));
    expect(cards).toEqual(
      expect.arrayContaining(["plan", "todo_list", "subagent", "approval_request", "notice"]),
    );
    // Follow-ups never become rows.
    expect(rows.some((r) => r.type === "card" && r.item.kind === "followups")).toBe(false);
  });

  it("adds a footer to finished turns and a working row to the running one", () => {
    const end = rows.find((r) => r.type === "turn-end");
    expect(end?.type === "turn-end" && end.filesChanged).toBe(2);
    expect(rows.at(-1)?.type).toBe("working");
  });

  it("keeps a turn whole when an earlier turn's follow-ups arrive during it", () => {
    const say = (turnId: string, id: string): AgentEvent => ({
      type: "item.completed",
      threadId: T,
      turnId,
      item: { id, kind: "assistant_message", status: "completed", text: id },
    });
    const s = run([
      { type: "turn.started", threadId: T, turnId: "u1" },
      say("u1", "a"),
      { type: "turn.completed", threadId: T, turnId: "u1" },
      { type: "turn.started", threadId: T, turnId: "u2" },
      say("u2", "b"),
      // Suggestions for u1, written by the server once u2 had begun.
      {
        type: "item.completed",
        threadId: T,
        turnId: "u1",
        item: {
          id: "f1",
          kind: "followups",
          status: "completed",
          source: "utility",
          suggestions: [],
        },
      },
      say("u2", "c"),
    ]);
    const keys = buildTimeline(s, T).map((r) => r.key);
    expect(keys).toEqual(["a", "end:u1", "b", "c", "working:u2"]);
  });

  it("marks the thread's latest turn and keeps each turn's fork point", () => {
    const say = (turnId: string): AgentEvent => ({
      type: "item.completed",
      threadId: T,
      turnId,
      item: { id: `m-${turnId}`, kind: "assistant_message", status: "completed", text: turnId },
    });
    const s = run([
      { type: "turn.started", threadId: T, turnId: "u1" },
      say("u1"),
      { type: "turn.completed", threadId: T, turnId: "u1", forkPoint: "fp-1" },
      { type: "turn.started", threadId: T, turnId: "u2" },
      say("u2"),
      { type: "turn.interrupted", threadId: T, turnId: "u2", reason: "user" },
    ]);
    const ends = buildTimeline(s, T).flatMap((r) =>
      r.type === "turn-end" ? [[r.turn.id, r.latest, r.turn.forkPoint]] : [],
    );
    expect(ends).toEqual([
      ["u1", false, "fp-1"],
      ["u2", true, null],
    ]);
  });

  it("only offers follow-ups when the last turn completed", () => {
    expect(latestFollowups(t, "t-checkout")).toBeNull();
    const a11y = world.transcript("s-a11y");
    expect(latestFollowups(a11y, "t-a11y")?.map((f) => f.label)).toContain("Review the PR");
  });
});

describe("summarizeWork", () => {
  const cmd = (id: string): WorkEntry => ({
    id,
    kind: "tool_call",
    toolKind: "command",
    status: "completed",
    toolName: "Bash",
    command: "x",
  });
  const read = (id: string): WorkEntry => ({
    id,
    kind: "tool_call",
    toolKind: "file_read",
    status: "completed",
    toolName: "Read",
    path: "a",
  });

  it("summarises the two most important kinds", () => {
    expect(summarizeWork([cmd("1"), cmd("2"), read("3")])).toBe("Ran 2 commands and read 1 file");
  });
  it("counts the rest", () => {
    const edit: WorkEntry = {
      id: "e",
      kind: "tool_call",
      toolKind: "file_edit",
      status: "completed",
      toolName: "Edit",
      changes: [
        { path: "a", change: "modify" },
        { path: "b", change: "add" },
      ],
    };
    const search: WorkEntry = {
      id: "s",
      kind: "tool_call",
      toolKind: "search",
      status: "completed",
      toolName: "Grep",
      query: "q",
    };
    expect(summarizeWork([edit, cmd("1"), search, read("r")])).toBe(
      "Edited 2 files, ran 1 command and 2 more",
    );
  });
  it("handles reasoning only", () => {
    expect(summarizeWork([{ id: "r", kind: "reasoning", status: "completed", text: "" }])).toBe(
      "Thought",
    );
  });
});

import type { AgentEvent, ItemDelta, RunnerEvent } from "@codeden/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DeltaBatcher } from "../src/delta-batcher";

const at = { threadId: "t", turnId: "u" };
const agent = (event: AgentEvent, sessionId = "s1"): RunnerEvent => ({
  kind: "agent",
  sessionId,
  event,
});
const delta = (itemId: string, d: ItemDelta, sessionId = "s1") =>
  agent({ type: "item.delta", ...at, itemId, delta: d }, sessionId);
const text = (itemId: string, t: string, sessionId = "s1") =>
  delta(itemId, { type: "text", text: t }, sessionId);
const started = agent({
  type: "item.started",
  ...at,
  item: { id: "a", kind: "assistant_message", text: "", status: "in_progress" },
});
const completed = agent({
  type: "item.completed",
  ...at,
  item: { id: "a", kind: "assistant_message", text: "abc", status: "completed" },
});
const checkpoint: RunnerEvent = {
  kind: "checkpoint.created",
  sessionId: "s1",
  index: 1,
  ref: "refs/codeden/checkpoints/s1/1",
  commit: "abc123",
};

let out: RunnerEvent[];
let batcher: DeltaBatcher;

beforeEach(() => {
  vi.useFakeTimers();
  out = [];
  batcher = new DeltaBatcher((e) => out.push(e), { windowMs: 50, maxChars: 10 });
});
afterEach(() => {
  vi.useRealTimers();
});

describe("DeltaBatcher", () => {
  it("merges runs of deltas that extend one item the same way, in order", () => {
    batcher.push(started);
    for (const t of ["a", "b", "c"]) batcher.push(text("a", t));
    expect(out).toEqual([started]); // waiting for more
    batcher.push(delta("a", { type: "reasoning_summary", text: "r" }));
    batcher.push(delta("b", { type: "tool_output", text: "1", stream: "stdout" }));
    batcher.push(delta("b", { type: "tool_output", text: "2", stream: "stdout" }));
    batcher.push(delta("b", { type: "tool_output", text: "3", stream: "stderr" }));
    batcher.push(delta("c", { type: "tool_input", partialJson: '{"a":' }));
    batcher.push(delta("c", { type: "tool_input", partialJson: "1}" }));
    batcher.push(text("d", "x"));
    batcher.push(completed); // any other event passes the batch on first
    expect(out).toEqual([
      started,
      text("a", "abc"),
      delta("a", { type: "reasoning_summary", text: "r" }),
      delta("b", { type: "tool_output", text: "12", stream: "stdout" }),
      delta("b", { type: "tool_output", text: "3", stream: "stderr" }),
      delta("c", { type: "tool_input", partialJson: '{"a":1}' }),
      text("d", "x"),
      completed,
    ]);
  });

  it("passes a batch on after the window", () => {
    batcher.push(text("a", "a"));
    vi.advanceTimersByTime(30);
    batcher.push(text("a", "b")); // the window runs from the batch's first delta
    vi.advanceTimersByTime(19);
    expect(out).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(out).toEqual([text("a", "ab")]);
    batcher.push(text("a", "c"));
    vi.advanceTimersByTime(50);
    expect(out).toEqual([text("a", "ab"), text("a", "c")]);
  });

  it("passes a batch on once it holds maxChars", () => {
    batcher.push(text("a", "12345"));
    batcher.push(text("a", "67890"));
    expect(out).toEqual([text("a", "1234567890")]);
    batcher.push(text("a", "x"));
    expect(out).toHaveLength(1);
    batcher.flush();
    expect(out).toEqual([text("a", "1234567890"), text("a", "x")]);
    vi.runAllTimers();
    expect(out).toHaveLength(2); // nothing left to pass on twice
  });

  it("journals a session's batch before any later event of that session, whoever emits it", () => {
    batcher.push(text("a", "a"));
    vi.advanceTimersByTime(20);
    batcher.push(text("a", "b"));
    batcher.push(text("x", "other", "s2"));
    // A manual checkpoint (the `git.checkpoint` command) lands inside the batching window.
    batcher.push(checkpoint);
    expect(out).toEqual([text("a", "ab"), checkpoint]);
    // Another session's batch keeps waiting; an event of no session passes every batch on.
    const exited: RunnerEvent = { kind: "pty.exited", ptyId: "p1", exitCode: 0 };
    batcher.push(text("a", "c"));
    batcher.push(exited);
    expect(out).toEqual([
      text("a", "ab"),
      checkpoint,
      text("x", "other", "s2"),
      text("a", "c"),
      exited,
    ]);
    vi.runAllTimers();
    expect(out).toHaveLength(5);
  });
});

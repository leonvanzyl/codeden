import type { AgentEvent, Item } from "@codeden/contracts";
import { beforeEach, describe, expect, it } from "vitest";
import { accumulateUsage, mergeLatestUsage } from "../src/events/reducer/usage";
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
const _completed = (item: Item, turnId = U, threadId = T): AgentEvent => ({
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

describe("usage", () => {
  it("accumulates turn usage, replacing a turn's earlier report", () => {
    p.apply("s1", {
      type: "usage.updated",
      threadId: T,
      turnId: U,
      usage: { inputTokens: 10, outputTokens: 5, costUsd: 0.1 },
    });
    p.apply("s1", {
      type: "usage.updated",
      threadId: T,
      turnId: U,
      usage: { inputTokens: 20, outputTokens: 8, costUsd: 0.2, contextTokens: 30 },
    });
    expect(p.usage()).toEqual({
      inputTokens: 20,
      outputTokens: 8,
      costUsd: 0.2,
      contextTokens: 30,
    });
    expect(p.turn(U)?.usage).toMatchObject({ inputTokens: 20 });

    p.apply(
      "s1",
      { type: "turn.completed", threadId: T, turnId: U },
      { type: "turn.started", threadId: T, turnId: "u2" },
      { type: "usage.updated", threadId: T, turnId: "u2", usage: { inputTokens: 1, costUsd: 0.1 } },
    );
    expect(p.usage()).toMatchObject({ inputTokens: 21, outputTokens: 8, costUsd: 0.3 });
  });

  it("marks usage-only changes so no session event is derived", () => {
    const m = p.apply("s1", {
      type: "usage.updated",
      threadId: T,
      turnId: U,
      usage: { inputTokens: 1 },
    });
    expect(m).toEqual([
      expect.objectContaining({ type: "turn" }),
      expect.objectContaining({ type: "session", sessionChanged: false }),
    ]);
  });

  it("takes only context and rate limits from session-level reports", () => {
    expect(
      mergeLatestUsage(
        { inputTokens: 5 },
        { inputTokens: 99, rateLimits: [{ id: "5h", status: "warning" }] },
      ),
    ).toEqual({ inputTokens: 5, rateLimits: [{ id: "5h", status: "warning" }] });
    expect(accumulateUsage(null, null, { outputTokens: 3 })).toEqual({ outputTokens: 3 });
    expect(
      accumulateUsage({ costUsd: 0.3 }, { costUsd: 0.1 }, { costUsd: 0.2 }).costUsd,
    ).toBeCloseTo(0.4);
  });
});

describe("process lifecycle", () => {
  it("fails the session on a crash and dismisses open requests", () => {
    p.apply("s1", started(approval("in_progress")));
    p.applyProcess(
      {
        kind: "session.process",
        sessionId: "s1",
        state: "crashed",
        error: { message: "segfault" },
      },
      7,
    );
    expect(p.session().status).toBe("failed");
    expect(p.inbox.get("inbox:s1:a1")?.status).toBe("dismissed");
    expect(p.inbox.get("inbox:s1:process:7")).toMatchObject({
      kind: "run_failed",
      body: "segfault",
    });
  });

  it("keeps a refused open with the session (#269)", () => {
    const error = {
      code: "open_failed",
      message: "Gemini CLI 0.36.0 is too old (needs 0.68.0+)",
      kind: "setup" as const,
    };
    // A session that never opened: no thread yet.
    const fresh = new MemoryProjection();
    fresh.addSession({ ...sampleSession, status: "starting", projectId: "p1" });
    fresh.applyProcess({ kind: "session.process", sessionId: "s1", state: "crashed", error }, 3);
    expect(fresh.session()).toMatchObject({ status: "failed", startError: error });
    expect(fresh.inbox.get("inbox:s1:process:3")).toMatchObject({
      kind: "run_failed",
      body: error.message,
    });
  });

  it("stops the session on a normal exit and ignores start/ready", () => {
    expect(p.applyProcess({ kind: "session.process", sessionId: "s1", state: "ready" }, 1)).toEqual(
      [],
    );
    p.applyProcess({ kind: "session.process", sessionId: "s1", state: "exited", exitCode: 0 }, 2);
    expect(p.session()).toMatchObject({ status: "stopped" });
    expect(p.session().endedAt).not.toBeNull();
  });
});

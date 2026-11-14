import { describe, expect, it } from "vitest";
import {
  DiffResult,
  DiffScope,
  EditQueuedMessageRequest,
  EventEnvelope,
  QueuedMessage,
  QueuedMessageList,
  RestoreFilesRequest,
  RunnerCommand,
  RunnerEvent,
  SendQueuedNowResponse,
  SessionResult,
  TerminalClientMessage,
  TerminalQuery,
} from "../src";

const ts = "2026-11-07T10:00:00.000Z";
const roundTrip = <T>(schema: { parse: (v: unknown) => T }, value: T) =>
  expect(schema.parse(JSON.parse(JSON.stringify(value)))).toEqual(value);

describe("workbench contracts", () => {
  it("round-trips the new domain events", () => {
    const events = [
      { type: "runner.draining", payload: { runnerId: "r", reason: "upgrade" } },
      {
        type: "session.setup",
        payload: {
          sessionId: "s",
          step: { command: "pnpm i", status: "running", output: "ok", updatedAt: ts },
        },
      },
      {
        type: "checkpoint.created",
        payload: {
          checkpoint: {
            sessionId: "s",
            index: 1,
            ref: "refs/codeden/checkpoints/s/1",
            commit: "abc",
            turnId: "u1",
            createdAt: ts,
          },
        },
      },
      {
        type: "message.queued",
        payload: {
          message: {
            id: "m",
            sessionId: "s",
            input: { text: "hi", attachments: [] },
            from: "pm",
            createdAt: ts,
          },
        },
      },
      { type: "message.dequeued", payload: { sessionId: "s", messageId: "m", reason: "sent" } },
      { type: "message.dequeued", payload: { sessionId: "s", messageId: "m", reason: "deleted" } },
      {
        type: "message.edited",
        payload: { sessionId: "s", messageId: "m", text: "hello instead", at: ts },
      },
      { type: "pty.exited", payload: { ptyId: "p", exitCode: null } },
    ];
    for (const e of events)
      roundTrip(EventEnvelope, { seq: 1, sessionId: null, ts, ...e } as never);
  });

  it("still parses queued messages written before senders were recorded", () => {
    const old = {
      seq: 1,
      sessionId: "s",
      ts,
      type: "message.queued",
      payload: { message: { id: "m", sessionId: "s", input: { text: "hi" }, createdAt: ts } },
    };
    const parsed = EventEnvelope.parse(old);
    expect(parsed.type === "message.queued" && parsed.payload.message).toEqual({
      id: "m",
      sessionId: "s",
      input: { text: "hi", attachments: [] },
      from: "user",
      createdAt: ts,
    });
    const dropped = {
      ...old,
      type: "message.dequeued",
      payload: { sessionId: "s", messageId: "m", reason: "dropped" },
    };
    expect(EventEnvelope.parse(dropped)).toEqual(dropped);
  });

  it("round-trips the queue API shapes", () => {
    const message = {
      id: "m",
      sessionId: "s",
      input: { text: "hi", attachments: [] },
      from: "user" as const,
      createdAt: ts,
    };
    roundTrip(QueuedMessageList, {
      messages: [message, { ...message, id: "n", from: "orchestrator" }],
    });
    roundTrip(EditQueuedMessageRequest, { text: "hello instead" });
    roundTrip(SendQueuedNowResponse, { status: "steered" });
    // Send-now only ever steers a running turn.
    expect(SendQueuedNowResponse.safeParse({ status: "sent" }).success).toBe(false);
    expect(QueuedMessage.safeParse({ ...message, from: "someone" }).success).toBe(false);
  });

  it("carries runner exit reasons and the oneShot command", () => {
    roundTrip(RunnerEvent, {
      kind: "session.process",
      sessionId: "s",
      state: "exited",
      reason: "runner_exit",
      interruptedTurn: true,
    });
    roundTrip(RunnerCommand, { name: "provider.oneShot", providerId: "claude", prompt: "hi" });
  });

  it("validates diffs, restores, results and terminal messages", () => {
    roundTrip(DiffScope, { kind: "turn", turnId: "u1" });
    roundTrip(DiffScope, { kind: "compare", sessionId: "s2" });
    expect(DiffScope.safeParse({ kind: "compare" }).success).toBe(false);
    roundTrip(DiffResult, {
      scope: { kind: "session" },
      files: [{ path: "a.txt", change: "add", additions: 1, deletions: 0, patch: "+hi" }],
      turns: [{ id: "u1", index: 1, label: "Turn 1", at: ts }],
    });
    roundTrip(DiffResult, {
      scope: { kind: "compare", sessionId: "s2" },
      files: [],
      turns: [],
      against: { sessionId: "s2", index: 3, at: ts },
    });
    expect(
      DiffResult.safeParse({
        scope: { kind: "compare", sessionId: "s2" },
        files: [],
        turns: [],
        against: { sessionId: "s2", index: -1, at: ts },
      }).success,
    ).toBe(false);
    expect(RestoreFilesRequest.safeParse({}).success).toBe(false);
    expect(RestoreFilesRequest.safeParse({ turnId: "u1", index: 1 }).success).toBe(false);
    roundTrip(RestoreFilesRequest, { index: 0, paths: ["a.txt"] });
    roundTrip(SessionResult, { outcome: "success", summary: "Done", at: ts });
    roundTrip(TerminalClientMessage, { type: "resize", cols: 80, rows: 24 });
    expect(TerminalQuery.parse({ cols: "100" })).toEqual({ cols: 100, rows: 30 });
  });
});

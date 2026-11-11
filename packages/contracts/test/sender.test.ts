import { describe, expect, it } from "vitest";
import {
  EventEnvelope,
  Item,
  MessageSender,
  messageFrom,
  QueueSender,
  RunnerCommand,
  SENDER_LINES,
  StartSessionRequest,
  splitSender,
  UserInput,
} from "../src";

const ts = "2026-11-08T10:00:00.000Z";
const roundTrip = <T>(schema: { parse: (v: unknown) => T }, value: unknown): T => {
  const first = schema.parse(value);
  expect(schema.parse(JSON.parse(JSON.stringify(first)))).toEqual(first);
  return first;
};

describe("message senders", () => {
  it("round-trips the sender on user input, user message items and the runner send", () => {
    const input = roundTrip(UserInput, { text: "Ship it", attachments: [], from: "pm" });
    expect(input.from).toBe("pm");
    const item = roundTrip(Item, {
      id: "u1",
      kind: "user_message",
      status: "completed",
      input: messageFrom("orchestrator", "Ship it"),
    });
    expect(item.kind === "user_message" && item.input.from).toBe("orchestrator");
    const command = roundTrip(RunnerCommand, {
      name: "session.send",
      sessionId: "s1",
      input: messageFrom("pm", "Ship it"),
    });
    expect(command.name === "session.send" && command.input.from).toBe("pm");
    const envelope = roundTrip(EventEnvelope, {
      seq: 1,
      sessionId: "s1",
      ts,
      type: "agent.item.completed",
      payload: { type: "item.completed", threadId: "t1", turnId: "u1", item },
    });
    expect(envelope.type).toBe("agent.item.completed");
  });

  it("round-trips the sender of a session's opening brief", () => {
    const req = roundTrip(StartSessionRequest, {
      projectId: "p1",
      purpose: "Factory (bug): Fix the transcript",
      input: { text: "## Goal\n\nFix **it**", from: "factory" },
    });
    expect(req.input?.from).toBe("factory");
    for (const from of ["factory", "automation", "codeden"] as const) {
      const item = roundTrip(Item, {
        id: "u1",
        kind: "user_message",
        status: "completed",
        input: { text: "Brief", attachments: [], from },
      });
      expect(item.kind === "user_message" && item.input.from).toBe(from);
    }
  });

  it("still loads user messages stored before senders were recorded", () => {
    const old = Item.parse({
      id: "u1",
      kind: "user_message",
      status: "completed",
      input: { text: "Message from your project manager:\nShip it" },
    });
    expect(old.kind === "user_message" && old.input).toEqual({
      text: "Message from your project manager:\nShip it",
      attachments: [],
    });
  });

  it("rejects an unknown sender", () => {
    expect(UserInput.safeParse({ text: "hi", from: "stranger" }).success).toBe(false);
  });

  it("keeps the queue's senders the same as the message senders", () => {
    expect(QueueSender.options).toEqual(MessageSender.options);
  });

  it("names the sender for the agent and records it", () => {
    expect(messageFrom("pm", "Do **this**")).toEqual({
      text: "Message from your project manager:\nDo **this**",
      attachments: [],
      from: "pm",
    });
    expect(messageFrom("orchestrator", "Hi").text.split("\n")[0]).toBe(SENDER_LINES.orchestrator);
  });

  it("splits a recorded sender's line off the text", () => {
    const { text, from } = messageFrom("pm", "1. one\n2. two");
    expect(splitSender(text, from)).toEqual({ from: "pm", text: "1. one\n2. two" });
    expect(splitSender("No line here", "orchestrator")).toEqual({
      from: "orchestrator",
      text: "No line here",
    });
  });

  it("recognises the sender line on messages without a recorded sender", () => {
    expect(splitSender("Message from the orchestrator:\nHello")).toEqual({
      from: "orchestrator",
      text: "Hello",
    });
    expect(splitSender("Message from your project manager:\r\nHello")).toEqual({
      from: "pm",
      text: "Hello",
    });
    expect(splitSender("Message from your project manager:")).toEqual({ from: "pm", text: "" });
  });

  it("leaves the user's own text alone", () => {
    expect(splitSender("hello")).toEqual({ from: "user", text: "hello" });
    // Only a whole first line counts, and a recorded sender always wins.
    expect(splitSender("Message from the orchestrator: hi")).toEqual({
      from: "user",
      text: "Message from the orchestrator: hi",
    });
    expect(splitSender("Message from the orchestrator:\nhi", "user")).toEqual({
      from: "user",
      text: "Message from the orchestrator:\nhi",
    });
    expect(splitSender("Message from the orchestrator:\nhi", "pm")).toEqual({
      from: "pm",
      text: "Message from the orchestrator:\nhi",
    });
  });
});

import { describe, expect, it } from "vitest";
import { AgentEvent, EventEnvelope, SlashCommandList } from "../src";

const roundTrip = <T>(schema: { parse: (v: unknown) => T }, value: T) =>
  expect(schema.parse(JSON.parse(JSON.stringify(value)))).toEqual(value);

describe("slash commands", () => {
  it("round-trips the composer's command list", () => {
    roundTrip(SlashCommandList, [
      { name: "compact", description: "Summarize the conversation", kind: "command" },
      {
        name: "fix-issue",
        description: "Fix a GitHub issue",
        kind: "command",
        provider: "claude",
        argumentHint: "[issue-number] [priority]",
      },
      { name: "deploy", description: "", kind: "skill", provider: "codex" },
    ]);
    expect(() => SlashCommandList.parse([{ name: "", description: "", kind: "skill" }])).toThrow();
    expect(() => SlashCommandList.parse([{ name: "x", description: "", kind: "macro" }])).toThrow();
  });

  it("round-trips the commands a provider reports on session.updated", () => {
    const event = {
      type: "session.updated" as const,
      commands: [
        { name: "compact", description: "Free up context", builtin: true },
        { name: "plugin:review", description: "", argumentHint: "<pr>" },
      ],
    };
    roundTrip(AgentEvent, event);
    roundTrip(EventEnvelope, {
      seq: 3,
      sessionId: "s1",
      type: "agent.session.updated",
      payload: event,
      ts: "2026-11-12T10:00:00.000Z",
    });
  });
});

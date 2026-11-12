import { AgentEvent, oneLineDescription as oneLine } from "@codeden/contracts";
import { describe, expect, it } from "vitest";
import { toProviderCommands } from "../src/claude/commands";
import { ClaudeEventMapper } from "../src/claude/mapper";

describe("Claude `/` commands", () => {
  it("keeps what /<name> runs, with one-line descriptions, minus internal entries", () => {
    const long = `${"word ".repeat(80)}\nsecond line`;
    expect(
      toProviderCommands([
        { name: "compact", description: "Free up context", argumentHint: "", builtin: true },
        { name: "__remote-workflow", description: "internal", argumentHint: "" },
        { name: "fix-issue", description: long, argumentHint: "[issue-number]" },
        { name: "compact", description: "a duplicate", argumentHint: "" },
        { name: "", description: "nameless" },
        "not a command",
      ]),
    ).toEqual([
      { name: "compact", description: "Free up context", builtin: true },
      { name: "fix-issue", description: oneLine(long), argumentHint: "[issue-number]" },
    ]);
    expect(oneLine(long).length).toBe(200);
    expect(oneLine(long).endsWith("…")).toBe(true);
    expect(toProviderCommands(undefined)).toEqual([]);
  });

  it("reports the list on session.updated, and again only when it changes", () => {
    const events: AgentEvent[] = [];
    const mapper = new ClaudeEventMapper({
      sessionId: "s1",
      cwd: "/work",
      emit: (e) => events.push(AgentEvent.parse(e)),
    });
    const list = [{ name: "compact", description: "Free up context", builtin: true }];
    mapper.reportCommands(list);
    mapper.reportCommands(list);
    mapper.handle({ type: "system", subtype: "commands_changed", commands: list });
    expect(events).toEqual([{ type: "session.updated", commands: list }]);

    const more = [...list, { name: "deploy", description: "Ship it" }];
    mapper.handle({ type: "system", subtype: "commands_changed", commands: more });
    expect(events.at(-1)).toEqual({ type: "session.updated", commands: more });
  });
});

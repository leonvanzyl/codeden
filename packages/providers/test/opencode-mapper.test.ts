import type { AgentEvent } from "@codeden/contracts";
import { describe, expect, it } from "vitest";
import { OpenCodeEventMapper } from "../src/opencode/mapper";
import type { OcEvent } from "../src/opencode/protocol";

const SID = "ses_1";

function mapper() {
  const events: AgentEvent[] = [];
  const m = new OpenCodeEventMapper({
    sessionId: "s1",
    emit: (e) => events.push(e),
    tools: { cwd: "/repo", mcpServers: [] },
  });
  m.rootSession = SID;
  return { m, events };
}

/** One execution of the root session that says `text`. */
function execution(m: OpenCodeEventMapper, msg: string, text: string): void {
  const step = { sessionID: SID, assistantMessageID: msg, ordinal: 0 };
  const events: OcEvent[] = [
    { type: "session.execution.started", data: { sessionID: SID } },
    { type: "session.text.started", data: step },
    { type: "session.text.delta", data: { ...step, delta: text } },
    { type: "session.text.ended", data: { ...step, text } },
    { type: "session.execution.succeeded", data: { sessionID: SID } },
  ];
  for (const event of events) m.handle(event);
}

const turnIds = (events: AgentEvent[]) =>
  events.flatMap((e) => (e.type === "turn.started" ? [e.turnId] : []));
const replies = (events: AgentEvent[]) =>
  events.flatMap((e) =>
    e.type === "item.completed" && e.item.kind === "assistant_message"
      ? [{ turnId: e.turnId, text: e.item.text }]
      : [],
  );

describe("OpenCode event mapper", () => {
  // send() sets pendingTurnId before the prompt POST and calls beginTurn once it returns;
  // OpenCode's execution event can come before or after that.
  for (const order of ["prompt answered first", "execution event first"] as const) {
    it(`opens a new turn for an execution started without a send (${order})`, () => {
      const { m, events } = mapper();
      m.pendingTurnId = "turn-a";
      if (order === "prompt answered first") m.beginTurn("turn-a");
      execution(m, "msg-1", "First reply.");
      if (order === "execution event first") m.beginTurn("turn-a");
      expect(m.pendingTurnId).toBeUndefined();

      // A late steer or a queued prompt: OpenCode runs it with no send() from CodeDen.
      execution(m, "msg-2", "Late reply.");
      const [first, late] = turnIds(events);
      expect(first).toBe("turn-a");
      expect(late).toBeDefined();
      expect(late).not.toBe("turn-a");
      expect(replies(events)).toEqual([
        { turnId: "turn-a", text: "First reply." },
        { turnId: late, text: "Late reply." },
      ]);
      expect(events.filter((e) => e.type === "turn.completed")).toHaveLength(2);
    });
  }

  it("never reopens an ended turn from a stale pending id", () => {
    const { m, events } = mapper();
    m.beginTurn("turn-a");
    m.endTurn({ type: "completed" });
    m.pendingTurnId = "turn-a";
    execution(m, "msg-1", "Reply.");
    const late = turnIds(events)[1];
    expect(late).toBeDefined();
    expect(late).not.toBe("turn-a");
    expect(replies(events)).toEqual([{ turnId: late, text: "Reply." }]);
  });
});

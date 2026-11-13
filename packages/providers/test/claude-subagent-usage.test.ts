import path from "node:path";
import type { Query } from "@anthropic-ai/claude-agent-sdk";
import { AgentEvent, type ItemOf, type SessionOptions } from "@codeden/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { ClaudeEventMapper } from "../src/claude/mapper";
import { ClaudeSession } from "../src/claude/session";
import { SubagentUsage } from "../src/claude/subagent-usage";

/** Usage as a streamed frame carries it: output is the count when the call started. */
const usage = (input: number, read: number, write: number, output: number, thinking?: number) => ({
  input_tokens: input,
  cache_read_input_tokens: read,
  cache_creation_input_tokens: write,
  output_tokens: output,
  ...(thinking !== undefined ? { output_tokens_details: { thinking_tokens: thinking } } : {}),
});

const frame = (
  id: string,
  model: string,
  u: object,
  parent: string | null,
  content: object[] = [{ type: "text", text: "..." }],
  agentId?: string,
) => ({
  type: "assistant",
  parent_tool_use_id: parent,
  ...(agentId ? { agent_id: agentId } : {}),
  message: { id, model, content, usage: u },
});

const transcriptEntry = (id: string, model: string, u: object) => ({
  type: "assistant",
  message: { id, model, stop_reason: "end_turn", usage: u },
});

const agentCall = (id: string, description: string) => ({
  type: "tool_use",
  id,
  name: "Agent",
  input: { description, prompt: "p", subagent_type: "Explore" },
});

const agentResult = (id: string, agentId: string, text = "Found it") => ({
  type: "user",
  parent_tool_use_id: null,
  message: {
    role: "user",
    content: [{ type: "tool_result", tool_use_id: id, content: text, is_error: false }],
  },
  tool_use_result: {
    status: "completed",
    agentId,
    totalTokens: 1234,
    totalToolUseCount: 1,
    totalDurationMs: 900,
  },
});

const subagentCards = (events: AgentEvent[], id: string) =>
  events.flatMap((e) =>
    e.type === "item.completed" && e.item.kind === "subagent" && e.item.id === id ? [e.item] : [],
  );

describe("SubagentUsage", () => {
  it("counts frames of one call once and sums calls per model", () => {
    const u = new SubagentUsage();
    expect(u.summary()).toBeUndefined();
    u.addFrame({ id: "m1", model: "claude-haiku-5-5", usage: usage(2, 0, 15_000, 1) });
    u.addFrame({ id: "m1", model: "claude-haiku-5-5", usage: usage(2, 0, 15_000, 3) });
    u.addFrame({ id: "m2", model: "claude-opus-5-5", usage: usage(1, 15_000, 400, 9, 4) });
    u.addFrame({ id: "m3", model: "claude-haiku-5-5", usage: usage(3, 15_000, 200, 5) });
    // Claude Code's placeholder replies carry no tokens and no real model.
    u.addFrame({ id: "m4", model: "<synthetic>", usage: usage(0, 0, 0, 0) });
    u.addFrame({ id: "m5", model: "claude-haiku-5-5" });
    expect(u.summary()).toEqual([
      {
        model: "claude-haiku-5-5",
        inputTokens: 5,
        outputTokens: 8,
        cacheReadTokens: 15_000,
        cacheWriteTokens: 15_200,
      },
      {
        model: "claude-opus-5-5",
        inputTokens: 1,
        outputTokens: 9,
        cacheReadTokens: 15_000,
        cacheWriteTokens: 400,
        reasoningTokens: 4,
      },
    ]);
  });

  it("takes final figures from the transcript for the calls it streamed, and only those", () => {
    const u = new SubagentUsage();
    u.addFrame({ id: "m1", model: "claude-haiku-5-5", usage: usage(2, 0, 15_000, 1) });
    u.addFrame({ id: "m2", model: "claude-haiku-5-5", usage: usage(2, 15_000, 300, 1) });
    const transcript = [
      { type: "user", message: { role: "user", content: "go" } },
      // An earlier run of a resumed subagent: not this card's work.
      transcriptEntry("m0", "claude-haiku-5-5", usage(9, 9, 9, 999)),
      transcriptEntry("m1", "claude-haiku-5-5", usage(2, 0, 15_000, 140, 20)),
      transcriptEntry("m1", "claude-haiku-5-5", usage(2, 0, 15_000, 140, 20)),
    ];
    expect(u.applyTranscript(transcript)).toBe(true);
    // m2 is not in the transcript yet: its streamed figures stay.
    expect(u.summary()).toEqual([
      {
        model: "claude-haiku-5-5",
        inputTokens: 4,
        outputTokens: 141,
        cacheReadTokens: 15_000,
        cacheWriteTokens: 15_300,
        reasoningTokens: 20,
      },
    ]);
    expect(u.applyTranscript(transcript)).toBe(false);
    expect(u.applyTranscript([])).toBe(false);
  });
});

describe("ClaudeEventMapper subagent usage", () => {
  function setup() {
    const events: AgentEvent[] = [];
    const finished: [string, string][] = [];
    let n = 0;
    const mapper = new ClaudeEventMapper({
      sessionId: "s1",
      cwd: "/work/repo",
      emit: (e) => events.push(AgentEvent.parse(e)),
      newId: () => `id${++n}`,
      onSubagentFinished: (toolUseId, agentId) => finished.push([toolUseId, agentId]),
    });
    mapper.start();
    mapper.beginTurn();
    return { mapper, events, finished };
  }

  it("puts each run's own calls on its card and takes the transcript's final figures", () => {
    const { mapper, events, finished } = setup();
    mapper.handle(
      frame("r1", "claude-opus-5-5", usage(2, 0, 9_000, 30), null, [agentCall("a1", "Explore")]),
    );
    // Two frames (one per content block) of the subagent's first call.
    mapper.handle(frame("c1", "claude-haiku-5-5", usage(2, 0, 15_000, 1), "a1", undefined, "ag1"));
    mapper.handle(
      frame(
        "c1",
        "claude-haiku-5-5",
        usage(2, 0, 15_000, 1),
        "a1",
        [agentCall("n1", "Nested")],
        "ag1",
      ),
    );
    // The nested subagent's call belongs to its own card.
    mapper.handle(frame("x1", "claude-sonnet-5-5", usage(5, 0, 7_000, 2), "n1", undefined, "ag2"));
    mapper.handle(agentResult("n1", "ag2", "Nested done"));
    mapper.handle(
      frame("c2", "claude-haiku-5-5", usage(3, 15_000, 500, 2), "a1", undefined, "ag1"),
    );
    mapper.handle(agentResult("a1", "ag1"));

    const [card] = subagentCards(events, "a1");
    expect(card).toMatchObject({
      status: "completed",
      summary: "Found it",
      stats: {
        totalTokens: 1234,
        toolUses: 1,
        durationMs: 900,
        usage: [
          {
            model: "claude-haiku-5-5",
            inputTokens: 5,
            outputTokens: 3,
            cacheReadTokens: 15_000,
            cacheWriteTokens: 15_500,
          },
        ],
      },
    });
    expect(subagentCards(events, "n1")[0]?.stats?.usage).toEqual([
      {
        model: "claude-sonnet-5-5",
        inputTokens: 5,
        outputTokens: 2,
        cacheReadTokens: 0,
        cacheWriteTokens: 7_000,
      },
    ]);
    expect(finished).toEqual([
      ["n1", "ag2"],
      ["a1", "ag1"],
    ]);

    const transcript = [
      transcriptEntry("c1", "claude-haiku-5-5", usage(2, 0, 15_000, 180)),
      transcriptEntry("c2", "claude-haiku-5-5", usage(3, 15_000, 500, 64)),
    ];
    mapper.correctSubagentUsage("a1", transcript);
    const cards = subagentCards(events, "a1");
    expect(cards).toHaveLength(2);
    const corrected = cards[1] as ItemOf<"subagent">;
    expect(corrected).toMatchObject({ status: "completed", summary: "Found it" });
    expect(corrected.stats).toEqual({
      totalTokens: 1234,
      toolUses: 1,
      durationMs: 900,
      usage: [
        {
          model: "claude-haiku-5-5",
          inputTokens: 5,
          outputTokens: 244,
          cacheReadTokens: 15_000,
          cacheWriteTokens: 15_500,
        },
      ],
    });
    // The same transcript again changes nothing, so the card is not sent again.
    mapper.correctSubagentUsage("a1", transcript);
    mapper.correctSubagentUsage("unknown", transcript);
    expect(subagentCards(events, "a1")).toHaveLength(2);
  });

  it("reports what a stopped run used so far", () => {
    const { mapper, events, finished } = setup();
    mapper.handle(
      frame("r1", "claude-opus-5-5", usage(2, 0, 9_000, 30), null, [agentCall("a1", "Explore")]),
    );
    mapper.handle(frame("c1", "claude-haiku-5-5", usage(2, 0, 15_000, 1), "a1"));
    mapper.endTurn({ type: "interrupted", reason: "user" });

    expect(subagentCards(events, "a1")[0]).toMatchObject({
      status: "cancelled",
      stats: { usage: [{ model: "claude-haiku-5-5", cacheWriteTokens: 15_000 }] },
    });
    // No agent id came, so there is no transcript to read.
    expect(finished).toEqual([]);
  });
});

describe("ClaudeSession subagent transcript", () => {
  const cwd = path.resolve(import.meta.dirname, "..");
  const base: SessionOptions = {
    sessionId: "s1",
    role: "agent",
    cwd,
    autonomy: "auto",
    mcpServers: [],
    additionalDirectories: [],
    planMode: false,
  };
  const script = [
    { type: "system", subtype: "init", session_id: "claude-1", model: "claude-opus-5-5" },
    frame("r1", "claude-opus-5-5", usage(2, 0, 9_000, 30), null, [agentCall("a1", "Explore")]),
    frame("c1", "claude-haiku-5-5", usage(2, 0, 15_000, 1), "a1", undefined, "ag1"),
    agentResult("a1", "ag1"),
  ];

  /** A `query()` that yields `script`, then waits until the session closes it. */
  function scriptedQuery() {
    return ((_params: unknown) => {
      let finish = () => {};
      const done = new Promise<void>((resolve) => {
        finish = resolve;
      });
      const pending = [...script];
      const q = {
        [Symbol.asyncIterator]: () => ({
          next: async () => {
            const value = pending.shift();
            if (value) return { done: false as const, value };
            await done;
            return { done: true as const, value: undefined };
          },
        }),
        setPermissionMode: async () => {},
        interrupt: async () => undefined,
        supportedModels: async () => [],
        supportedCommands: async () => [],
        close: () => finish(),
      };
      return q as unknown as Query;
    }) as unknown as ConstructorParameters<typeof ClaudeSession>[1]["query"];
  }

  const sessions: ClaudeSession[] = [];
  afterEach(async () => {
    await Promise.all(sessions.splice(0).map((s) => s.close()));
  });

  /** Let the pump and the transcript read settle (no timers involved). */
  const settle = async () => {
    for (let i = 0; i < 20; i++) await new Promise<void>((resolve) => setImmediate(resolve));
  };

  function open(read: (...args: unknown[]) => Promise<unknown[]>) {
    const calls: unknown[][] = [];
    const events: AgentEvent[] = [];
    const session = new ClaudeSession(base, {
      executable: { kind: "native", path: "/bin/claude" } as never,
      query: scriptedQuery(),
      getSubagentMessages: ((...args: unknown[]) => {
        calls.push(args);
        return read(...args);
      }) as never,
    });
    sessions.push(session);
    void (async () => {
      for await (const e of session.events) events.push(e);
    })();
    return { calls, events };
  }

  it("reads the finished subagent's transcript and sends its card with the final figures", async () => {
    const { calls, events } = open(async () => [
      transcriptEntry("c1", "claude-haiku-5-5", usage(2, 0, 15_000, 77)),
    ]);
    await settle();
    expect(calls).toEqual([["claude-1", "ag1", { dir: cwd }]]);
    const cards = subagentCards(events, "a1");
    expect(cards.map((c) => c.stats?.usage?.[0]?.outputTokens)).toEqual([1, 77]);
    expect(cards[1]).toMatchObject({ status: "completed", summary: "Found it" });
  });

  it("keeps the streamed figures when the transcript can't be read", async () => {
    const { calls, events } = open(async () => {
      throw new Error("no such session");
    });
    await settle();
    expect(calls).toHaveLength(1);
    const cards = subagentCards(events, "a1");
    expect(cards).toHaveLength(1);
    expect(cards[0]?.stats?.usage?.[0]?.outputTokens).toBe(1);
    expect(events.some((e) => "item" in e && e.item.kind === "error")).toBe(false);
  });
});

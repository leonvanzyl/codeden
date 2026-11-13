import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentEvent, ItemOf, RuntimeResponse, SessionOptions } from "@codeden/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ProviderSession } from "../src/adapter";
import { CursorAdapter } from "../src/cursor/adapter";
import { validateEventStream } from "../src/replay/validate";

const fakeAgent = {
  kind: "node-script" as const,
  path: process.execPath,
  script: join(import.meta.dirname, "fixtures", "fake-acp", "agent.mjs"),
};

type Logged = { method: string; params: Record<string, unknown> & { outcome?: unknown } };
let dir: string;
const logFile = () => join(dir, "acp.log");
const logged = (method?: string): Logged[] =>
  existsSync(logFile())
    ? readFileSync(logFile(), "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as Logged)
        .filter((m) => !method || m.method === method)
    : [];

type Step = Record<string, unknown>;
const chunk = (text: string): Step => ({
  update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text } },
});
const permission = (toolCall: Record<string, unknown>): Step => ({
  request: "session/request_permission",
  params: {
    toolCall,
    options: [
      { optionId: "allow-once", name: "Allow once", kind: "allow_once" },
      { optionId: "allow-always", name: "Always allow", kind: "allow_always" },
      { optionId: "reject-once", name: "Reject", kind: "reject_once" },
    ],
  },
});

function options(script: Step[], extra: Partial<SessionOptions> = {}): SessionOptions {
  const file = join(dir, `script-${Math.random().toString(36).slice(2)}.json`);
  writeFileSync(file, JSON.stringify(script));
  return {
    sessionId: "s1",
    role: "agent",
    cwd: dir,
    autonomy: "auto",
    mcpServers: [],
    additionalDirectories: [],
    planMode: false,
    ...extra,
    env: { FAKE_ACP_LOG: logFile(), FAKE_ACP_SCRIPT: file, ...extra.env },
  };
}

const isTurnEnd = (e: AgentEvent) =>
  e.type === "turn.completed" || e.type === "turn.failed" || e.type === "turn.interrupted";

type Request = ItemOf<"approval_request"> | ItemOf<"user_question">;

/** Reads a session's events, answering approvals and questions with `answer`. */
class Reader {
  readonly all: AgentEvent[] = [];
  private readonly it: AsyncIterator<AgentEvent>;
  answer: (item: Request) => RuntimeResponse | undefined = () => ({
    kind: "approval",
    decision: "allow_once",
  });

  constructor(private readonly session: ProviderSession) {
    this.it = session.events[Symbol.asyncIterator]();
  }

  async until(match: (e: AgentEvent) => boolean): Promise<AgentEvent> {
    for (;;) {
      const next = await this.it.next();
      if (next.done) throw new Error("event stream ended");
      const e = next.value;
      this.all.push(e);
      if (
        e.type === "item.started" &&
        (e.item.kind === "approval_request" || e.item.kind === "user_question")
      ) {
        const response = this.answer(e.item);
        if (response) await this.session.respond(e.item.requestId, response);
      }
      if (match(e)) return e;
    }
  }

  async turn(text: string): Promise<AgentEvent[]> {
    const from = this.all.length;
    await this.session.send({ text, attachments: [] });
    await this.until(isTurnEnd);
    return this.all.slice(from);
  }
}

const sessions: ProviderSession[] = [];
async function open(script: Step[], extra: Partial<SessionOptions> = {}) {
  const adapter = new CursorAdapter({ executable: fakeAgent });
  const session = await adapter.openSession(options(script, extra));
  sessions.push(session);
  return { session, reader: new Reader(session), adapter };
}

const completedOf = (events: AgentEvent[], kind: string) =>
  events.flatMap((e) => (e.type === "item.completed" && e.item.kind === kind ? [e.item] : []));

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "codeden-cursor-"));
});

afterEach(async () => {
  await Promise.all(sessions.splice(0).map((s) => s.close()));
});

describe("Cursor session over ACP", () => {
  it("opens a session in the worktree and streams a turn: message, command and file edit", async () => {
    const edited = join(dir, "src", "app.ts");
    const { session, reader } = await open(
      [
        chunk("Let me "),
        chunk("check."),
        {
          update: {
            sessionUpdate: "tool_call",
            toolCallId: "call-1",
            title: "`pnpm test`",
            kind: "execute",
            status: "in_progress",
            rawInput: { command: "pnpm test" },
          },
        },
        {
          update: {
            sessionUpdate: "tool_call_update",
            toolCallId: "call-1",
            status: "completed",
            content: [{ type: "content", content: { type: "text", text: "12 passed" } }],
            rawOutput: { exitCode: 0 },
          },
        },
        {
          update: {
            sessionUpdate: "tool_call",
            toolCallId: "call-2",
            title: "Edit app.ts",
            kind: "edit",
            status: "completed",
            content: [{ type: "diff", path: edited, oldText: "a", newText: "b" }],
          },
        },
        chunk("All good."),
        {
          stopReason: "end_turn",
          usage: { inputTokens: 120, outputTokens: 30, cachedReadTokens: 20 },
        },
      ],
      {
        systemPrompt: "You are a CodeDen agent.",
        mcpServers: [
          {
            transport: "http",
            name: "codeden",
            url: "http://127.0.0.1:4000/mcp",
            headers: { Authorization: "Bearer test" },
            trusted: true,
          },
        ],
      },
    );
    expect(session.resumeToken()).toBe("sess-1");
    const first = await reader.turn("Run the tests");
    await reader.turn("Again");

    expect(logged("authenticate")[0]?.params).toEqual({ methodId: "cursor_login" });
    const created = logged("session/new")[0]?.params;
    expect(created?.cwd).toBe(dir);
    expect(created?.mcpServers).toEqual([
      {
        type: "http",
        name: "codeden",
        url: "http://127.0.0.1:4000/mcp",
        headers: [{ name: "Authorization", value: "Bearer test" }],
      },
    ]);
    // The role prompt goes in front of the first prompt only.
    const prompts = logged("session/prompt").map(
      (m) => (m.params.prompt as { text: string }[])[0]?.text,
    );
    expect(prompts[0]).toContain("<instructions>\nYou are a CodeDen agent.\n</instructions>");
    expect(prompts[0]).toContain("Run the tests");
    expect(prompts[1]).toBe("Again");

    const messages = completedOf(first, "assistant_message") as ItemOf<"assistant_message">[];
    expect(messages.map((m) => m.text)).toEqual(["Let me check.", "All good."]);
    const tools = completedOf(first, "tool_call") as ItemOf<"tool_call">[];
    expect(tools[0]).toMatchObject({
      toolKind: "command",
      command: "pnpm test",
      exitCode: 0,
      status: "completed",
      output: { text: "12 passed" },
    });
    expect(tools[1]).toMatchObject({
      toolKind: "file_edit",
      changes: [{ path: edited, change: "modify" }],
    });
    const usage = first.filter((e) => e.type === "usage.updated").at(-1);
    expect(usage).toMatchObject({
      usage: { inputTokens: 100, outputTokens: 30, cachedInputTokens: 20 },
    });
    expect(first.at(-1)).toMatchObject({ type: "turn.completed", stopReason: "end_turn" });
    expect(validateEventStream(reader.all)).toEqual([]);
  });

  it("approves what the level allows by policy and asks for risky actions", async () => {
    const { reader } = await open([
      permission({
        toolCallId: "c1",
        kind: "execute",
        title: "git status",
        rawInput: { command: "git status" },
      }),
      permission({
        toolCallId: "c2",
        kind: "execute",
        title: "git push",
        rawInput: { command: "git push --force origin main" },
      }),
    ]);
    const asked: Request[] = [];
    reader.answer = (item) => {
      asked.push(item);
      return { kind: "approval", decision: "deny" };
    };
    const events = await reader.turn("Ship it");

    expect(asked).toHaveLength(1);
    expect(asked[0]).toMatchObject({
      action: "git_destructive",
      command: "git push --force origin main",
    });
    const answers = logged("answer:session/request_permission").map((m) => m.params.outcome);
    // Never "allow-always": that would save a rule in the user's Cursor settings.
    expect(answers).toEqual([
      { outcome: "selected", optionId: "allow-once" },
      { outcome: "selected", optionId: "reject-once" },
    ]);
    const decided = completedOf(events, "approval_request") as ItemOf<"approval_request">[];
    expect(decided[0]).toMatchObject({
      decidedBy: "policy",
      decision: "allow_once",
      command: "git status",
    });
    expect(decided[1]).toMatchObject({ decidedBy: "user", decision: "deny", status: "declined" });
  });

  it("asks for every edit under supervised, and refuses edits in read-only (ask mode)", async () => {
    const edit = permission({
      toolCallId: "e1",
      kind: "edit",
      title: "Edit a.ts",
      locations: [{ path: join(dir, "a.ts") }],
    });
    const supervised = await open([edit], { autonomy: "supervised" });
    const asked: Request[] = [];
    supervised.reader.answer = (item) => {
      asked.push(item);
      return { kind: "approval", decision: "allow_once" };
    };
    await supervised.reader.turn("Edit it");
    expect(asked).toMatchObject([{ action: "file_change", paths: [join(dir, "a.ts")] }]);

    const readOnly = await open([edit], { autonomy: "read_only" });
    readOnly.reader.answer = () => {
      throw new Error("read-only sessions never ask");
    };
    await readOnly.reader.turn("Edit it");
    expect(logged("session/set_mode").map((m) => m.params.modeId)).toContain("ask");
    expect(logged("answer:session/request_permission").at(-1)?.params.outcome).toEqual({
      outcome: "selected",
      optionId: "reject-once",
    });
  });

  it("turns Cursor's questions into a question card and sends back the chosen option ids", async () => {
    const { reader } = await open([
      {
        request: "cursor/ask_question",
        params: {
          toolCallId: "q-call",
          title: "Need input",
          questions: [
            {
              id: "q1",
              prompt: "Which database?",
              options: [
                { id: "pg", label: "Postgres" },
                { id: "sqlite", label: "SQLite" },
              ],
            },
          ],
        },
      },
    ]);
    reader.answer = (item) => {
      expect(item).toMatchObject({
        kind: "user_question",
        questions: [
          {
            id: "q1",
            question: "Which database?",
            options: [{ label: "Postgres" }, { label: "SQLite" }],
          },
        ],
      });
      return { kind: "answer", answers: { q1: ["SQLite"] } };
    };
    await reader.turn("Set up storage");
    expect(logged("answer:cursor/ask_question")[0]?.params).toEqual({
      outcome: {
        outcome: "answered",
        answers: [{ questionId: "q1", selectedOptionIds: ["sqlite"] }],
      },
    });
  });

  it("plans in Cursor's plan mode and leaves it when the user approves the plan", async () => {
    const plan = {
      request: "cursor/create_plan",
      params: {
        toolCallId: "plan-1",
        name: "Add login",
        plan: "1. Add the form\n2. Wire it up",
        todos: [
          { id: "t1", content: "Add the form", status: "pending" },
          { id: "t2", content: "Wire it up", status: "pending" },
        ],
      },
    };
    const { session, reader } = await open([plan], { planMode: true });
    expect(logged("session/set_mode").map((m) => m.params.modeId)).toEqual(["plan"]);
    const notes: string[] = [];
    reader.answer = (item) => {
      expect(item).toMatchObject({ action: "plan", options: ["allow_once", "deny"] });
      notes.push("asked");
      return notes.length === 1
        ? { kind: "approval", decision: "deny", message: "Add tests too" }
        : { kind: "approval", decision: "allow_once" };
    };
    const declined = await reader.turn("Plan the login");
    expect(logged("answer:cursor/create_plan")[0]?.params).toEqual({
      outcome: { outcome: "rejected", reason: "Add tests too" },
    });
    expect((completedOf(declined, "plan")[0] as ItemOf<"plan">).text).toContain("# Add login");
    expect(declined.some((e) => e.type === "item.started" && e.item.kind === "todo_list")).toBe(
      true,
    );

    const approved = await reader.turn("Revised");
    expect(logged("answer:cursor/create_plan")[1]?.params).toEqual({
      outcome: { outcome: "accepted" },
    });
    expect(logged("session/set_mode").map((m) => m.params.modeId)).toEqual(["plan", "agent"]);
    expect(approved).toContainEqual({ type: "session.updated", planMode: false });
    await session.setPlanMode?.(true);
    expect(logged("session/set_mode").at(-1)?.params.modeId).toBe("plan");
    expect(validateEventStream(reader.all)).toEqual([]);
  });

  it("keeps Cursor's todo list and refuses extensions it doesn't handle", async () => {
    const todos = (merge: boolean, list: unknown[]) => ({
      notify: "cursor/update_todos",
      params: { toolCallId: "t", merge, todos: list },
    });
    const { reader } = await open([
      todos(false, [
        { id: "1", content: "Write code", status: "in_progress" },
        { id: "2", content: "Test it", status: "pending" },
      ]),
      todos(true, [{ id: "1", content: "Write code", status: "completed" }]),
      {
        request: "cursor/task",
        params: { toolCallId: "sub", description: "Explore", prompt: "Look" },
      },
    ]);
    const events = await reader.turn("Go");
    const list = completedOf(events, "todo_list")[0] as ItemOf<"todo_list">;
    expect(list.todos).toEqual([
      { id: "1", text: "Write code", status: "completed" },
      { id: "2", text: "Test it", status: "pending" },
    ]);
    expect(logged("answer:cursor/task")[0]?.params).toMatchObject({ error: { code: -32601 } });
  });

  it("interrupts with session/cancel and cancels a waiting approval", async () => {
    const { session, reader } = await open(
      [
        permission({
          toolCallId: "w",
          kind: "execute",
          title: "rm",
          rawInput: { command: "rm -rf /tmp/x" },
        }),
        { hang: true },
      ],
      { autonomy: "supervised" },
    );
    reader.answer = () => undefined; // leave it waiting
    await session.send({ text: "Clean up", attachments: [] });
    await reader.until((e) => e.type === "item.started" && e.item.kind === "approval_request");
    await session.interrupt();
    const end = await reader.until(isTurnEnd);
    expect(end).toMatchObject({ type: "turn.interrupted", reason: "user" });
    expect(logged("session/cancel")[0]?.params).toEqual({ sessionId: "sess-1" });
    expect(logged("answer:session/request_permission")[0]?.params.outcome).toEqual({
      outcome: "cancelled",
    });
  });

  it("resumes the agent's session with session/load without replaying its history", async () => {
    const { session, reader } = await open([chunk("Welcome back.")], {
      resumeToken: "sess-old",
      model: "gpt-5",
    });
    expect(session.resumeToken()).toBe("sess-old");
    expect(logged("session/load")[0]?.params).toMatchObject({ sessionId: "sess-old", cwd: dir });
    expect(logged("session/new")).toEqual([]);
    expect(logged("session/set_config_option")[0]?.params).toMatchObject({
      sessionId: "sess-old",
      configId: "model",
      value: "gpt-5",
    });
    const events = await reader.turn("Continue");
    const texts = (
      completedOf(reader.all, "assistant_message") as ItemOf<"assistant_message">[]
    ).map((m) => m.text);
    expect(texts).toEqual(["Welcome back."]);
    expect(events.some((e) => e.type === "turn.completed")).toBe(true);
    expect(validateEventStream(reader.all)).toEqual([]);
  });

  it("keeps plan mode on resume: the replayed history's mode change is not news", async () => {
    const { reader } = await open([chunk("Still planning.")], {
      resumeToken: "sess-old",
      planMode: true,
    });
    const events = await reader.turn("Continue the plan");
    expect(logged("session/set_mode").map((m) => m.params.modeId)).toEqual(["plan"]);
    expect(reader.all.some((e) => e.type === "session.updated" && e.planMode === false)).toBe(
      false,
    );
    expect(events.some((e) => e.type === "turn.completed")).toBe(true);
  });

  it("asks about a command titled like CodeDen's own tools instead of trusting it", async () => {
    const { reader } = await open(
      [
        permission({
          toolCallId: "t1",
          kind: "execute",
          title: "codeden-x; rm -rf ~",
          rawInput: { command: "codeden-x; rm -rf ~" },
        }),
      ],
      {
        mcpServers: [
          { transport: "http", name: "codeden", url: "http://127.0.0.1:4000/mcp", trusted: true },
        ],
      },
    );
    const asked: Request[] = [];
    reader.answer = (item) => {
      asked.push(item);
      return { kind: "approval", decision: "deny" };
    };
    await reader.turn("Clean up");
    expect(asked).toMatchObject([{ kind: "approval_request", command: "codeden-x; rm -rf ~" }]);
    expect(logged("answer:session/request_permission")[0]?.params.outcome).toEqual({
      outcome: "selected",
      optionId: "reject-once",
    });
  });

  it("starts a new session with a notice when the old one can't be loaded", async () => {
    const { session, reader } = await open([chunk("Hi.")], {
      resumeToken: "gone",
      env: { FAKE_ACP_LOAD: "fail" },
    });
    expect(session.resumeToken()).toBe("sess-1");
    const events = await reader.turn("Hello");
    const notices = completedOf(events, "notice") as ItemOf<"notice">[];
    expect(notices[0]?.message).toMatch(/Could not resume Cursor session gone/);
  });

  it("switches the model through the session's model option", async () => {
    const { session, reader } = await open([chunk("ok")]);
    await session.configure?.({ model: "sonnet-4.5" });
    const events = await reader.turn("Hi");
    expect(logged("session/set_config_option")[0]?.params).toMatchObject({
      configId: "model",
      value: "sonnet-4.5",
    });
    expect(events).toContainEqual({ type: "session.updated", model: "sonnet-4.5" });
  });
});

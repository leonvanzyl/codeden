import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentEvent, ItemOf, SessionOptions } from "@codeden/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ProviderSession } from "../src/adapter";
import { OpenCodeAdapter } from "../src/opencode/adapter";
import { validateEventStream } from "../src/replay/validate";

const fakeOpenCode = {
  kind: "node-script" as const,
  path: process.execPath,
  script: join(import.meta.dirname, "fixtures", "fake-opencode", "opencode.mjs"),
};

type Logged = {
  pid: number;
  kind: string;
  method?: string;
  path?: string;
  body?: Record<string, unknown>;
  config?: Record<string, unknown>;
  hasPassword?: boolean;
  electron?: string | null;
  extraEnv?: string | null;
};

let dir: string;
const logFile = () => join(dir, "requests.log");
const logged = (): Logged[] =>
  existsSync(logFile())
    ? readFileSync(logFile(), "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line))
    : [];
const requests = (path: RegExp, method?: string) =>
  logged().filter(
    (r) => r.kind === "request" && path.test(r.path ?? "") && (!method || r.method === method),
  );

function options(extra: Partial<SessionOptions> = {}): SessionOptions {
  return {
    sessionId: "s1",
    role: "agent",
    cwd: dir,
    autonomy: "auto",
    mcpServers: [],
    additionalDirectories: [],
    planMode: false,
    ...extra,
  };
}

const isRootEnd = (e: AgentEvent) =>
  (e.type === "turn.completed" || e.type === "turn.failed" || e.type === "turn.interrupted") &&
  e.threadId.endsWith(":thread-root");

/** Reads a session's events; answers approvals and questions with `answer`. */
class Reader {
  readonly all: AgentEvent[] = [];
  private readonly it: AsyncIterator<AgentEvent>;
  answer: (item: ItemOf<"approval_request"> | ItemOf<"user_question">) => unknown = () => ({
    kind: "approval",
    decision: "allow_once",
  });

  constructor(private readonly session: ProviderSession) {
    this.it = session.events[Symbol.asyncIterator]();
  }

  async until(match: (e: AgentEvent) => boolean, timeoutMs = 8000): Promise<AgentEvent> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const next = await Promise.race([
        this.it.next(),
        new Promise<never>((_, reject) =>
          setTimeout(
            () => reject(new Error("timed out waiting for an event")),
            deadline - Date.now(),
          ),
        ),
      ]);
      if (next.done) throw new Error("event stream ended");
      const e = next.value;
      this.all.push(e);
      if (
        e.type === "item.started" &&
        (e.item.kind === "approval_request" || e.item.kind === "user_question")
      ) {
        const response = this.answer(e.item);
        // biome-ignore lint/suspicious/noExplicitAny: test helper
        if (response) await this.session.respond(e.item.requestId, response as any);
      }
      if (match(e)) return e;
    }
  }

  async turn(text: string): Promise<AgentEvent[]> {
    const from = this.all.length;
    await this.session.send({ text, attachments: [] });
    await this.until(isRootEnd);
    return this.all.slice(from);
  }
}

const sessions: ProviderSession[] = [];
const adapter = () => new OpenCodeAdapter({ executable: fakeOpenCode, noGuardPlugin: true });

async function open(extra: Partial<SessionOptions> = {}, a = adapter()) {
  const session = await a.openSession(options(extra));
  sessions.push(session);
  return { session, reader: new Reader(session) };
}

const completed = (events: AgentEvent[], kind: string) =>
  events.filter(
    (e): e is Extract<AgentEvent, { type: "item.completed" }> =>
      e.type === "item.completed" && e.item.kind === kind,
  );

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "codeden-opencode-"));
  process.env.FAKE_OPENCODE_LOG = logFile();
  process.env.FAKE_OPENCODE_STATE = join(dir, "state.json");
});

afterEach(async () => {
  await Promise.all(sessions.splice(0).map((s) => s.close()));
  delete process.env.FAKE_OPENCODE_LOG;
  delete process.env.FAKE_OPENCODE_STATE;
  delete process.env.FAKE_OPENCODE_MODE;
});

describe("OpenCode session", () => {
  it("creates the session in the worktree with CodeDen's rules, model and instructions", async () => {
    const { session, reader } = await open({
      model: "anthropic/claude-opus-5-5",
      effort: "high",
      systemPrompt: "You are a CodeDen agent.",
      env: { CODEDEN_TEST_EXTRA: "yes" },
    });
    await reader.until((e) => e.type === "session.updated" && !!e.resumeToken);
    const create = requests(/^\/api\/session$/, "POST")[0];
    expect(create?.body).toMatchObject({
      location: { directory: dir },
      model: { providerID: "anthropic", id: "claude-opus-5-5", variant: "high" },
      permissions: expect.arrayContaining([
        { action: "edit", resource: "*", effect: "ask" },
        { action: "shell", resource: "*", effect: "ask" },
        { action: "external_directory", resource: "*", effect: "ask" },
      ]),
    });
    expect(requests(/instructions\/entries\/codeden$/)[0]?.body).toEqual({
      value: "You are a CodeDen agent.",
    });
    const start = logged().find((r) => r.kind === "start");
    expect(start).toMatchObject({ hasPassword: true, electron: null, extraEnv: "yes" });
    expect(session.resumeToken()).toMatch(/^ses_/);
  });

  it("maps a plain turn: reasoning, text, usage with cost", async () => {
    const a = adapter();
    await a.refreshModels();
    const { reader } = await open({}, a);
    const events = await reader.turn("hello");
    expect(events.at(-1)).toMatchObject({ type: "turn.completed" });
    expect(completed(events, "reasoning")[0]?.item).toMatchObject({ text: "Thinking. " });
    expect(completed(events, "assistant_message")[0]?.item).toMatchObject({
      text: "Hello from fake OpenCode.",
    });
    const usage = events.filter((e) => e.type === "usage.updated").at(-1);
    expect(usage).toMatchObject({
      usage: {
        inputTokens: 100,
        outputTokens: 25,
        reasoningTokens: 5,
        cachedInputTokens: 10,
        costUsd: 0.0025,
        contextWindow: 200000,
      },
    });
    expect(validateEventStream(reader.all)).toEqual([]);
  });

  it("auto-approves safe edits and commands at auto, with the diff on the file edit", async () => {
    const { reader } = await open();
    reader.answer = () => {
      throw new Error("no approval expected at auto");
    };
    const edit = await reader.turn("edit");
    const item = completed(edit, "tool_call")[0]?.item;
    expect(item).toMatchObject({
      toolKind: "file_edit",
      status: "completed",
      changes: [{ path: join(dir, "a.txt"), change: "modify", additions: 1, deletions: 1 }],
    });
    const shell = await reader.turn("shell");
    expect(completed(shell, "tool_call")[0]?.item).toMatchObject({
      toolKind: "command",
      command: "pnpm test",
      exitCode: 0,
      status: "completed",
    });
    expect(requests(/permission\/.+\/reply$/).map((r) => r.body)).toEqual([
      { decision: "once" },
      { decision: "once" },
    ]);
  });

  it("asks the user for risky commands; a denial reaches the agent with a message", async () => {
    const { reader } = await open();
    const seen: ItemOf<"approval_request">[] = [];
    reader.answer = (item) => {
      if (item.kind === "approval_request") seen.push(item);
      return { kind: "approval", decision: "deny", message: "Not on main" };
    };
    const events = await reader.turn("push");
    expect(seen[0]).toMatchObject({
      action: "git_destructive",
      command: "git push --force origin main",
      options: ["allow_once", "allow_session", "deny"],
    });
    expect(completed(events, "approval_request")[0]?.item).toMatchObject({
      status: "declined",
      decision: "deny",
    });
    expect(completed(events, "tool_call")[0]?.item).toMatchObject({ status: "declined" });
    expect(events.at(-1)).toMatchObject({ type: "turn.completed" });
    expect(requests(/permission\/.+\/reply$/).at(-1)?.body).toEqual({
      decision: "reject",
      message: "Not on main",
    });
  });

  it("asks for every edit in supervised mode and remembers allow_session (never OpenCode's always)", async () => {
    const { reader } = await open({ autonomy: "supervised" });
    let asked = 0;
    reader.answer = () => {
      asked += 1;
      return { kind: "approval", decision: "allow_session" };
    };
    await reader.turn("edit");
    await reader.turn("edit");
    expect(asked).toBe(1);
    const replies = requests(/permission\/.+\/reply$/).map((r) => r.body?.decision);
    expect(replies).toEqual(["once", "once"]);
  });

  it("applies an autonomy change from the next tool call (live)", async () => {
    const { session, reader } = await open();
    let asked = 0;
    reader.answer = () => {
      asked += 1;
      return { kind: "approval", decision: "allow_once" };
    };
    await reader.turn("shell");
    expect(asked).toBe(0);
    await session.setAutonomy?.("supervised");
    await reader.turn("shell");
    expect(asked).toBe(1);
  });

  it("refuses edits and writing commands in read-only sessions without asking", async () => {
    const { reader } = await open({ readOnly: true });
    reader.answer = () => {
      throw new Error("read-only sessions never ask");
    };
    const events = await reader.turn("edit");
    expect(completed(events, "tool_call")[0]?.item).toMatchObject({ status: "declined" });
    const reply = requests(/permission\/.+\/reply$/)[0]?.body;
    expect(reply).toMatchObject({ decision: "reject" });
    expect(String(reply?.message)).toMatch(/read-only/);
  });

  it("round-trips the question tool as a user_question", async () => {
    const { reader } = await open();
    reader.answer = (item) =>
      item.kind === "user_question"
        ? { kind: "answer", answers: { q0: ["Blue"], q1: ["Small", "Large"] } }
        : undefined;
    const events = await reader.turn("ask");
    const question = events.find(
      (e) => e.type === "item.started" && e.item.kind === "user_question",
    );
    expect(question).toMatchObject({
      item: {
        questions: [
          { id: "q0", header: "Colour", question: "Which colour?", allowFreeText: true },
          { id: "q1", multiSelect: true, options: [{ label: "Small" }, { label: "Large" }] },
        ],
      },
    });
    expect(requests(/form\/.+\/reply$/)[0]?.body).toEqual({
      answer: { q0: "blue", q1: ["s", "l"] },
    });
    expect(completed(events, "tool_call")).toEqual([]);
  });

  it("maps todowrite to a todo list and subagents to child threads", async () => {
    const { reader } = await open();
    const todo = await reader.turn("todo");
    expect(
      todo.find((e) => e.type === "item.started" && e.item.kind === "todo_list"),
    ).toMatchObject({
      item: {
        todos: [
          { text: "First", status: "in_progress" },
          { text: "Second", status: "pending" },
        ],
      },
    });
    const sub = await reader.turn("subagent");
    const thread = sub.find((e) => e.type === "thread.started");
    expect(thread).toMatchObject({
      thread: { parentThreadId: "s1:thread-root", agentType: "explore" },
    });
    const childId = thread?.type === "thread.started" ? thread.thread.id : "";
    expect(
      sub.some(
        (e) =>
          e.type === "item.completed" &&
          e.threadId === childId &&
          e.item.kind === "assistant_message" &&
          e.item.text === "Found 3 files.",
      ),
    ).toBe(true);
    expect(completed(sub, "subagent")[0]?.item).toMatchObject({
      status: "completed",
      summary: "Found 3 files.",
    });
    expect(validateEventStream(reader.all)).toEqual([]);
  });

  it("injects CodeDen's MCP server with its headers and shows its tools as MCP calls", async () => {
    const { reader } = await open({
      mcpServers: [
        {
          transport: "http",
          name: "codeden",
          url: "http://127.0.0.1:9/mcp",
          headers: { Authorization: "Bearer role-token" },
          toolTimeoutSec: 600,
          trusted: true,
        },
      ],
    });
    const events = await reader.turn("mcp");
    const config = logged().find((r) => r.kind === "start")?.config;
    expect(config).toEqual({
      mcp: {
        servers: {
          codeden: {
            type: "remote",
            url: "http://127.0.0.1:9/mcp",
            headers: { Authorization: "Bearer role-token" },
            oauth: false,
            codemode: false,
            timeout: 600000,
          },
        },
      },
    });
    expect(completed(events, "tool_call")[0]?.item).toMatchObject({
      toolKind: "mcp",
      server: "codeden",
      tool: "finish",
      toolName: "codeden_finish",
    });
    // The token is in the server's environment only, never on its command line.
    const start = logged().find((r) => r.kind === "start") as { args?: string[] } | undefined;
    expect(JSON.stringify(start?.args)).not.toContain("role-token");
  });

  it("interrupts a running turn and stays usable", async () => {
    const { session, reader } = await open();
    await session.send({ text: "slow", attachments: [] });
    await reader.until((e) => e.type === "item.delta");
    await session.interrupt();
    const end = await reader.until(isRootEnd);
    expect(end).toMatchObject({ type: "turn.interrupted", reason: "user" });
    expect((await reader.turn("hello")).at(-1)).toMatchObject({ type: "turn.completed" });
  });

  it("steers a running turn", async () => {
    const { session, reader } = await open();
    await session.send({ text: "slow", attachments: [] });
    await reader.until((e) => e.type === "item.delta");
    await session.steer?.({ text: "also say hi", attachments: [] });
    await reader.until(isRootEnd);
    expect(requests(/\/prompt$/).at(-1)?.body).toMatchObject({
      text: "also say hi",
      delivery: "steer",
    });
    expect(
      reader.all.some(
        (e) =>
          e.type === "item.completed" &&
          e.item.kind === "assistant_message" &&
          e.item.text === "steered: also say hi",
      ),
    ).toBe(true);
  });

  it("reports provider errors as a failed turn", async () => {
    const { reader } = await open();
    const events = await reader.turn("fail");
    expect(events.at(-1)).toMatchObject({
      type: "turn.failed",
      error: { code: "opencode_provider_auth", message: "Invalid API key" },
    });
    const retry = await reader.turn("retry");
    expect(
      retry.find((e) => e.type === "item.completed" && e.item.kind === "notice"),
    ).toMatchObject({
      item: { level: "warning", code: "retrying" },
    });
  });

  it("switches model and effort for the next turn", async () => {
    const { session, reader } = await open({ model: "anthropic/claude-opus-5-5" });
    await session.configure?.({ model: "openai/gpt-5.5", effort: "medium" });
    await reader.turn("hello");
    expect(requests(/\/model$/, "POST").at(-1)?.body).toEqual({
      model: { providerID: "openai", id: "gpt-5.5", variant: "medium" },
    });
    expect(
      reader.all.some((e) => e.type === "session.updated" && e.model === "openai/gpt-5.5"),
    ).toBe(true);
  });

  it("survives a server crash: the turn fails, the next send resumes the same session", async () => {
    const { session, reader } = await open();
    await reader.turn("hello");
    const token = session.resumeToken();
    const crash = await reader.turn("crash");
    expect(crash.at(-1)).toMatchObject({ type: "turn.failed", error: { code: "provider_exited" } });
    const after = await reader.turn("hello");
    expect(after.at(-1)).toMatchObject({ type: "turn.completed" });
    expect(session.resumeToken()).toBe(token);
    expect(
      new Set(
        logged()
          .filter((r) => r.kind === "start")
          .map((r) => r.pid),
      ).size,
    ).toBe(2);
    expect(requests(/^\/api\/session\/ses_[^/]+$/, "PATCH").length).toBeGreaterThan(0);
  });

  it("resumes a session after a restart and starts a new one when it is gone", async () => {
    const a = adapter();
    const first = await open({}, a);
    await first.reader.turn("hello");
    const token = first.session.resumeToken();
    await first.session.close();

    const resumed = await open({ resumeToken: token }, a);
    await resumed.reader.until((e) => e.type === "session.updated" && !!e.resumeToken);
    expect(resumed.session.resumeToken()).toBe(token);
    expect(requests(/^\/api\/session$/, "POST")).toHaveLength(1);
    await resumed.session.close();

    const fresh = await open({ resumeToken: "ses_missing" }, a);
    const events = await fresh.reader.turn("hello");
    expect(fresh.session.resumeToken()).not.toBe("ses_missing");
    expect(
      events.find((e) => e.type === "item.completed" && e.item.kind === "notice"),
    ).toMatchObject({
      item: { code: "resume_failed" },
    });
  });

  it("stops the server on close (stdin closes, the process exits)", async () => {
    const { session, reader } = await open();
    await reader.turn("hello");
    const pid = logged().find((r) => r.kind === "start")?.pid as number;
    await session.close();
    expect(logged().some((r) => r.kind === "stdin-closed" && r.pid === pid)).toBe(true);
    expect(() => process.kill(pid, 0)).toThrow();
  });
});

describe("OpenCode utility model", () => {
  it("runs a tool-less one-shot through generate/text, system prompt first", async () => {
    const util = adapter().utilityModel();
    const text = await util.runOneShot({
      prompt: "Summarise",
      system: "Be brief",
      model: "openai/gpt-5.5",
    });
    expect(text).toBe("echo: Be brief\n\n---\n\nSummarise via openai/gpt-5.5");
    expect(util.providerId).toBe("opencode");
  });
});

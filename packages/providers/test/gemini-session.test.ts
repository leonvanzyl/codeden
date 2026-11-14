import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentEvent, ItemOf, RuntimeResponse, SessionOptions } from "@codeden/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ProviderSession } from "../src/adapter";
import { GeminiAdapter } from "../src/gemini/adapter";
import { validateEventStream } from "../src/replay/validate";

const fakeGemini = {
  kind: "node-script" as const,
  path: process.execPath,
  script: join(import.meta.dirname, "fixtures", "fake-gemini", "gemini.mjs"),
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
/** Gemini CLI's options: an "always" option where it offers one, then allow and cancel. */
const permission = (toolCall: Record<string, unknown>): Step => ({
  request: "session/request_permission",
  params: {
    toolCall: { status: "pending", ...toolCall },
    options: [
      { optionId: "proceed_always", name: "Always allow", kind: "allow_always" },
      { optionId: "proceed_once", name: "Allow", kind: "allow_once" },
      { optionId: "cancel", name: "Reject", kind: "reject_once" },
    ],
  },
});
const mcpCall = (id: string, server: string, tool: string): Step =>
  permission({
    toolCallId: id,
    kind: "other",
    title: tool,
    _meta: { "gemini-cli": { mcp: { server_name: server, tool_name: tool } } },
  });

const codeden = {
  transport: "http" as const,
  name: "codeden",
  url: "http://127.0.0.1:4000/mcp",
  headers: { Authorization: "Bearer test" },
  trusted: true,
};

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
    env: { FAKE_GEMINI_LOG: logFile(), FAKE_GEMINI_SCRIPT: file, ...extra.env },
  };
}

const isTurnEnd = (e: AgentEvent) =>
  e.type === "turn.completed" || e.type === "turn.failed" || e.type === "turn.interrupted";

type Request = ItemOf<"approval_request"> | ItemOf<"user_question">;

/** Reads a session's events, answering approvals with `answer`. */
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
  const adapter = new GeminiAdapter({ executable: fakeGemini });
  const session = await adapter.openSession(options(script, extra));
  sessions.push(session);
  return { session, reader: new Reader(session), adapter };
}

const completedOf = (events: AgentEvent[], kind: string) =>
  events.flatMap((e) => (e.type === "item.completed" && e.item.kind === kind ? [e.item] : []));
const answers = () =>
  logged("answer:session/request_permission").map((m) => m.params.outcome as unknown);

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "codeden-gemini-"));
});

afterEach(async () => {
  await Promise.all(sessions.splice(0).map((s) => s.close()));
});

describe("Gemini CLI session over ACP", () => {
  it("runs `--acp` on the user's own login, leaves YOLO mode and streams a turn with usage", async () => {
    const { session, reader, adapter } = await open(
      [
        chunk("Looking."),
        { stopReason: "end_turn", usage: { inputTokens: 90, outputTokens: 12, thoughtTokens: 4 } },
      ],
      {
        mcpServers: [codeden],
        systemPrompt: "You are a CodeDen agent.",
        env: { FAKE_GEMINI_MODE: "yolo" },
      },
    );
    expect(session.resumeToken()).toBe("gem-1");
    const events = await reader.turn("Look around");

    // Never `authenticate`: Gemini CLI would rewrite the login method in the user's settings.
    expect(logged("authenticate")).toEqual([]);
    expect(logged("session/new")[0]?.params).toMatchObject({
      cwd: dir,
      mcpServers: [
        {
          type: "http",
          name: "codeden",
          url: "http://127.0.0.1:4000/mcp",
          headers: [{ name: "Authorization", value: "Bearer test" }],
        },
      ],
    });
    // The user's default (YOLO here) would run everything unasked: CodeDen's sessions ask.
    expect(logged("session/set_mode").map((m) => m.params.modeId)).toEqual(["default"]);
    const messages = completedOf(events, "assistant_message") as ItemOf<"assistant_message">[];
    expect(messages.map((m) => m.text)).toEqual(["Looking."]);
    expect(events.filter((e) => e.type === "usage.updated").at(-1)).toMatchObject({
      usage: { inputTokens: 90, outputTokens: 12, reasoningTokens: 4 },
    });
    expect(events.at(-1)).toMatchObject({ type: "turn.completed", stopReason: "end_turn" });
    expect(validateEventStream(reader.all)).toEqual([]);

    // The session's own model list replaces the aliases; a choice goes through set_model.
    expect(adapter.models().map((m) => m.id)).toEqual([
      "default",
      "auto",
      "gemini-3-pro-preview",
      "gemini-2.5-flash",
    ]);
    await session.configure?.({ model: "gemini-2.5-flash" });
    const next = await reader.turn("Again");
    expect(logged("session/set_model")[0]?.params).toMatchObject({
      sessionId: "gem-1",
      modelId: "gemini-2.5-flash",
    });
    expect(next).toContainEqual({ type: "session.updated", model: "gemini-2.5-flash" });
  });

  it("trusts CodeDen's own MCP tools by Gemini CLI's own fields, even read-only, and asks about others", async () => {
    const readOnly = await open([mcpCall("m1", "codeden", "report_progress")], {
      mcpServers: [codeden],
      autonomy: "read_only",
    });
    readOnly.reader.answer = () => {
      throw new Error("CodeDen's own tools never ask");
    };
    const quiet = await readOnly.reader.turn("Report");
    expect(answers()).toEqual([{ outcome: "selected", optionId: "proceed_once" }]);
    // Allowed silently: no decision recorded, and never an "always" option.
    expect(completedOf(quiet, "approval_request")).toEqual([]);

    const supervised = await open([mcpCall("m2", "github", "create_issue")], {
      mcpServers: [codeden],
      autonomy: "supervised",
    });
    const asked: Request[] = [];
    supervised.reader.answer = (item) => {
      asked.push(item);
      return { kind: "approval", decision: "deny" };
    };
    await supervised.reader.turn("File it");
    expect(asked).toMatchObject([{ kind: "approval_request", title: "Run github: create_issue" }]);
    expect(answers().at(-1)).toEqual({ outcome: "selected", optionId: "cancel" });
  });

  it("judges a shell command in the folder Gemini CLI names for it", async () => {
    const { reader } = await open(
      [
        permission({
          toolCallId: "sh",
          kind: "execute",
          title: "pnpm test",
          content: [
            { type: "content", content: { type: "text", text: "[in sub] (run the tests)" } },
          ],
        }),
      ],
      { autonomy: "supervised" },
    );
    const asked: Request[] = [];
    reader.answer = (item) => {
      asked.push(item);
      return { kind: "approval", decision: "allow_once" };
    };
    await reader.turn("Test");
    expect(asked).toMatchObject([{ command: "pnpm test", cwd: join(dir, "sub") }]);
    expect(answers()).toEqual([{ outcome: "selected", optionId: "proceed_once" }]);
  });

  it("turns Gemini CLI's exit_plan_mode into CodeDen's plan approval", async () => {
    mkdirSync(join(dir, "plans"));
    const planFile = join(dir, "plans", "login.md");
    writeFileSync(planFile, "# Add login\n\n1. Add the form");
    const exitPlan = permission({
      toolCallId: "exit",
      kind: "other",
      title: `Requesting plan approval for: ${planFile}`,
    });
    const other = permission({ toolCallId: "skill", kind: "other", title: "Activate skill: lint" });
    const { session, reader, adapter } = await open([other, exitPlan], { planMode: true });
    expect(logged("session/set_mode").map((m) => m.params.modeId)).toEqual(["plan"]);
    expect(adapter.capabilities().planMode).toBe(true);

    const asked: Request[] = [];
    reader.answer = (item) => {
      asked.push(item);
      if (item.kind !== "approval_request") return undefined;
      // Declined the first time round, approved the second.
      const plans = asked.filter((a) => a.kind === "approval_request" && a.action === "plan");
      return item.action === "plan" && plans.length === 1
        ? { kind: "approval", decision: "deny", message: "Add tests" }
        : { kind: "approval", decision: "allow_once" };
    };
    const declined = await reader.turn("Plan the login");
    // An unidentified tool while planning goes to the user, even at Auto.
    expect(asked[0]).toMatchObject({ kind: "approval_request", action: "other" });
    expect(asked[1]).toMatchObject({
      action: "plan",
      options: ["allow_once", "deny"],
      toolName: "exit_plan_mode",
    });
    expect((completedOf(declined, "plan")[0] as ItemOf<"plan">).text).toBe(
      "# Add login\n\n1. Add the form",
    );
    expect(answers()).toEqual([
      { outcome: "selected", optionId: "proceed_once" },
      { outcome: "selected", optionId: "cancel" },
    ]);
    expect(reader.all.some((e) => e.type === "session.updated" && e.planMode === false)).toBe(
      false,
    );

    const approved = await reader.turn("Revised");
    expect(answers().at(-1)).toEqual({ outcome: "selected", optionId: "proceed_once" });
    expect(approved).toContainEqual({ type: "session.updated", planMode: false });
    expect(logged("session/set_mode").map((m) => m.params.modeId)).toEqual(["plan", "default"]);
    await session.setPlanMode?.(true);
    expect(logged("session/set_mode").at(-1)?.params.modeId).toBe("plan");
    expect(validateEventStream(reader.all)).toEqual([]);
  });

  it("says plan mode is off when Gemini CLI lists no plan mode", async () => {
    const { adapter } = await open([chunk("ok")], { env: { FAKE_GEMINI_NO_PLAN: "1" } });
    expect(adapter.capabilities().planMode).toBe(false);
  });

  it("resumes with session/load without replaying the old history", async () => {
    const { session, reader } = await open([chunk("Welcome back.")], { resumeToken: "gem-old" });
    expect(session.resumeToken()).toBe("gem-old");
    expect(logged("session/load")[0]?.params).toMatchObject({ sessionId: "gem-old", cwd: dir });
    expect(logged("session/new")).toEqual([]);
    await reader.turn("Continue");
    const texts = (
      completedOf(reader.all, "assistant_message") as ItemOf<"assistant_message">[]
    ).map((m) => m.text);
    expect(texts).toEqual(["Welcome back."]);
  });

  it("explains how to sign in when Gemini CLI has no login", async () => {
    const adapter = new GeminiAdapter({ executable: fakeGemini });
    await expect(
      adapter.openSession(options([], { env: { FAKE_GEMINI_AUTH: "missing" } })),
    ).rejects.toMatchObject({
      code: "not_logged_in",
      kind: "auth",
      message: expect.stringMatching(/not signed in.*Run `gemini`/),
    });
  });
});

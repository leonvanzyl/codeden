import { AgentEvent, type AutonomyLevel, type RuntimeResponse } from "@codeden/contracts";
import { describe, expect, it } from "vitest";
import { ApprovalBroker } from "../src/approvals";
import { handleServerRequest } from "../src/codex/approvals";
import type { ServerRequest } from "../src/codex/protocol";

const T = "thread-x";
const TURN = "turn-1";

/**
 * What Codex (0.160.1, `tool_call_mcp_elicitation` on: stable and on by default) sends when one
 * of the user's MCP tools needs approval: a form elicitation with an empty schema, marked as a
 * tool approval in `_meta` (`request_mcp_tool_user_approval` in `codex-rs/core/src/mcp_tool_call.rs`).
 */
const toolApproval = (meta: Record<string, unknown> = {}) => ({
  method: "mcpServer/elicitation/request",
  id: 7,
  params: {
    threadId: T,
    turnId: TURN,
    serverName: "postgres",
    mode: "form",
    message: 'Allow the postgres MCP server to run tool "run_query"?',
    requestedSchema: { type: "object", properties: {} },
    _meta: {
      codex_approval_kind: "mcp_tool_call",
      persist: "session",
      tool_params: { sql: "DELETE FROM users" },
      ...meta,
    },
  },
});

/** An ordinary MCP elicitation: the server asks the user to fill in a form. */
const form = (requestedSchema: object, turnId: string | null = TURN) => ({
  method: "mcpServer/elicitation/request",
  id: 8,
  params: {
    threadId: T,
    turnId,
    serverName: "deploy",
    mode: "form",
    message: "Where should I deploy?",
    requestedSchema,
    _meta: null,
  },
});

const link = (url: string) => ({
  method: "mcpServer/elicitation/request",
  id: 9,
  params: {
    threadId: T,
    turnId: TURN,
    serverName: "github",
    mode: "url",
    message: "Sign in to GitHub to continue.",
    url,
    elicitationId: "e1",
    _meta: null,
  },
});

const open = (req: object, autonomy: AutonomyLevel = "supervised") => {
  const events: AgentEvent[] = [];
  const broker = new ApprovalBroker((e) => events.push(AgentEvent.parse(e)));
  const pending = handleServerRequest(req as ServerRequest, {
    broker,
    risk: { cwd: "/w", platform: "linux" },
    autonomy: () => autonomy,
    ctx: () => ({ threadId: "s1:thread-root", turnId: TURN }),
    filePaths: () => undefined,
  });
  let settled: unknown;
  void pending.then((r) => {
    settled = r;
  });
  const started = () => {
    const e = events.find((e) => e.type === "item.started");
    if (e?.type !== "item.started" || !("requestId" in e.item)) throw new Error("nothing asked");
    return e.item;
  };
  const answer = (response: RuntimeResponse) => {
    broker.respond(started().requestId, response);
    return pending;
  };
  return { events, pending, settled: () => settled, started, answer };
};

/** The error `fn` throws (an answer the broker rejects), or undefined. */
const rejection = (fn: () => unknown): { code?: string; message: string } | undefined => {
  try {
    fn();
  } catch (error) {
    return error as { code?: string; message: string };
  }
  return undefined;
};

describe("Codex MCP tool approvals", () => {
  it("asks the user about an MCP tool call instead of declining it", async () => {
    const { settled, started, answer } = open(toolApproval());
    await Promise.resolve();
    // Nothing may answer for the user before they have seen the request.
    expect(settled()).toBeUndefined();
    expect(started()).toMatchObject({
      kind: "approval_request",
      status: "in_progress",
      action: "tool",
      title: "Use postgres: run_query",
      toolName: "mcp__postgres__run_query",
      toolInput: { sql: "DELETE FROM users" },
      options: ["allow_once", "allow_session", "deny"],
    });
    expect(await answer({ kind: "approval", decision: "allow_session" })).toMatchObject({
      action: "accept",
      _meta: { persist: "session" },
    });
  });

  it("passes a denial or a withdrawn request back to Codex", async () => {
    const denied = open(toolApproval());
    expect(await denied.answer({ kind: "approval", decision: "deny" })).toEqual({
      action: "decline",
      content: null,
      _meta: null,
    });
    const once = open(toolApproval({ persist: undefined }));
    // Codex offered no session approval, so neither does the card.
    expect(once.started()).toMatchObject({ options: ["allow_once", "deny"] });
    expect(await once.answer({ kind: "approval", decision: "allow_once" })).toEqual({
      action: "accept",
      content: {},
      _meta: null,
    });
    const withdrawn = open(toolApproval());
    expect(await withdrawn.answer({ kind: "cancel" })).toMatchObject({ action: "cancel" });
  });

  it("approves MCP tool calls by policy under Auto and Full, and records it", async () => {
    for (const level of ["auto", "full"] as const) {
      const { events, pending } = open(toolApproval(), level);
      expect(await pending).toEqual({ action: "accept", content: {}, _meta: null });
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        type: "item.completed",
        item: { kind: "approval_request", decision: "allow_once", decidedBy: "policy" },
      });
    }
  });

  it("declines MCP tool calls under Read-only, with the reason", async () => {
    const { events, pending } = open(toolApproval(), "read_only");
    expect(await pending).toMatchObject({ action: "decline" });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: "item.completed",
      item: {
        status: "declined",
        decision: "deny",
        decidedBy: "policy",
        reason: expect.stringMatching(/read-only/),
      },
    });
  });

  it("still asks under Full when the call is marked for the user's own answer", async () => {
    const { settled, started } = open(toolApproval({ codex_sensitive_action: true }), "full");
    await Promise.resolve();
    expect(settled()).toBeUndefined();
    expect(started()).toMatchObject({ kind: "approval_request", status: "in_progress" });
  });
});

describe("Codex MCP server forms", () => {
  const schema = {
    type: "object",
    properties: {
      environment: {
        type: "string",
        title: "Environment",
        oneOf: [
          { const: "stg", title: "Staging" },
          { const: "prod", title: "Production" },
        ],
      },
      replicas: { type: "integer", title: "Replicas" },
      notify: { type: "boolean", description: "Tell the team when it's done?" },
      regions: { type: "array", items: { type: "string", enum: ["eu", "us"] } },
      note: { type: "string" },
    },
    required: ["environment", "replicas"],
  };

  it("asks the user to fill in the form and sends the answers as its content", async () => {
    const { settled, started, answer } = open(form(schema), "full");
    await Promise.resolve();
    // A form is the user's to fill in, at every level.
    expect(settled()).toBeUndefined();
    const question = started();
    expect(question).toMatchObject({ kind: "user_question", mcpServer: "deploy" });
    if (question.kind !== "user_question") throw new Error("not a question");
    expect(question.questions.map((q) => q.id)).toEqual([
      "environment",
      "replicas",
      "notify",
      "regions",
      "note",
    ]);
    expect(question.questions[0]).toMatchObject({
      header: "Environment",
      question: "deploy asks: Where should I deploy? — Environment",
      options: [{ label: "Staging" }, { label: "Production" }],
      allowFreeText: false,
    });
    expect(question.questions[3]).toMatchObject({
      multiSelect: true,
      options: [{ label: "eu" }, { label: "us" }, { label: "Leave empty" }],
    });
    const result = await answer({
      kind: "answer",
      answers: {
        environment: ["Production"],
        replicas: ["3"],
        notify: ["No"],
        regions: ["eu", "us"],
        note: ["Leave empty"],
      },
    });
    expect(result).toEqual({
      action: "accept",
      content: { environment: "prod", replicas: 3, notify: false, regions: ["eu", "us"] },
      _meta: null,
    });
  });

  it("sends the value of the option picked, even when its label reads as another's value", async () => {
    const tricky = {
      type: "object",
      properties: {
        environment: {
          type: "string",
          oneOf: [
            { const: "prod", title: "Production" },
            { const: "stg", title: "prod" },
          ],
        },
        regions: {
          type: "array",
          items: {
            anyOf: [
              { const: "eu", title: "us" },
              { const: "us", title: "eu" },
              { const: "ap", title: "eu" },
            ],
          },
        },
      },
      required: ["environment", "regions"],
    };
    const { started, answer } = open(form(tricky));
    const question = started();
    if (question.kind !== "user_question") throw new Error("not a question");
    // Every label names one option.
    expect(question.questions.map((q) => q.options.map((o) => o.label))).toEqual([
      ["Production", "prod"],
      ["us", "eu", "eu (ap)"],
    ]);
    const result = await answer({
      kind: "answer",
      answers: { environment: ["prod"], regions: ["us", "eu", "eu (ap)"] },
    });
    expect(result).toMatchObject({
      action: "accept",
      content: { environment: "stg", regions: ["eu", "us", "ap"] },
    });
  });

  it("returns cancel when the form is dismissed, and records it as dismissed", async () => {
    const dismissed = open(form(schema));
    expect(await dismissed.answer({ kind: "cancel" })).toMatchObject({ action: "cancel" });
    expect(dismissed.events.at(-1)).toMatchObject({ item: { status: "cancelled" } });
  });

  it("never declines a form the user answered because one answer doesn't parse (#235)", async () => {
    const amount = {
      type: "object",
      properties: {
        environment: schema.properties.environment,
        budget: { type: "number", title: "Budget" },
      },
      required: ["environment", "budget"],
    };
    const answers = (budget: string) => ({ environment: ["Production"], budget: [budget] });
    // How people write numbers is understood: the server gets the number.
    const thousand = open(form(amount));
    expect(thousand.started()).toMatchObject({ questions: [{}, { format: "number" }] });
    expect(await thousand.answer({ kind: "answer", answers: answers("1,000") })).toEqual({
      action: "accept",
      content: { environment: "prod", budget: 1000 },
      _meta: null,
    });
    // Anything else is rejected with what the field takes, and the form stays open: the card
    // isn't marked answered and the server gets nothing until the answer fits.
    for (const typed of ["10 items", "five"]) {
      const { events, answer, settled } = open(form(amount));
      expect(rejection(() => answer({ kind: "answer", answers: answers(typed) }))).toMatchObject({
        code: "invalid_answer",
        message: `Budget: "${typed}" isn't a number. Type a number, like 2.5 or 1,000.`,
      });
      await new Promise((resolve) => setImmediate(resolve));
      expect(settled()).toBeUndefined();
      expect(events.some((e) => e.type === "item.completed")).toBe(false);
      expect(await answer({ kind: "answer", answers: answers("10") })).toMatchObject({
        action: "accept",
        content: { budget: 10 },
      });
    }
  });

  it("names every field an answer doesn't fit, including a required one left out", () => {
    const { answer, settled } = open(form(schema));
    const error = rejection(() =>
      answer({ kind: "answer", answers: { environment: ["Moon"], replicas: ["two"] } }),
    );
    expect(error?.message).toBe(
      [
        'Environment: "Moon" isn\'t one of the options. Pick one of: Staging, Production.',
        'Replicas: "two" isn\'t a whole number. Type a whole number, like 3 or 1,000.',
      ].join("\n"),
    );
    expect(rejection(() => answer({ kind: "answer", answers: {} }))?.message).toBe(
      "Environment: needs an answer.\nReplicas: needs an answer.",
    );
    expect(settled()).toBeUndefined();
  });

  it("confirms a form without fields with Accept or Decline, and records a Decline", async () => {
    const empty = { type: "object", properties: {} };
    const yes = open(form(empty));
    expect(yes.started()).toMatchObject({
      questions: [{ id: "confirm", options: [{ label: "Accept" }, { label: "Decline" }] }],
    });
    expect(await yes.answer({ kind: "answer", answers: { confirm: ["Accept"] } })).toMatchObject({
      action: "accept",
      content: {},
    });
    expect(yes.events.at(-1)).toMatchObject({ item: { status: "completed" } });
    const no = open(form(empty));
    // Only Accept or Decline: anything else is no refusal.
    expect(
      rejection(() => no.answer({ kind: "answer", answers: { confirm: ["sure, go"] } })),
    ).toMatchObject({ code: "invalid_answer" });
    expect(await no.answer({ kind: "answer", answers: { confirm: ["Decline"] } })).toMatchObject({
      action: "decline",
    });
    // The card says the server was turned down, not that the form was filled in.
    expect(no.events.at(-1)).toMatchObject({
      item: { status: "declined", answers: { confirm: ["Decline"] } },
    });
  });

  it("declines an elicitation outside a turn, with nothing to show it in", async () => {
    const { events, pending } = open(form(schema, null));
    expect(await pending).toMatchObject({ action: "decline" });
    expect(events).toHaveLength(0);
  });
});

describe("Codex MCP links", () => {
  it("shows the link the server asks the user to open, and opens nothing itself", async () => {
    const url = "https://github.com/login/device?code=ABCD";
    const accepted = open(link(url), "full");
    expect(accepted.started()).toMatchObject({
      kind: "approval_request",
      action: "network",
      title: "github asks you to open github.com",
      reason: "Sign in to GitHub to continue.",
      url,
      options: ["allow_once", "deny"],
    });
    expect(await accepted.answer({ kind: "approval", decision: "allow_once" })).toEqual({
      action: "accept",
      content: null,
      _meta: null,
    });
    const denied = open(link(url)).answer({ kind: "approval", decision: "deny" });
    expect(await denied).toMatchObject({ action: "decline" });
  });

  it("declines links that aren't web links without showing them", async () => {
    for (const url of ["javascript:alert(1)", "file:///etc/passwd", "not a url"]) {
      const { events, pending } = open(link(url));
      expect(await pending).toMatchObject({ action: "decline" });
      expect(events).toHaveLength(0);
    }
  });
});

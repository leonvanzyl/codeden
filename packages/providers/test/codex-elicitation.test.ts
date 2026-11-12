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

  it("returns cancel when the form is dismissed and decline when an answer doesn't fit", async () => {
    expect(await open(form(schema)).answer({ kind: "cancel" })).toMatchObject({
      action: "cancel",
    });
    const wrong = open(form(schema)).answer({
      kind: "answer",
      answers: { environment: ["Staging"], replicas: ["two"] },
    });
    expect(await wrong).toMatchObject({ action: "decline", content: null });
  });

  it("confirms a form without fields with Accept or Decline", async () => {
    const empty = { type: "object", properties: {} };
    const yes = open(form(empty));
    expect(yes.started()).toMatchObject({
      questions: [{ id: "confirm", options: [{ label: "Accept" }, { label: "Decline" }] }],
    });
    expect(await yes.answer({ kind: "answer", answers: { confirm: ["Accept"] } })).toMatchObject({
      action: "accept",
      content: {},
    });
    const no = open(form(empty)).answer({ kind: "answer", answers: { confirm: ["Decline"] } });
    expect(await no).toMatchObject({ action: "decline" });
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

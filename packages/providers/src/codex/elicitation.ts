import { randomUUID } from "node:crypto";
import type { AnswerReview } from "../approvals";
import { shorten, toJson } from "../util/text";
import {
  type ApprovalContext,
  type ApprovalItem,
  approvedByPolicy,
  decisionOf,
} from "./approval-context";
import {
  ACCEPT,
  CONFIRM_ID,
  DECLINE,
  type FormField,
  formContent,
  formFields,
  formQuestions,
} from "./elicitation-form";
import type { JsonValue } from "./protocol/serde_json/JsonValue";
import type {
  McpServerElicitationRequestParams,
  McpServerElicitationRequestResponse,
} from "./protocol/v2";

/**
 * MCP elicitations Codex forwards (`mcpServer/elicitation/request`, §11.2):
 * - Codex's own approval for one of the user's MCP tools: an empty form whose `_meta` says
 *   `codex_approval_kind: "mcp_tool_call"`. Decided like any other tool call (approved by policy
 *   under Auto and Full, a card naming the server, tool and arguments under Supervised, declined
 *   under Read-only).
 * - A server's form: a question card built from its schema; the answers go back as its content.
 * - A server's link (URL mode, to sign in, say): a card showing it, which the user opens.
 * Anything else is declined, as before.
 */

type Params = McpServerElicitationRequestParams;
type Response = McpServerElicitationRequestResponse;
type Meta = { [key: string]: JsonValue | undefined };
type Where = { threadId: string; turnId: string };

const accept = (content: JsonValue, meta: JsonValue = null): Response => ({
  action: "accept",
  content,
  _meta: meta,
});
const DECLINED: Response = { action: "decline", content: null, _meta: null };
const CANCELLED: Response = { action: "cancel", content: null, _meta: null };

const READ_ONLY =
  "This session has read-only permissions: it can't run MCP tools that may change things.";

export async function handleElicitation(p: Params, ac: ApprovalContext): Promise<Response> {
  // Outside a turn nothing waits on it, and there is no turn to show it in.
  if (!p.turnId) return DECLINED;
  const where = { threadId: p.threadId, turnId: p.turnId };
  if (p.mode === "url") return openLink(p, where, ac);
  const meta = asMeta(p._meta);
  if (meta.codex_approval_kind === "mcp_tool_call") return toolApproval(p, meta, where, ac);
  if (p.mode === "form") return fillForm(p, where, ac);
  // The `openai/form` modes come only to clients that opt in to them, which CodeDen doesn't.
  return DECLINED;
}

/**
 * Codex asks before it runs one of the user's MCP tools that isn't marked read-only (its
 * `tool_call_mcp_elicitation` feature, on by default).
 */
async function toolApproval(
  p: Params,
  meta: Meta,
  where: Where,
  ac: ApprovalContext,
): Promise<Response> {
  const server = p.serverName;
  const tool =
    text(meta.tool_name) ?? text(meta.tool_title) ?? /run tool "([^"]+)"/.exec(p.message)?.[1];
  const persist = meta.persist;
  const offersSession =
    persist === "session" || (Array.isArray(persist) && persist.includes("session"));
  const requestId = newRequestId();
  const item: ApprovalItem = {
    id: `approval-${requestId}`,
    kind: "approval_request",
    status: "in_progress",
    requestId,
    action: "tool",
    title: tool ? `Use ${server}: ${shorten(tool, 80)}` : `Use a tool of ${server}`,
    ...(p.message.trim() ? { reason: p.message.trim() } : {}),
    ...(tool ? { toolName: `mcp__${server}__${tool}` } : {}),
    ...(meta.tool_params !== undefined ? { toolInput: toJson(meta.tool_params) } : {}),
    options: offersSession ? ["allow_once", "allow_session", "deny"] : ["allow_once", "deny"],
  };
  const ctx = ac.ctx(where.threadId, where.turnId);
  if ((ac.autonomy?.() ?? "supervised") === "read_only") {
    ac.broker.record(ctx, {
      ...item,
      status: "declined",
      reason: READ_ONLY,
      decision: "deny",
      decidedBy: "policy",
    });
    return DECLINED;
  }
  // Marked as needing the user's own answer, so never decided by policy.
  const userOnly = meta.codex_sensitive_action === true || meta.codex_requires_user_input === true;
  if (!userOnly && approvedByPolicy(ac, where, item, { risky: false })) return accept({});
  const decision = decisionOf(await ac.broker.request(ctx, item));
  if (decision === "allow_session" && offersSession) return accept({}, { persist: "session" });
  if (decision === "allow_once" || decision === "allow_session") return accept({});
  return decision === "deny" ? DECLINED : CANCELLED;
}

/**
 * A server's form: a question card built from its schema, the answers sent as its content. An
 * answer that doesn't fit its field is rejected with what the field takes and the card stays
 * open: the server never gets a refusal the user didn't give. Only the confirmation's Decline
 * declines, and the card records it as declined.
 */
async function fillForm(
  p: Extract<Params, { mode: "form" }>,
  where: Where,
  ac: ApprovalContext,
): Promise<Response> {
  const fields = formFields(p.requestedSchema);
  const requestId = newRequestId();
  const confirmed = (answers: Record<string, string[]>) =>
    answers[CONFIRM_ID]?.includes(ACCEPT) === true;
  const review: AnswerReview =
    fields.length === 0
      ? {
          problem: (r) =>
            r.kind === "answer" && !isConfirmation(r.answers[CONFIRM_ID])
              ? `Answer ${ACCEPT} or ${DECLINE}.`
              : undefined,
          declines: (r) => r.kind === "answer" && !confirmed(r.answers),
        }
      : { problem: (r) => (r.kind === "answer" ? problemsOf(fields, r.answers) : undefined) };
  const response = await ac.broker.request(
    ac.ctx(where.threadId, where.turnId),
    {
      id: `question-${requestId}`,
      kind: "user_question",
      status: "in_progress",
      requestId,
      mcpServer: p.serverName,
      questions: formQuestions(p.serverName, p.message, fields),
    },
    undefined,
    review,
  );
  if (response.kind !== "answer") return CANCELLED;
  if (fields.length === 0) return confirmed(response.answers) ? accept({}) : DECLINED;
  const result = formContent(fields, response.answers);
  // The review let only fitting answers through; withdraw rather than refuse if one slipped by.
  return "content" in result ? accept(result.content) : CANCELLED;
}

const isConfirmation = (answer: string[] | undefined) =>
  answer?.length === 1 && (answer[0] === ACCEPT || answer[0] === DECLINE);

function problemsOf(fields: FormField[], answers: Record<string, string[]>): string | undefined {
  const result = formContent(fields, answers);
  return "problems" in result ? result.problems.join("\n") : undefined;
}

/**
 * A server asks the user to open a link (to sign in, say). The card shows the link and the user
 * opens it: never decided by policy, and nothing opens it on the user's behalf.
 */
async function openLink(
  p: Extract<Params, { mode: "url" }>,
  where: Where,
  ac: ApprovalContext,
): Promise<Response> {
  const url = webUrl(p.url);
  if (!url) return DECLINED;
  const requestId = newRequestId();
  const response = await ac.broker.request(ac.ctx(where.threadId, where.turnId), {
    id: `approval-${requestId}`,
    kind: "approval_request",
    status: "in_progress",
    requestId,
    action: "network",
    title: `${p.serverName} asks you to open ${url.host}`,
    ...(p.message.trim() ? { reason: p.message.trim() } : {}),
    url: url.href,
    options: ["allow_once", "deny"],
  });
  const decision = decisionOf(response);
  if (decision === "allow_once" || decision === "allow_session") return accept(null);
  return decision === "deny" ? DECLINED : CANCELLED;
}

/** Elicitations carry no item id, and app-server request ids restart with each process. */
const newRequestId = () => `mcp-${randomUUID()}`;

function asMeta(value: JsonValue | null): Meta {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function text(value: JsonValue | undefined): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

/** Web links only: a card never links to a script or a local file. */
function webUrl(raw: string): URL | undefined {
  try {
    const url = new URL(raw);
    return url.protocol === "https:" || url.protocol === "http:" ? url : undefined;
  } catch {
    return undefined;
  }
}

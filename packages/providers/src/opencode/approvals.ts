import path from "node:path";
import type { ItemOf, RuntimeResponse, UserQuestion } from "@codeden/contracts";
import type { ApprovalBroker } from "../approvals";
import { shorten, toJson } from "../util/text";
import { type OpenCodeClient, seg } from "./client";
import type { OpenCodeEventMapper } from "./mapper";
import {
  commandOf,
  EDIT_TOOLS,
  type OpenCodePolicy,
  type PermissionCall,
  type PolicyDecision,
} from "./policy";
import type { OcForm, OcFormField, OcFormValue, OcPermissionRequest } from "./protocol";

/** What the approval handlers need from the session. */
export interface ApprovalDeps {
  client: () => OpenCodeClient | undefined;
  broker: ApprovalBroker;
  policy: OpenCodePolicy;
  mapper: OpenCodeEventMapper;
  cwd: string;
}

/** Told to the agent when CodeDen or the user refuses a call; OpenCode then carries on. */
const DENIED = "The user denied this action.";

/**
 * Answer an OpenCode permission request (§11.2): CodeDen's policy approves or refuses it on
 * the spot, or it becomes an `approval_request` the user answers. A refusal always carries a
 * message, so the agent learns why and its turn continues (a bare reject ends the turn).
 * `allow_session` is remembered by CodeDen for this session only; OpenCode's own "always"
 * would save the rule for the whole project, so it is never sent.
 */
export async function handlePermission(
  req: OcPermissionRequest,
  deps: ApprovalDeps,
): Promise<void> {
  const tool = deps.mapper.tool(req.source?.id);
  deps.mapper.noteDiffs(req.source?.id, req.metadata);
  const call: PermissionCall = {
    request: req,
    ...(tool ? { toolName: tool.name, toolInput: tool.input } : {}),
  };
  const decision = deps.policy.decide(call);
  if (decision.kind === "allow") return reply(deps, req, { decision: "once" });
  if (decision.kind === "deny")
    return reply(deps, req, { decision: "reject", message: decision.message });
  const ctx = deps.mapper.ctxFor(req.sessionID);
  if (!ctx) return reply(deps, req, { decision: "reject", message: "No turn is running." });
  const response = await deps.broker.request(ctx, approvalItem(call, decision, deps.cwd));
  if (response.kind === "approval" && response.decision !== "deny") {
    if (response.decision === "allow_session") deps.policy.allowForSession(call);
    return reply(deps, req, { decision: "once" });
  }
  const message =
    response.kind === "approval" && response.message?.trim() ? response.message.trim() : DENIED;
  return reply(deps, req, { decision: "reject", message });
}

async function reply(
  deps: ApprovalDeps,
  req: OcPermissionRequest,
  body: { decision: "once" | "reject"; message?: string },
): Promise<void> {
  try {
    await deps
      .client()
      ?.post(`/api/session/${seg(req.sessionID)}/permission/${seg(req.id)}/reply`, body);
  } catch {
    // The request is gone (turn interrupted, server restarted); nothing waits for it.
  }
}

/** The approval card for a permission request. */
export function approvalItem(
  call: PermissionCall,
  decision: Extract<PolicyDecision, { kind: "ask" }>,
  cwd: string,
): ItemOf<"approval_request"> {
  const { request } = call;
  const base = {
    id: `approval-${request.id}`,
    kind: "approval_request" as const,
    status: "in_progress" as const,
    requestId: request.id,
    action: decision.action,
    reason: decision.reason,
    ...(call.toolName ? { toolName: call.toolName } : {}),
    ...(call.toolInput ? { toolInput: toJson(call.toolInput) } : {}),
    ...(request.source?.id ? { toolCallItemId: request.source.id } : {}),
    options: ["allow_once", "allow_session", "deny"] as ItemOf<"approval_request">["options"],
  };
  switch (request.action) {
    case "shell": {
      const command = commandOf(call);
      const workdir =
        typeof call.toolInput?.workdir === "string" ? call.toolInput.workdir : undefined;
      return {
        ...base,
        title: `Run \`${shorten(command, 100)}\``,
        command,
        cwd: workdir ? path.resolve(cwd, workdir) : cwd,
      };
    }
    case "edit": {
      const paths = request.resources.map((p) => path.resolve(cwd, p));
      return {
        ...base,
        title: paths.length === 1 ? `Edit ${paths[0]}` : `Edit ${paths.length} files`,
        paths,
      };
    }
    case "external_directory": {
      const dirs = request.resources.map((r) => r.replace(/[\\/]\*$/, ""));
      const verb = call.toolName && EDIT_TOOLS.has(call.toolName) ? "Write in" : "Access";
      return { ...base, title: `${verb} ${dirs.join(", ")}`, paths: dirs };
    }
    case "webfetch":
      return { ...base, title: `Fetch ${shorten(request.resources[0] ?? "", 100)}` };
    case "read":
      return { ...base, title: `Read ${request.resources.join(", ")}`, paths: request.resources };
    default:
      return {
        ...base,
        title:
          request.message ||
          `Allow ${request.action} (${shorten(request.resources.join(", "), 80)})`,
      };
  }
}

/**
 * Answer an OpenCode form: the `question` tool's questions and other structured input become
 * one `user_question`. Cancelling (interrupt, close) cancels the form.
 */
export async function handleForm(form: OcForm, deps: ApprovalDeps): Promise<void> {
  const ctx = deps.mapper.ctxFor(form.sessionID);
  const fields = form.fields.filter((f) => !f.hidden && f.type !== "external");
  const questions = fields.map((f) => questionOf(f, form, fields.length));
  if (!ctx || !questions.length) return cancelForm(deps, form);
  const response = await deps.broker.request(ctx, {
    id: `question-${form.id}`,
    kind: "user_question",
    status: "in_progress",
    requestId: form.id,
    questions: questions as [UserQuestion, ...UserQuestion[]],
  });
  if (response.kind !== "answer") return cancelForm(deps, form);
  try {
    await deps.client()?.post(`/api/session/${seg(form.sessionID)}/form/${seg(form.id)}/reply`, {
      answer: formAnswer(fields, response),
    });
  } catch {
    // The form is gone (turn interrupted, server restarted).
  }
}

async function cancelForm(deps: ApprovalDeps, form: OcForm): Promise<void> {
  try {
    await deps.client()?.delete(`/api/session/${seg(form.sessionID)}/form/${seg(form.id)}`);
  } catch {
    // Already answered or gone.
  }
}

const YES = "Yes";
const NO = "No";

/** One form field as a CodeDen question. */
export function questionOf(field: OcFormField, form: OcForm, count: number): UserQuestion {
  const options =
    field.type === "boolean"
      ? [{ label: YES }, { label: NO }]
      : (field.options ?? []).map((o) => ({
          label: o.label,
          ...(o.description ? { description: o.description } : {}),
        }));
  const header = field.title ?? (count === 1 ? form.title : undefined);
  return {
    id: field.key,
    ...(header ? { header: shorten(header, 40) } : {}),
    question: field.description || field.title || form.title,
    options,
    multiSelect: field.type === "multiselect",
    allowFreeText: field.type !== "boolean" && (field.custom === true || options.length === 0),
  };
}

/** CodeDen answers -> OpenCode form answer, by field type. Option labels map to values. */
export function formAnswer(
  fields: readonly OcFormField[],
  response: Extract<RuntimeResponse, { kind: "answer" }>,
): Record<string, OcFormValue> {
  const answer: Record<string, OcFormValue> = {};
  for (const field of fields) {
    const given = response.answers[field.key] ?? [];
    const optionValue = (label: string) =>
      field.options?.find((o) => o.label === label || o.value === label)?.value ?? label;
    if (field.type === "multiselect") {
      answer[field.key] = given.map(optionValue);
    } else if (field.type === "boolean") {
      if (given[0] !== undefined) answer[field.key] = given[0] === YES || given[0] === "true";
    } else if (field.type === "number" || field.type === "integer") {
      const n = Number(given[0]);
      if (given[0] !== undefined && Number.isFinite(n))
        answer[field.key] = field.type === "integer" ? Math.round(n) : n;
    } else if (given[0] !== undefined) {
      answer[field.key] = optionValue(given[0]);
    }
  }
  return answer;
}

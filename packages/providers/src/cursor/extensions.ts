import { existsSync } from "node:fs";
import path from "node:path";
import type { ItemOf, RuntimeResponse, UserQuestion } from "@codeden/contracts";
import type { AcpExtensionHost, AcpExtensions } from "../acp/extensions";
import { type Todo, todoStatus } from "../acp/mapper";
import { agentTypeOf } from "../acp/subagents";
import { num, shorten, str, toJson } from "../util/text";

/** Told to Cursor when the user declines its plan without a note. */
export const KEEP_PLANNING =
  "The user wants you to keep planning. Revise the plan and present it again.";

/**
 * What CodeDen advertises to Cursor in `initialize`: subagents as child sessions (Cursor
 * 2026.09.15 and later). Cursor reads the `_meta` flag; the top-level one is ACP's own.
 */
export const CURSOR_CLIENT_CAPABILITIES: Record<string, unknown> = {
  subagents: {},
  _meta: { subagents: {} },
};

type Params = Record<string, unknown>;

interface CursorQuestion {
  id: string;
  prompt: string;
  options: { id: string; label: string }[];
  allowMultiple?: boolean;
}

const CANCELLED = { outcome: { outcome: "cancelled" } };

/**
 * Cursor's ACP extension methods, mapped onto CodeDen's own features:
 * - `cursor/ask_question`    -> a question card; answers go back as the chosen option ids
 * - `cursor/create_plan`     -> the plan and its todos, then plan mode's plan approval
 * - `cursor/update_todos`    -> the turn's todo list
 * - `cursor/task`            -> a subagent card, for CLIs that don't run subagents as child
 *                               sessions (those that do get child threads from `AcpSubagents`)
 * - `cursor/generate_image`  -> a tool call with the image Cursor wrote (`generatedImages`)
 * The last three arrive as requests or as notifications, depending on the CLI's version.
 */
export const cursorExtensions: AcpExtensions = {
  clientCapabilities: CURSOR_CLIENT_CAPABILITIES,
  request(method, params, host) {
    const p = (params ?? {}) as Params;
    switch (method) {
      case "cursor/ask_question":
        return askQuestion(p, host);
      case "cursor/create_plan":
        return createPlan(p, host);
      case "cursor/update_todos":
        updateTodos(p, host);
        return Promise.resolve({ outcome: { outcome: "accepted" } });
      case "cursor/task":
        return Promise.resolve(task(p, host));
      case "cursor/generate_image": {
        // A file that isn't there: refused, so Cursor falls back on its own.
        const answer = generateImage(p, host, true);
        return answer ? Promise.resolve(answer) : undefined;
      }
      default:
        return undefined;
    }
  },
  notification(method, params, host) {
    const p = (params ?? {}) as Params;
    if (method === "cursor/update_todos") updateTodos(p, host);
    else if (method === "cursor/task") task(p, host);
    else if (method === "cursor/generate_image") generateImage(p, host, false);
  },
};

/**
 * Cursor's report of a subagent task. When Cursor runs subagents as child sessions they
 * already have their cards, and the report only fills in what a card lacks; otherwise the
 * task becomes a card of its own, with a thread holding its prompt and result.
 */
function task(params: Params, host: AcpExtensionHost): unknown {
  const toolCallId = str(params, "toolCallId");
  const description = str(params, "description")?.trim();
  const prompt = str(params, "prompt")?.trim();
  const agentType = agentTypeOf(params.subagentType);
  const durationMs = num(params, "durationMs");
  host.subagents.report(
    {
      ...(toolCallId ? { toolCallId } : {}),
      ...(description ? { description } : {}),
      ...(prompt ? { prompt } : {}),
      ...(agentType ? { agentType } : {}),
      ...(durationMs !== undefined && durationMs >= 0 ? { durationMs } : {}),
    },
    host.mapper,
    !host.childSessions,
  );
  const agentId = str(params, "agentId");
  return {
    outcome: {
      outcome: "completed",
      ...(agentId ? { agentId } : {}),
      ...(durationMs !== undefined ? { durationMs } : {}),
    },
  };
}

/**
 * An image Cursor generated, at `filePath`: shown as a tool call whose `generatedImages`
 * the server stores as an artifact. A request is answered `generated` only when the file
 * exists (undefined otherwise: refused); a notification is shown as reported.
 */
function generateImage(params: Params, host: AcpExtensionHost, request: boolean): unknown {
  const reported = str(params, "filePath")?.trim();
  if (!reported) return undefined;
  const filePath = path.resolve(host.cwd, reported);
  if (request && !existsSync(filePath)) return undefined;
  const description = str(params, "description")?.trim();
  const toolCallId = str(params, "toolCallId") || "image";
  host.mapper.imagesCreated(
    toolCallId,
    [{ path: filePath, ...(description ? { caption: description } : {}) }],
    toJson({
      ...(description ? { description } : {}),
      filePath,
      ...(Array.isArray(params.referenceImagePaths)
        ? { referenceImagePaths: params.referenceImagePaths }
        : {}),
    }),
  );
  return { outcome: { outcome: "generated", filePath } };
}

/** Cursor todos as CodeDen todos. */
export function cursorTodos(value: unknown): Todo[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((t, i): Todo | undefined => {
      const todo = (t ?? {}) as Params;
      const text = typeof todo.content === "string" ? todo.content : undefined;
      if (!text?.trim()) return undefined;
      return {
        id: typeof todo.id === "string" && todo.id ? todo.id : String(i + 1),
        text,
        status: todoStatus(todo.status),
      };
    })
    .filter((t): t is Todo => !!t);
}

function updateTodos(params: Params, host: AcpExtensionHost): void {
  host.mapper.setTodos(cursorTodos(params.todos), params.merge === true);
}

function questionsOf(params: Params): CursorQuestion[] {
  if (!Array.isArray(params.questions)) return [];
  const out: CursorQuestion[] = [];
  for (const raw of params.questions) {
    const q = (raw ?? {}) as Params;
    if (typeof q.id !== "string" || typeof q.prompt !== "string") continue;
    const options = Array.isArray(q.options)
      ? (q.options as Params[])
          .filter((o) => typeof o?.id === "string" && typeof o.label === "string")
          .map((o) => ({ id: o.id as string, label: o.label as string }))
      : [];
    out.push({ id: q.id, prompt: q.prompt, options, allowMultiple: q.allowMultiple === true });
  }
  return out;
}

/**
 * A question card. Cursor takes chosen option ids only, so free text is offered just for
 * questions without options, and sent back as the reason the questions were skipped.
 */
async function askQuestion(params: Params, host: AcpExtensionHost): Promise<unknown> {
  const ctx = host.ctx();
  const questions = questionsOf(params);
  if (!ctx || !questions.length) return CANCELLED;
  const title = typeof params.title === "string" ? params.title : undefined;
  const requestId = `question-${String(params.toolCallId ?? "cursor")}-${Math.random().toString(36).slice(2, 8)}`;
  const response = await host.broker.request(ctx, {
    id: requestId,
    kind: "user_question",
    status: "in_progress",
    requestId,
    questions: questions.map(
      (q): UserQuestion => ({
        id: q.id,
        ...(title && questions.length === 1 ? { header: shorten(title, 40) } : {}),
        question: q.prompt,
        options: q.options.map((o) => ({ label: o.label })),
        multiSelect: q.allowMultiple === true,
        allowFreeText: q.options.length === 0,
      }),
    ) as [UserQuestion, ...UserQuestion[]],
  });
  return questionAnswer(questions, response);
}

/** CodeDen's answer as Cursor's: chosen option ids per question, else skipped with the text. */
export function questionAnswer(questions: readonly CursorQuestion[], response: RuntimeResponse) {
  if (response.kind !== "answer") return CANCELLED;
  const answers: { questionId: string; selectedOptionIds: string[] }[] = [];
  const freeText: string[] = [];
  for (const q of questions) {
    const given = response.answers[q.id] ?? [];
    const ids: string[] = [];
    for (const value of given) {
      const option = q.options.find((o) => o.label === value || o.id === value);
      if (option) ids.push(option.id);
      else if (value.trim()) freeText.push(value.trim());
    }
    if (ids.length) answers.push({ questionId: q.id, selectedOptionIds: ids });
  }
  if (!answers.length) {
    return {
      outcome: { outcome: "skipped", ...(freeText.length ? { reason: freeText.join("\n") } : {}) },
    };
  }
  return { outcome: { outcome: "answered", answers } };
}

/** The plan as markdown: its name, overview and body. */
export function planMarkdown(params: Params): string {
  const name = typeof params.name === "string" ? params.name.trim() : "";
  const overview = typeof params.overview === "string" ? params.overview.trim() : "";
  const plan = typeof params.plan === "string" ? params.plan.trim() : "";
  return [name ? `# ${name}` : "", overview, plan].filter(Boolean).join("\n\n");
}

/**
 * Cursor's finished plan: shown as a plan with its todos, then, in plan mode, a plan approval.
 * Approving leaves plan mode for the session's level and accepts the plan; declining keeps
 * Cursor planning with the user's note. Outside plan mode the plan is shown and accepted.
 */
async function createPlan(params: Params, host: AcpExtensionHost): Promise<unknown> {
  const ctx = host.ctx();
  if (!ctx) return CANCELLED;
  const toolCallId = String(params.toolCallId ?? "plan");
  const planId = host.mapper.toolItemId(`plan-${toolCallId}`);
  const text = planMarkdown(params);
  if (text) {
    const item: ItemOf<"plan"> = {
      id: planId,
      kind: "plan",
      status: "completed",
      text,
    };
    host.mapper.emitItem(item);
  }
  const todos = cursorTodos(params.todos);
  if (todos.length) host.mapper.setTodos(todos, false);
  if (!host.planning) return { outcome: { outcome: "accepted" } };
  const requestId = `plan-${toolCallId}-${Math.random().toString(36).slice(2, 8)}`;
  const name = typeof params.name === "string" && params.name.trim() ? params.name.trim() : "";
  const response = await host.broker.request(ctx, {
    id: `approval-${requestId}`,
    kind: "approval_request",
    status: "in_progress",
    requestId,
    action: "plan",
    title: name ? `Implement the plan: ${shorten(name, 80)}` : "Implement the plan",
    reason: "The agent finished planning",
    toolName: "create_plan",
    toolCallItemId: planId,
    options: ["allow_once", "deny"],
  });
  if (response.kind === "approval" && response.decision !== "deny") {
    await host.exitPlanMode();
    return { outcome: { outcome: "accepted" } };
  }
  if (response.kind === "approval") {
    return { outcome: { outcome: "rejected", reason: response.message?.trim() || KEEP_PLANNING } };
  }
  return CANCELLED;
}

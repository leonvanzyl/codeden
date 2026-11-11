import type { PermissionResult } from "@anthropic-ai/claude-agent-sdk";
import type { UserQuestion } from "@codeden/contracts";
import type { ApprovalBroker } from "../approvals";
import { str } from "../util/text";
import type { ClaudeEventMapper } from "./mapper";

/**
 * AskUserQuestion: show Claude's questions as a `user_question` item and hand the answers back
 * as the tool's input (keyed by question text, as the CLI expects).
 */
export async function askQuestion(
  deps: { broker: ApprovalBroker; mapper: ClaudeEventMapper },
  input: Record<string, unknown>,
  toolUseId: string,
  signal: AbortSignal,
): Promise<PermissionResult> {
  const raw = Array.isArray(input.questions) ? (input.questions as Record<string, unknown>[]) : [];
  const questions: UserQuestion[] = raw.map((q, i) => ({
    id: `q${i + 1}`,
    header: str(q, "header"),
    question: str(q, "question") ?? "",
    options: (Array.isArray(q.options) ? (q.options as Record<string, unknown>[]) : []).map(
      (o) => ({
        label: str(o, "label") ?? "",
        ...(str(o, "description") ? { description: str(o, "description") } : {}),
      }),
    ),
    multiSelect: q.multiSelect === true,
    allowFreeText: true,
  }));
  if (questions.length === 0) return { behavior: "allow", updatedInput: input };
  const ctx = deps.mapper.ctxForTool(toolUseId);
  const response = await deps.broker.request(
    ctx,
    {
      id: `question-${toolUseId}`,
      kind: "user_question",
      status: "in_progress",
      requestId: toolUseId,
      questions,
    },
    signal,
  );
  if (response.kind !== "answer") {
    return { behavior: "deny", message: "The user dismissed the question." };
  }
  const answers: Record<string, string> = {};
  for (const q of questions) {
    const picked = response.answers[q.id];
    if (picked?.length) answers[q.question] = picked.join(", ");
  }
  return { behavior: "allow", updatedInput: { ...input, answers } };
}

import type { PermissionMode, PermissionResult } from "@anthropic-ai/claude-agent-sdk";
import type { ItemOf, RuntimeResponse } from "@codeden/contracts";
import { str } from "../util/text";
import { approvalTitle, PLAN_TOOL } from "./tools";

type Input = Record<string, unknown>;

/** Told to Claude when the user declines its plan without a note. */
export const KEEP_PLANNING =
  "The user wants you to keep planning. Revise the plan and present it again with ExitPlanMode.";

/**
 * The plan Claude submits with ExitPlanMode. The CLI fills it in from the plan file for
 * permission checks, even when the model's own tool call carries no plan.
 */
export function planText(input: Input): string | undefined {
  return str(input, "plan")?.trim() || undefined;
}

/** The approval the user answers on the plan card: approve it, or keep planning with a note. */
export function planApprovalItem(requestId: string, input: Input): ItemOf<"approval_request"> {
  return {
    id: `approval-${requestId}`,
    kind: "approval_request",
    status: "in_progress",
    requestId,
    action: "plan",
    title: approvalTitle(PLAN_TOOL, input),
    reason: "The agent finished planning",
    toolName: PLAN_TOOL,
    options: ["allow_once", "deny"],
  };
}

/**
 * Claude's answer for the plan approval. Approving switches the CLI to `mode`, the session's
 * permission level (the CLI applies it before ExitPlanMode runs, so the tool keeps it);
 * declining keeps it planning, with the user's note as the reason.
 */
export function planDecision(
  input: Input,
  response: RuntimeResponse,
  mode: PermissionMode,
): PermissionResult {
  if (response.kind === "approval" && response.decision !== "deny") {
    return {
      behavior: "allow",
      updatedInput: input,
      updatedPermissions: [{ type: "setMode", mode, destination: "session" }],
    };
  }
  if (response.kind === "approval") {
    return { behavior: "deny", message: response.message?.trim() || KEEP_PLANNING };
  }
  return { behavior: "deny", message: "The request was cancelled.", interrupt: true };
}

/** True when an SDK message carries the `tool_result` of `toolUseId`. */
export function carriesToolResult(message: unknown, toolUseId: string): boolean {
  const msg = message as { type?: unknown; message?: { content?: unknown } };
  if (msg?.type !== "user" || !Array.isArray(msg.message?.content)) return false;
  return (msg.message.content as Input[]).some(
    (block) => block?.type === "tool_result" && block.tool_use_id === toolUseId,
  );
}

import path from "node:path";
import type { HookCallback } from "@anthropic-ai/claude-agent-sdk";
import { str } from "../util/text";
import type { ClaudePolicy } from "./permissions";

/** The shell's current directory as Claude reports it: a `cd` in an earlier Bash call persists. */
export interface ShellState {
  dir?: string;
}

/**
 * CodeDen's PreToolUse hook. It sees every tool call, including ones Claude would allow on
 * its own: refusals (read-only, plan mode) are denied outright, and gated calls are sent to
 * `canUseTool` with `ask`, in every permission mode.
 */
export function policyHook(policy: ClaudePolicy, shell: ShellState): HookCallback {
  return async (hookInput) => {
    const name = str(hookInput, "tool_name") ?? "";
    const toolInput = ((hookInput as { tool_input?: unknown }).tool_input ?? {}) as Record<
      string,
      unknown
    >;
    const cwd = str(hookInput, "cwd");
    if (cwd && (path.isAbsolute(cwd) || path.win32.isAbsolute(cwd))) shell.dir = cwd;
    const denied = policy.denial(name, toolInput, shell.dir);
    if (denied) {
      return {
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "deny",
          permissionDecisionReason: denied,
        },
      };
    }
    const gate = policy.gate(name, toolInput, shell.dir);
    if (!gate.ask) return {};
    return {
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "ask",
        permissionDecisionReason: gate.reason,
      },
    };
  };
}

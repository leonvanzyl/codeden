import type { ErrorKind } from "@codeden/contracts";
import { AcpRpcError } from "./rpc";

const AUTH =
  /\bauth|unauthori[sz]ed|not logged in|log ?in required|sign ?in|api key|credential|forbidden/i;
const CONTEXT = /context (window|length)|too long|maximum context|prompt is too long|token limit/i;
const LIMIT =
  /usage limit|rate limit|quota|too many requests|limit reached|exceeded|out of (credits|requests)/i;
const TRANSIENT =
  /overload|unavailable|timeout|timed out|econnreset|connection|network|socket|stream|temporar|try again/i;

/** How a turn on an ACP agent ended. */
export type AcpTurnOutcome =
  | { type: "completed"; stopReason?: string }
  | { type: "interrupted"; reason?: "user" | "provider" | "runner_restart" }
  | {
      type: "failed";
      message: string;
      code?: string;
      detail?: string;
      kind?: ErrorKind;
    };

/**
 * Classify a failed prompt (§7.3 `ErrorInfo.kind`) from the agent's JSON-RPC error: auth
 * failures, a full context, usage limits, and transient trouble (the agent exiting, a dropped
 * connection); anything else is fatal. ACP agents report errors as text, so this reads it.
 */
export function classifyAcpError(error: unknown): ErrorKind {
  const message = error instanceof Error ? error.message : String(error ?? "");
  const data = error instanceof AcpRpcError && error.data !== undefined ? safeJson(error.data) : "";
  const text = `${message} ${data}`;
  if (error instanceof AcpRpcError && error.code === -32000 && /exited|not running/.test(message)) {
    return "transient";
  }
  if (AUTH.test(text)) return "auth";
  if (CONTEXT.test(text)) return "context_full";
  if (LIMIT.test(text)) return "usage_limit";
  if (TRANSIENT.test(text)) return "transient";
  return "fatal";
}

/** A failed prompt as a turn outcome. */
export function failedPrompt(error: unknown, label: string): AcpTurnOutcome {
  const message = error instanceof Error ? error.message : String(error);
  const data =
    error instanceof AcpRpcError && error.data !== undefined ? safeJson(error.data) : undefined;
  return {
    type: "failed",
    code: "prompt_failed",
    message: message || `${label} turn failed`,
    kind: classifyAcpError(error),
    ...(data ? { detail: data.slice(0, 2000) } : {}),
  };
}

/** A `session/prompt` stop reason as a turn outcome. */
export function stopOutcome(stopReason: string | undefined, label: string): AcpTurnOutcome {
  switch (stopReason) {
    case "cancelled":
      return { type: "interrupted", reason: "user" };
    case "refusal":
      return {
        type: "failed",
        code: "refusal",
        message: `${label} refused to continue this turn.`,
        kind: "fatal",
      };
    default:
      return { type: "completed", stopReason: stopReason || "end_turn" };
  }
}

function safeJson(value: unknown): string {
  try {
    return typeof value === "string" ? value : JSON.stringify(value);
  } catch {
    return "";
  }
}

import type { ErrorKind } from "@codeden/contracts";
import type { OcError } from "./protocol";

const CONTEXT = /context (window|length)|too long|maximum context|prompt is too long|token limit/i;
const QUOTA = /quota|usage limit|insufficient|billing|credit|exceeded your/i;
const TRANSIENT =
  /overload|unavailable|timeout|timed out|econnreset|connection|network|socket|stream|temporar/i;
/** An HTTP status OpenCode gave only in the message: "Request failed: 401", "HTTP 403". */
const STATUS_IN_MESSAGE = /\b(?:request failed|status(?: code)?|http)\W{0,3}([1-5]\d\d)\b/i;

/**
 * Classify a failed OpenCode turn (§7.3 `ErrorInfo.kind`) from its structured error: the HTTP
 * status of the model call when there was one (in its own field, or only in the message), its
 * type and its message. `retryAt` is set for a usage limit when OpenCode said how long to wait.
 */
export function classifyOpenCodeError(
  error: OcError | undefined,
  now = Date.now(),
): { kind: ErrorKind; retryAt?: string } {
  if (!error) return { kind: "fatal" };
  const status = error.status ?? Number(STATUS_IN_MESSAGE.exec(error.message)?.[1] ?? 0);
  const text = `${error.type} ${error.message}`;
  if (status === 401 || status === 403 || /\bauth|unauthori[sz]ed|api key|credential/i.test(text)) {
    return { kind: "auth" };
  }
  if (CONTEXT.test(text)) return { kind: "context_full" };
  const retryAt =
    typeof error.retryAfterMs === "number" && error.retryAfterMs > 0
      ? new Date(now + error.retryAfterMs).toISOString()
      : undefined;
  if (status === 429 && QUOTA.test(text)) {
    return { kind: "usage_limit", ...(retryAt ? { retryAt } : {}) };
  }
  if (status === 429 || status >= 500 || TRANSIENT.test(text)) return { kind: "transient" };
  return { kind: "fatal" };
}

/** How a CodeDen turn on OpenCode ended. */
export type TurnOutcome =
  | { type: "completed" }
  | { type: "interrupted"; reason?: "user" | "provider" | "runner_restart" }
  | {
      type: "failed";
      message: string;
      code?: string;
      detail?: string;
      kind?: ErrorKind;
      retryAt?: string;
    };

/** An OpenCode error as a failed turn outcome. */
export function failure(error: OcError | undefined): TurnOutcome {
  const { kind, retryAt } = classifyOpenCodeError(error);
  return {
    type: "failed",
    code: error?.type ? `opencode_${error.type.replace(/[^a-z0-9]+/gi, "_")}` : "turn_failed",
    message: error?.message || "OpenCode turn failed",
    kind,
    ...(retryAt ? { retryAt } : {}),
  };
}

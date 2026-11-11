import type { SubagentStats } from "@codeden/contracts";
import { count } from "../util/text";

type Raw = Record<string, unknown>;

/** Keep the figures that are present; `undefined` when there are none. */
function stats(
  totalTokens: unknown,
  toolUses: unknown,
  durationMs: unknown,
): SubagentStats | undefined {
  const out: SubagentStats = {};
  const tokens = count(totalTokens);
  const tools = count(toolUses);
  const ms = count(durationMs);
  if (tokens !== undefined) out.totalTokens = tokens;
  if (tools !== undefined) out.toolUses = tools;
  if (ms !== undefined) out.durationMs = ms;
  return Object.keys(out).length > 0 ? out : undefined;
}

/** Figures of a foreground run, from the Agent/Task tool's structured result (`tool_use_result`). */
export function statsFromToolUseResult(result: unknown): SubagentStats | undefined {
  if (!result || typeof result !== "object") return undefined;
  const r = result as Raw;
  return stats(r.totalTokens, r.totalToolUseCount, r.totalDurationMs);
}

/** Figures of a background run, from its `task_notification` message (`usage`). */
export function statsFromTaskNotification(msg: unknown): SubagentStats | undefined {
  const usage = msg && typeof msg === "object" ? (msg as Raw).usage : undefined;
  if (!usage || typeof usage !== "object") return undefined;
  const u = usage as Raw;
  return stats(u.total_tokens, u.tool_uses, u.duration_ms);
}

/** A whole decimal number (`12`, `12.7`, `-3`, `1e3`); anything else is not a figure. */
const NUMBER = /^[+-]?(\d+(\.\d*)?|\.\d+)(e[+-]?\d+)?$/i;

/**
 * Figures from the `<usage>…</usage>` trailer the CLI appends to a subagent's text result
 * (`total_tokens: N`, `tool_uses: N`, `duration_ms: N`), for when no structured result came.
 * Each value must be a complete number; the same rules as the structured figures then apply
 * (finite, non-negative, rounded).
 */
export function statsFromUsageTrailer(text: string): SubagentStats | undefined {
  const block = /<usage>([\s\S]*?)<\/usage>/.exec(text)?.[1];
  if (!block) return undefined;
  const field = (name: string) => {
    const value = new RegExp(`(?:^|\\s)${name}\\s*[:=][ \\t]*([^\\s<]+)`).exec(block)?.[1];
    return value !== undefined && NUMBER.test(value) ? Number(value) : undefined;
  };
  return stats(field("total_tokens"), field("tool_uses"), field("duration_ms"));
}

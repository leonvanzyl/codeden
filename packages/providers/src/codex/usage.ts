import type { SubagentModelUsage, Usage } from "@codeden/contracts";
import { count, unixToIso } from "../util/text";
import type { RateLimitSnapshot, ThreadTokenUsage } from "./protocol/v2";

type Breakdown = ThreadTokenUsage["total"];
const BREAKDOWN_KEYS = [
  "totalTokens",
  "inputTokens",
  "cachedInputTokens",
  "cacheWriteInputTokens",
  "outputTokens",
  "reasoningOutputTokens",
] as const;

function addBreakdown(a: Breakdown, b: Breakdown, sign = 1): Breakdown {
  const out = { ...a };
  for (const k of BREAKDOWN_KEYS) out[k] = Math.max(0, (a[k] ?? 0) + sign * (b[k] ?? 0));
  return out;
}

const ZERO: Breakdown = {
  totalTokens: 0,
  inputTokens: 0,
  cachedInputTokens: 0,
  cacheWriteInputTokens: 0,
  outputTokens: 0,
  reasoningOutputTokens: 0,
};

/**
 * Per-turn token accounting for one thread. Codex reports the thread's running `total` (which
 * survives resumes) and the `last` request. A turn's usage is the growth of `total` since the
 * previous report in this process; the first report after a (re)start counts only `last`, so
 * history from before a resume is never charged again. Repeated reports add nothing.
 */
export class CodexTurnUsage {
  private previousTotal: Breakdown | undefined;
  private readonly turns = new Map<string, Breakdown>();

  /** Fold a report into its turn and return the turn's usage so far. */
  add(turnId: string, u: ThreadTokenUsage): Usage {
    const step = this.previousTotal ? addBreakdown(u.total, this.previousTotal, -1) : u.last;
    this.previousTotal = u.total;
    const turn = addBreakdown(this.turns.get(turnId) ?? ZERO, step);
    this.turns.set(turnId, turn);
    return tokenUsage({ ...u, total: turn });
  }
}

/**
 * Codex token usage in CodeDen's terms, from `u.total` (context from `last`). OpenAI counts
 * cached input inside `inputTokens`; CodeDen's `inputTokens` is the uncached part.
 */
export function tokenUsage(u: ThreadTokenUsage): Usage {
  const usage: Usage = {
    inputTokens: count(Math.max(0, u.total.inputTokens - u.total.cachedInputTokens)),
    outputTokens: count(u.total.outputTokens),
    cachedInputTokens: count(u.total.cachedInputTokens),
    cacheWriteTokens: count(u.total.cacheWriteInputTokens),
    reasoningTokens: count(u.total.reasoningOutputTokens),
    contextTokens: count(u.last.totalTokens),
  };
  if (u.modelContextWindow && u.modelContextWindow > 0)
    usage.contextWindow = Math.round(u.modelContextWindow);
  return usage;
}

/**
 * A sub-agent's tokens for its card (§7.3), from its thread's running `total`, in the same
 * terms as `tokenUsage`. `model` is the one its spawn asked for; absent, it runs the session's.
 */
export function subagentUsage(u: ThreadTokenUsage, model?: string): SubagentModelUsage {
  const t = tokenUsage(u);
  return {
    ...(model ? { model } : {}),
    inputTokens: t.inputTokens ?? 0,
    outputTokens: t.outputTokens ?? 0,
    cacheReadTokens: t.cachedInputTokens ?? 0,
    cacheWriteTokens: t.cacheWriteTokens ?? 0,
    ...(t.reasoningTokens ? { reasoningTokens: t.reasoningTokens } : {}),
  };
}

function windowId(minutes: number | null, fallback: string): string {
  if (minutes === 300) return "5h";
  if (minutes === 10080) return "weekly";
  if (minutes && minutes % 1440 === 0) return `${minutes / 1440}d`;
  if (minutes && minutes % 60 === 0) return `${minutes / 60}h`;
  return fallback;
}

/** Codex rate-limit snapshot -> usage rate limits. */
export function rateLimits(snapshot: RateLimitSnapshot): Usage {
  const out: NonNullable<Usage["rateLimits"]> = [];
  for (const [name, w] of [
    ["primary", snapshot.primary],
    ["secondary", snapshot.secondary],
  ] as const) {
    if (!w) continue;
    const used = Math.min(100, Math.max(0, w.usedPercent));
    const resetsAt = unixToIso(w.resetsAt);
    out.push({
      id: windowId(w.windowDurationMins, name),
      status:
        snapshot.rateLimitReachedType || used >= 100 ? "limited" : used >= 80 ? "warning" : "ok",
      usedPercent: used,
      ...(resetsAt ? { resetsAt } : {}),
    });
  }
  return { rateLimits: out };
}

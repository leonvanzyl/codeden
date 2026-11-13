import type { BillingMode, ItemOf, SubagentCost, SubagentModelUsage } from "@codeden/contracts";
import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef } from "react";
import { usageKeys, useSessionUsage } from "./api";

/**
 * Requests one card may ask for per set of figures when what comes back still doesn't price
 * them, so a server that never prices the card can't make it loop.
 */
const MAX_REFRESHES = 3;

/**
 * The provider's USD figure for one model's calls, read as the server reads it: none when it
 * reported none, or a zero alongside tokens (providers that don't price report 0).
 */
function reportedCost(u: SubagentModelUsage): number | null {
  if (u.costUsd === undefined) return null;
  const tokens = u.inputTokens + u.outputTokens + u.cacheReadTokens + u.cacheWriteTokens;
  return u.costUsd === 0 && tokens > 0 ? null : u.costUsd;
}

/**
 * True when `cost` priced exactly the figures the card shows: per model and in order (the
 * server prices the entries one to one), the same model when the card names one (an unnamed
 * one is the session's), the same token counts, and a reported cost exactly when the card
 * reports one. Pure.
 */
export function costIsCurrent(
  cost: SubagentCost | undefined,
  usage: readonly SubagentModelUsage[],
): boolean {
  if (!cost || cost.models.length !== usage.length) return false;
  return usage.every((u, i) => {
    const m = cost.models[i];
    if (!m || (u.model !== undefined && m.model !== u.model)) return false;
    if (
      m.inputTokens !== u.inputTokens ||
      m.outputTokens !== u.outputTokens ||
      m.cacheReadTokens !== u.cacheReadTokens ||
      m.cacheWriteTokens !== u.cacheWriteTokens ||
      m.reasoningTokens !== (u.reasoningTokens ?? 0)
    )
      return false;
    const reported = reportedCost(u);
    return reported === null
      ? m.costSource !== "reported"
      : m.costSource === "reported" && m.costUsd === reported;
  });
}

/** Everything about a card's figures that its price depends on, as one comparable string. */
function fingerprint(usage: readonly SubagentModelUsage[] | undefined): string {
  if (!usage?.length) return "";
  return JSON.stringify(
    usage.map((u) => [
      u.model ?? null,
      u.inputTokens,
      u.outputTokens,
      u.cacheReadTokens,
      u.cacheWriteTokens,
      u.reasoningTokens ?? 0,
      u.costUsd ?? null,
    ]),
  );
}

/**
 * A finished subagent's cost (§7.3) from the session's usage, with how the provider is billed.
 * The cost shows without waiting for the parent turn to end:
 * - when the card's figures change (the run finished, or its final figures arrived), the
 *   session's usage is fetched again, restarting a request already running, which may have
 *   started before the change and would not see it;
 * - when a request settles and what it priced still isn't what the card shows (the card
 *   opened over older data), it is fetched again, a few times at most per set of figures.
 */
export function useSubagentCost(
  sessionId: string,
  item: ItemOf<"subagent">,
): { cost: SubagentCost | undefined; billing: BillingMode } {
  const queryClient = useQueryClient();
  const usage = item.status === "in_progress" ? undefined : item.stats?.usage;
  const figures = fingerprint(usage);
  const { data, isFetching } = useSessionUsage(figures ? sessionId : undefined);
  const cost = figures ? data?.subagents.find((s) => s.itemId === item.id) : undefined;
  const current = usage && figures ? costIsCurrent(cost, usage) : true;
  /** The figures last seen, and the requests made for them. */
  const seen = useRef({ figures, requests: 0 });

  useEffect(() => {
    const changed = seen.current.figures !== figures;
    if (changed) seen.current = { figures, requests: 0 };
    if (!figures || current) return;
    // Unchanged figures: wait until a request settles, then check what it priced.
    if (!changed && (isFetching || !data)) return;
    if (seen.current.requests >= MAX_REFRESHES) return;
    seen.current.requests += 1;
    void queryClient.invalidateQueries(
      { queryKey: usageKeys.session(sessionId) },
      // New figures restart a running request; otherwise join one rather than restart it.
      { cancelRefetch: changed },
    );
  }, [figures, current, isFetching, data, queryClient, sessionId]);

  return { cost, billing: data?.billing ?? "unknown" };
}

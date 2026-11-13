import type { BillingMode, ItemOf, SubagentCost, SubagentModelUsage } from "@codeden/contracts";
import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef } from "react";
import { usageKeys, useSessionUsage } from "./api";

/** Refetches one card may ask for per set of figures, so a server that never prices it can't loop. */
const MAX_REFRESHES = 2;

/** Token totals by category, to compare what was priced with what a card shows. */
function sums(models: readonly Omit<SubagentModelUsage, "model" | "costUsd">[]): string {
  const t = { input: 0, output: 0, read: 0, write: 0 };
  for (const m of models) {
    t.input += m.inputTokens;
    t.output += m.outputTokens;
    t.read += m.cacheReadTokens;
    t.write += m.cacheWriteTokens;
  }
  return `${t.input}:${t.output}:${t.read}:${t.write}`;
}

/** True when `cost` priced exactly the tokens the card now reports. Pure. */
export function costIsCurrent(
  cost: SubagentCost | undefined,
  usage: readonly SubagentModelUsage[],
): boolean {
  return cost !== undefined && sums(cost.models) === sums(usage);
}

/**
 * A finished subagent's cost (§7.3) from the session's usage, with how the provider is billed.
 * The session's usage is fetched again when the card's figures are newer than what was priced
 * (the run just finished, or its final figures arrived), so the cost shows without waiting for
 * the parent turn to end.
 */
export function useSubagentCost(
  sessionId: string,
  item: ItemOf<"subagent">,
): { cost: SubagentCost | undefined; billing: BillingMode } {
  const queryClient = useQueryClient();
  const usage = item.status === "in_progress" ? undefined : item.stats?.usage;
  const priced = Boolean(usage?.length);
  const { data } = useSessionUsage(priced ? sessionId : undefined);
  const cost = priced ? data?.subagents.find((s) => s.itemId === item.id) : undefined;
  const current = usage ? costIsCurrent(cost, usage) : true;
  const key = usage ? sums(usage) : "";
  const refreshes = useRef({ key: "", count: 0 });

  useEffect(() => {
    if (!key || !data || current) return;
    const r = refreshes.current;
    if (r.key !== key) refreshes.current = { key, count: 0 };
    if (refreshes.current.count >= MAX_REFRESHES) return;
    refreshes.current.count += 1;
    // Joins a fetch already running instead of restarting it.
    void queryClient.invalidateQueries(
      { queryKey: usageKeys.session(sessionId) },
      { cancelRefetch: false },
    );
  }, [key, data, current, queryClient, sessionId]);

  return { cost, billing: data?.billing ?? "unknown" };
}

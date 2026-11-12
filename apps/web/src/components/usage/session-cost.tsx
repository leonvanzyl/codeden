import type { SessionUsage } from "@codeden/contracts";
import { useQueryClient } from "@tanstack/react-query";
import { Coins } from "lucide-react";
import { useEffect } from "react";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { useTranscriptsStore } from "@/stores/transcripts";
import { usageKeys, useSessionUsage } from "./api";
import { money, percent, tokens, totalTokens } from "./format";

/** The session's ledger figures, refreshed whenever its live usage changes. */
function useLiveSessionUsage(sessionId: string) {
  const queryClient = useQueryClient();
  const live = useTranscriptsStore((s) => s.byId[sessionId]?.usage);
  const marker = `${live?.inputTokens ?? 0}:${live?.outputTokens ?? 0}:${live?.costUsd ?? 0}`;
  useEffect(() => {
    if (marker === "0:0:0") return;
    void queryClient.invalidateQueries({ queryKey: usageKeys.session(sessionId) });
  }, [marker, queryClient, sessionId]);
  return useSessionUsage(sessionId);
}

function costLabel(u: SessionUsage): string {
  return money(u.totals.costUsd, u.totals.estimatedCostUsd > 0);
}

/** "API-equivalent cost (estimated from list prices)": what kind of figure the cost is (§12.6). */
function costHeading(u: SessionUsage): string {
  const kind = u.billing === "subscription" ? "API-equivalent cost" : "Session cost";
  return u.totals.estimatedCostUsd > 0 ? `${kind} (estimated from list prices)` : kind;
}

/**
 * The session's cost for Session details, from the same ledger figures as the header chip:
 * "No usage yet" before the first turn, "Not priced" when no turn has a price or a reported cost.
 */
export function SessionCostText({ sessionId }: { sessionId: string }) {
  const { data } = useLiveSessionUsage(sessionId);
  if (!data) return null;
  const t = data.totals;
  if (t.turns === 0) return <span>No usage yet</span>;
  if (t.unpricedTurns === t.turns) {
    return (
      <span title="This model has no price in the price table and the provider reported no cost">
        Not priced
      </span>
    );
  }
  const unpriced = t.unpricedTurns > 0 ? ` · ${t.unpricedTurns} turns not priced` : "";
  return (
    <span data-testid="details-cost" title={`${costHeading(data)}${unpriced}`}>
      {costLabel(data)} {data.billing === "subscription" ? "API-equivalent" : "this session"}
    </span>
  );
}

/** Cost and tokens chip for the session header, with a breakdown on hover. */
export function SessionCostChip({
  sessionId,
  className,
}: {
  sessionId: string;
  className?: string;
}) {
  const { data } = useLiveSessionUsage(sessionId);
  if (!data || data.totals.turns === 0) return null;
  const t = data.totals;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          data-testid="session-cost"
          className={cn(
            "inline-flex h-6 items-center gap-1.5 rounded-md border border-border/80 px-2 text-2xs whitespace-nowrap text-muted-foreground tabular-nums",
            className,
          )}
        >
          <Coins className="size-3" />
          <span className="text-foreground/90">{costLabel(data)}</span>
          <span className="text-muted-foreground/60">·</span>
          {tokens(totalTokens(t))} tok
        </span>
      </TooltipTrigger>
      <TooltipContent className="space-y-1 text-2xs">
        <div className="font-medium">{costHeading(data)}</div>
        <div className="tabular-nums">
          {tokens(t.inputTokens)} input · {tokens(t.outputTokens)} output
        </div>
        <div className="tabular-nums">
          {tokens(t.cacheReadTokens)} cache reads · {tokens(t.cacheWriteTokens)} cache writes
        </div>
        <div className="tabular-nums">
          {t.turns} turns · cache hit rate {percent(t.cacheHitRate)}
        </div>
      </TooltipContent>
    </Tooltip>
  );
}

/** "$0.42 · 38k tokens" for one turn, for the turn footer; null until the turn has usage. */
export function useTurnCostText(sessionId: string, turnId: string): string | null {
  const { data } = useSessionUsage(sessionId);
  const turn = data?.turns.find((t) => t.turnId === turnId);
  if (!turn) return null;
  const total = turn.inputTokens + turn.outputTokens + turn.cacheReadTokens + turn.cacheWriteTokens;
  return `${money(turn.costUsd, turn.costSource === "estimated")} · ${tokens(total)} tokens`;
}

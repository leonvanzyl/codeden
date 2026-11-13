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

const NOT_PRICED = "Not priced";
const NOT_PRICED_TITLE =
  "This model has no price in the price table and the provider reported no cost";

/** No turn has a reported cost or a price to estimate one from, so there is no figure. */
function notPriced(u: SessionUsage): boolean {
  return u.totals.turns > 0 && u.totals.unpricedTurns === u.totals.turns;
}

function costLabel(u: SessionUsage): string {
  if (notPriced(u)) return NOT_PRICED;
  return money(u.totals.costUsd, u.totals.estimatedCostUsd > 0);
}

/** "API-equivalent cost (estimated from list prices)": what kind of figure the cost is (§12.6). */
function costHeading(u: SessionUsage): string {
  if (notPriced(u)) return NOT_PRICED_TITLE;
  const kind = u.billing === "subscription" ? "API-equivalent cost" : "Session cost";
  const label = u.totals.estimatedCostUsd > 0 ? `${kind} (estimated from list prices)` : kind;
  return u.totals.unpricedTurns > 0
    ? `${label} · ${u.totals.unpricedTurns} turns not priced`
    : label;
}

/**
 * The session's cost for Session details, from the same ledger figures and labels as the header
 * chip: "No usage yet" before the first turn, "Not priced" when no turn could be priced.
 */
export function SessionCostText({ sessionId }: { sessionId: string }) {
  const { data } = useLiveSessionUsage(sessionId);
  if (!data) return null;
  if (data.totals.turns === 0) return <span>No usage yet</span>;
  const kind = notPriced(data)
    ? ""
    : data.billing === "subscription"
      ? " API-equivalent"
      : " this session";
  return (
    <span data-testid="details-cost" title={costHeading(data)}>
      {costLabel(data)}
      {kind}
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

/**
 * "$0.42 · 38k tokens" for one turn, for the turn footer ("Not priced · 38k tokens" when the
 * turn has no price); null until the turn has usage.
 */
export function useTurnCostText(sessionId: string, turnId: string): string | null {
  const { data } = useSessionUsage(sessionId);
  const turn = data?.turns.find((t) => t.turnId === turnId);
  if (!turn) return null;
  const total = turn.inputTokens + turn.outputTokens + turn.cacheReadTokens + turn.cacheWriteTokens;
  const cost =
    turn.costSource === "unpriced" && total > 0
      ? NOT_PRICED
      : money(turn.costUsd, turn.costSource === "estimated");
  return `${cost} · ${tokens(total)} tokens`;
}

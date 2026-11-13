import type { FactoryStatus } from "@codeden/contracts";
import { compact, plural, usd } from "@/lib/format";

/**
 * The Factory view's stats strip: six figures, each with an optional small bar. Where the
 * factory panel shows the same figure (spend, merges, agents), it is the same number.
 */
export interface StatTile {
  id: "spend" | "merges" | "agents" | "prs" | "failures" | "median";
  label: string;
  value: string;
  /** A second line in smaller print. */
  detail?: string;
  /** A small bar: `value` of `max`; `warn` colours it as it fills up. */
  bar?: { value: number; max: number; warn: boolean };
  /** Draws the value in the failed colour. */
  alert?: boolean;
}

/** "45m", "5h 20m", "2.5d". */
export function shortDuration(ms: number): string {
  const minutes = Math.round(ms / 60_000);
  if (minutes < 60) return `${Math.max(1, minutes)}m`;
  if (minutes < 48 * 60) {
    const h = Math.floor(minutes / 60);
    const m = minutes % 60;
    return m ? `${h}h ${m}m` : `${h}h`;
  }
  return `${(minutes / 1440).toFixed(1)}d`;
}

/** Pull requests the factory still holds: not merged and not replaced by a newer one. */
export function openPrs(f: FactoryStatus) {
  return f.pullRequests.filter((p) => p.state !== "merged" && p.state !== "superseded");
}

export function viewStats(f: FactoryStatus): StatTile[] {
  const budgetUsd = f.limits.dailyBudget.usd;
  const budgetTokens = f.limits.dailyBudget.tokens;
  const open = openPrs(f);
  const queued = open.filter((p) => p.queuePosition !== null).length;
  const forYou = open.filter((p) => p.state === "waiting_for_you" || p.state === "stuck").length;
  const { stats } = f;
  return [
    {
      id: "spend",
      label: "Spend today",
      value: budgetUsd ? usd(f.spendToday.usd) : compact(f.spendToday.tokens),
      detail: budgetUsd
        ? `of ${usd(budgetUsd)}`
        : budgetTokens
          ? `of ${compact(budgetTokens)} tokens`
          : "no budget set",
      bar: {
        value: budgetUsd ? f.spendToday.usd : f.spendToday.tokens,
        max: budgetUsd ?? budgetTokens ?? 0,
        warn: true,
      },
    },
    f.limits.autoMerge
      ? {
          id: "merges",
          label: "Merges today",
          value: String(f.mergesToday),
          detail: `of ${f.limits.maxMergesPerDay} a day`,
          bar: { value: f.mergesToday, max: f.limits.maxMergesPerDay, warn: false },
        }
      : {
          id: "merges",
          label: "Merges today",
          value: String(stats.mergedToday),
          detail: "auto-merge off",
        },
    {
      id: "agents",
      label: "Agents working",
      value: String(f.activeSessions),
      detail: `of ${f.limits.maxConcurrentSessions}`,
      bar: { value: f.activeSessions, max: f.limits.maxConcurrentSessions, warn: false },
    },
    {
      id: "prs",
      label: "Open PRs",
      value: String(open.length),
      detail: forYou > 0 ? `${forYou} for you` : queued > 0 ? `${queued} queued` : undefined,
    },
    {
      id: "failures",
      label: "Failed · reverted",
      value: `${stats.failedToday} · ${stats.revertedToday}`,
      detail: `today · ${f.consecutiveFailures} in a row`,
      alert: stats.failedToday + stats.revertedToday > 0,
    },
    {
      id: "median",
      label: "Issue to merge",
      value: stats.medianMergeMs7d === null ? "—" : shortDuration(stats.medianMergeMs7d),
      detail:
        stats.merged7d > 0
          ? `median of ${plural(stats.merged7d, "merge")}, 7 days`
          : "no merges in 7 days",
    },
  ];
}

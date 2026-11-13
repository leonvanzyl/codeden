import type { FactoryItem, FactoryStats } from "@codeden/contracts";
import { localDay } from "./policy";

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

/** The middle value (the mean of the two middle ones for an even count); null when empty. */
export function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2
    ? (sorted[mid] as number)
    : ((sorted[mid - 1] as number) + (sorted[mid] as number)) / 2;
}

/**
 * The Factory view's throughput figures (`FactoryStatus.stats`): today's merges, failures and
 * reverts by the server's local day, and the median time from intake to merge over the last
 * 7 days.
 */
export function factoryStats(items: FactoryItem[], now: Date): FactoryStats {
  const today = localDay(now);
  const on = (at: string | null) => at !== null && localDay(new Date(at)) === today;
  const since = now.getTime() - WEEK_MS;
  const durations = items.flatMap((i) => {
    if (!i.mergedAt) return [];
    const merged = Date.parse(i.mergedAt);
    if (merged < since || merged > now.getTime()) return [];
    return [Math.max(0, merged - Date.parse(i.createdAt))];
  });
  return {
    mergedToday: items.filter((i) => on(i.mergedAt)).length,
    failedToday: items.filter((i) => i.stage === "failed" && on(i.finishedAt)).length,
    revertedToday: items.filter((i) => i.stage === "reverted" && on(i.finishedAt)).length,
    medianMergeMs7d: median(durations),
    merged7d: durations.length,
  };
}

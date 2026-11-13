import type { FactoryItem, FactoryStats } from "@codeden/contracts";
import { localDay } from "./policy";

const DAY_MS = 24 * 60 * 60 * 1000;
const WEEK_MS = 7 * DAY_MS;

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

/** Bounds of `viewRecentItems`, for narrowing the query first (`FactoryStore.viewCandidates`). */
export function viewWindow(now: Date): { failedSince: string; mergedSince: string } {
  const midnight = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  return {
    failedSince: new Date(now.getTime() - DAY_MS).toISOString(),
    mergedSince: midnight.toISOString(),
  };
}

/**
 * The finished items the Factory view keeps showing (`FactoryStatus.viewRecent`), whatever their
 * place in the capped recent list: every escalated item, failed items that failed in the last
 * 24 hours or still own an open pull request (`ownsOpenPr`: their own, or a rebuild's original
 * the factory still holds), and items merged today (by the local day).
 */
export function viewRecentItems(
  items: FactoryItem[],
  now: Date,
  ownsOpenPr: (item: FactoryItem) => boolean,
): FactoryItem[] {
  const today = localDay(now);
  return items.filter((i) => {
    if (i.stage === "escalated") return true;
    if (i.stage === "failed") {
      const at = Date.parse(i.finishedAt ?? i.updatedAt);
      return ownsOpenPr(i) || now.getTime() - at < DAY_MS;
    }
    if (i.stage === "merged")
      return i.mergedAt !== null && localDay(new Date(i.mergedAt)) === today;
    return false;
  });
}

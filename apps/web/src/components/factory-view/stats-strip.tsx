import type { FactoryStatus } from "@codeden/contracts";
import { cn } from "@/lib/utils";
import { type StatTile, viewStats } from "./view-stats";

function Bar({ bar }: { bar: NonNullable<StatTile["bar"]> }) {
  const pct = bar.max > 0 ? Math.min(100, (bar.value / bar.max) * 100) : 0;
  const tone = !bar.warn
    ? "bg-status-running"
    : pct > 85
      ? "bg-status-failed"
      : pct > 60
        ? "bg-status-waiting"
        : "bg-primary";
  return (
    <span className="mt-1 block h-1 w-full overflow-hidden rounded-full bg-muted" aria-hidden>
      <span className={cn("block h-full rounded-full", tone)} style={{ width: `${pct}%` }} />
    </span>
  );
}

/** One compact row of figures: spend, merges, agents, open PRs, failures, time to merge. */
export function StatsStrip({ f }: { f: FactoryStatus }) {
  const tiles = viewStats(f);
  return (
    <dl
      className="grid grid-cols-2 gap-2 sm:grid-cols-3 xl:grid-cols-6"
      aria-label="Factory figures"
      data-testid="factory-view-stats"
    >
      {tiles.map((t) => (
        <div
          key={t.id}
          className="min-w-0 rounded-lg border border-border bg-card px-3 py-2"
          data-stat={t.id}
        >
          <dt className="truncate text-3xs tracking-wider text-muted-foreground uppercase">
            {t.label}
          </dt>
          <dd className="mt-0.5 flex items-baseline gap-1.5">
            <span
              className={cn(
                "shrink-0 text-[17px] leading-6 font-semibold whitespace-nowrap tabular-nums",
                t.alert && "text-status-failed",
              )}
            >
              {t.value}
            </span>
            {t.detail && (
              <span className="min-w-0 truncate text-2xs text-muted-foreground" title={t.detail}>
                {t.detail}
              </span>
            )}
          </dd>
          {t.bar && <Bar bar={t.bar} />}
        </div>
      ))}
    </dl>
  );
}

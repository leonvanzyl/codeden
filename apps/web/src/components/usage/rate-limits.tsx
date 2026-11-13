import type { RateLimitsResponse, RateLimitWindow } from "@codeden/contracts";
import { AlertTriangle, Gauge, OctagonX } from "lucide-react";
import { ProviderMark } from "@/components/common/bits";
import { ago, until } from "@/lib/format";
import { cn } from "@/lib/utils";
import { PROVIDER_NAMES } from "./format";

type Tone = "ok" | "warning" | "limited" | "stale";

function toneOf(w: RateLimitWindow, warnPercent: number): Tone {
  if (w.stale) return "stale";
  if (w.status === "limited" || (w.usedPercent ?? 0) >= 100) return "limited";
  if (w.status === "warning" || (w.usedPercent ?? 0) >= warnPercent) return "warning";
  return "ok";
}

const BAR: Record<Tone, string> = {
  ok: "bg-status-running",
  warning: "bg-status-waiting",
  limited: "bg-status-failed",
  stale: "bg-muted-foreground/40",
};

/** "64%", "<1%" for a light window, "—" when not reported. */
export function usedText(p: number | null): string {
  if (p === null) return "—";
  if (p > 0 && p < 1) return "<1%";
  return `${Math.round(p)}%`;
}

/** What the provider said about a window whose percentage is not known. */
const STATUS_TEXT: Record<RateLimitWindow["status"], string> = {
  ok: "Within limit",
  warning: "Close to the limit",
  limited: "Limit reached",
};

function headline(w: RateLimitWindow, tone: Tone): string {
  if (tone === "stale") return "reset since";
  if (w.usedPercent === null) return STATUS_TEXT[w.status];
  return tone === "limited" ? "Limit reached" : `${usedText(w.usedPercent)} used`;
}

function WindowMeter({ w, warnPercent }: { w: RateLimitWindow; warnPercent: number }) {
  const tone = toneOf(w, warnPercent);
  const used = w.usedPercent;
  // "as of" dates the figure shown: the percentage's own reading when there is one.
  const asOf = (used !== null ? w.usedPercentAt : null) ?? w.observedAt;
  return (
    <div className="space-y-1.5" data-testid="limit-window" data-tone={tone}>
      <div className="flex items-baseline justify-between gap-2 text-xs">
        <span className="font-medium">{w.label}</span>
        <span
          className={cn(
            "inline-flex items-center gap-1 tabular-nums",
            tone === "stale" ? "text-muted-foreground" : "text-foreground",
          )}
        >
          {tone === "warning" && <AlertTriangle className="size-3 text-status-waiting" />}
          {tone === "limited" && <OctagonX className="size-3 text-status-failed" />}
          {headline(w, tone)}
        </span>
      </div>
      {/* No bar until a percentage is known: an empty bar would read as "nothing used". */}
      {used !== null && (
        // biome-ignore lint/a11y/useSemanticElements: a native <meter> cannot be themed consistently across browsers.
        <div
          role="meter"
          aria-label={`${w.label} used`}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={Math.round(used)}
          className="h-2 overflow-hidden rounded-full bg-muted"
        >
          <div
            className={cn("h-full rounded-full transition-[width]", BAR[tone])}
            style={{ width: `${tone === "stale" ? 0 : Math.max(used, used > 0 ? 2 : 0)}%` }}
          />
        </div>
      )}
      <div className="flex justify-between gap-2 text-2xs text-muted-foreground">
        <span>
          {w.resetsAt
            ? tone === "stale"
              ? `Reset ${ago(w.resetsAt)}`
              : `Resets ${until(w.resetsAt)}`
            : "Reset time not reported"}
        </span>
        <span title={new Date(asOf).toLocaleString()}>as of {ago(asOf)}</span>
      </div>
    </div>
  );
}

/** Subscription windows per provider, as each provider last reported them. */
export function RateLimitMeters({ data }: { data: RateLimitsResponse | undefined }) {
  const windows = data?.windows ?? [];
  const providers = [...new Set(windows.map((w) => w.provider))];
  if (!data || providers.length === 0) {
    return (
      <div className="flex items-start gap-3 rounded-xl border border-dashed border-border p-4 text-xs text-muted-foreground">
        <Gauge className="mt-0.5 size-4 shrink-0" />
        <p>
          No limit readings yet. Claude reports its 5-hour and weekly windows while it runs, and
          Codex sends a snapshot with each turn, so they appear after the next session. API keys pay
          per token and have no such windows.
        </p>
      </div>
    );
  }
  return (
    <div className="grid grid-cols-[minmax(0,1fr)] gap-3 md:grid-cols-2">
      {providers.map((provider) => {
        const billing = data.billing[provider];
        return (
          <div key={provider} className="space-y-4 rounded-xl border border-border bg-card p-4">
            <div className="flex items-center gap-2">
              <ProviderMark provider={provider} className="size-5 text-[10px]" />
              <span className="text-sm font-medium">{PROVIDER_NAMES[provider] ?? provider}</span>
              <span className="ml-auto text-2xs text-muted-foreground">
                {billing === "subscription"
                  ? "Subscription login"
                  : billing === "api"
                    ? "API key"
                    : "Login type unknown"}
              </span>
            </div>
            {windows
              .filter((w) => w.provider === provider)
              .map((w) => (
                <WindowMeter key={w.windowId} w={w} warnPercent={data.warnPercent} />
              ))}
          </div>
        );
      })}
    </div>
  );
}

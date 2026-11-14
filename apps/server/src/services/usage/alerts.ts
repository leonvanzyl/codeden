import type { BudgetStatus, RateLimitWindow, UsageBudget } from "@codeden/contracts";

/** First local day of a budget's current period. */
export function periodStart(period: UsageBudget["period"], today: string): string {
  return period === "daily" ? today : `${today.slice(0, 7)}-01`;
}

/** Where a budget stands given what was spent in its period. Pure. */
export function budgetStatus(budget: UsageBudget, spentUsd: number, start: string): BudgetStatus {
  const percent = (spentUsd / budget.limitUsd) * 100;
  const state = percent >= 100 ? "exceeded" : percent >= budget.warnAtPercent ? "warning" : "ok";
  return {
    budget,
    periodStart: start,
    spentUsd: Math.round(spentUsd * 1e6) / 1e6,
    percent: Math.round(percent * 10) / 10,
    state,
  };
}

/** An inbox item to raise. Ids are deterministic, so each alert is raised once. */
export interface AlertSpec {
  id: string;
  title: string;
  body: string;
  priority: "normal" | "high";
  projectId: string | null;
}

const usd = (n: number) => `$${n.toFixed(2)}`;

/** Alerts for budgets past their warning share or limit (one per budget, period and level). */
export function budgetAlerts(
  statuses: BudgetStatus[],
  projectName: (id: string) => string,
): AlertSpec[] {
  const out: AlertSpec[] = [];
  for (const s of statuses) {
    if (!s.budget.enabled || s.state === "ok") continue;
    const scope = s.budget.projectId ? projectName(s.budget.projectId) : "All projects";
    const period = s.budget.period === "daily" ? "Daily" : "Monthly";
    const exceeded = s.state === "exceeded";
    out.push({
      id: `inbox:usage:budget:${s.budget.id}:${s.periodStart}:${s.state}`,
      title: exceeded
        ? `${period} budget exceeded: ${scope} spent ${usd(s.spentUsd)} of ${usd(s.budget.limitUsd)}`
        : `${period} budget at ${Math.floor(s.percent)}%: ${scope} spent ${usd(s.spentUsd)} of ${usd(s.budget.limitUsd)}`,
      body: exceeded
        ? "Spend passed the alert limit. Factory limits use the same figures; check the usage report to see which sessions drove it."
        : `Spend reached the ${s.budget.warnAtPercent}% warning level for this period.`,
      priority: exceeded ? "high" : "normal",
      projectId: s.budget.projectId,
    });
  }
  return out;
}

const WINDOW_LABELS: Record<string, string> = {
  "5h": "5-hour window",
  weekly: "Weekly",
  "weekly-opus": "Weekly (Opus)",
  "weekly-sonnet": "Weekly (Sonnet)",
  primary: "Primary window",
  secondary: "Secondary window",
};

/** A readable name for a provider window id. */
export function windowLabel(id: string): string {
  const known = WINDOW_LABELS[id];
  if (known) return known;
  const m = /^(\d+)([hd])$/.exec(id);
  if (m) return `${m[1]}-${m[2] === "h" ? "hour" : "day"} window`;
  // A per-model weekly window, e.g. `weekly-haiku` from Claude's plan usage.
  const model = /^weekly-(.+)$/.exec(id)?.[1];
  if (model) {
    const name = model.replace(/-/g, " ");
    return `Weekly (${name.charAt(0).toUpperCase()}${name.slice(1)})`;
  }
  return id;
}

/** A stored window reading as shown to the UI; `stale` once its reset time has passed. */
export function toWindow(
  row: {
    provider: string;
    windowId: string;
    status: RateLimitWindow["status"];
    usedPercent: number | null;
    usedPercentAt?: string | null;
    resetsAt: string | null;
    observedAt: string;
  },
  now: number,
): RateLimitWindow {
  return {
    provider: row.provider,
    windowId: row.windowId,
    status: row.status,
    usedPercent: row.usedPercent,
    // Rows written before the column existed read their percentage with the status.
    usedPercentAt: row.usedPercent === null ? null : (row.usedPercentAt ?? row.observedAt),
    resetsAt: row.resetsAt,
    observedAt: row.observedAt,
    label: windowLabel(row.windowId),
    stale: row.resetsAt !== null && Date.parse(row.resetsAt) <= now,
  };
}

const PROVIDER_NAMES: Record<string, string> = {
  claude: "Claude",
  codex: "Codex",
  opencode: "OpenCode",
  cursor: "Cursor",
  gemini: "Gemini CLI",
};

/** Alerts for current windows at or above `warnPercent` (or flagged by the provider). */
export function rateLimitAlerts(windows: RateLimitWindow[], warnPercent: number): AlertSpec[] {
  const out: AlertSpec[] = [];
  for (const w of windows) {
    if (w.stale) continue;
    const used = w.usedPercent ?? (w.status === "limited" ? 100 : null);
    const near = (used !== null && used >= warnPercent) || w.status === "limited";
    if (!near) continue;
    const who = PROVIDER_NAMES[w.provider] ?? w.provider;
    const limited = w.status === "limited" || (used ?? 0) >= 100;
    const reset = w.resetsAt ? ` It resets ${new Date(w.resetsAt).toUTCString()}.` : "";
    out.push({
      id: `inbox:usage:limit:${w.provider}:${w.windowId}:${w.resetsAt ?? "unknown"}:${limited ? "limited" : "warning"}`,
      title: limited
        ? `${who} ${w.label.toLowerCase()} limit reached`
        : `${who} ${w.label.toLowerCase()} at ${Math.round(used ?? 0)}%`,
      body: `New turns on ${who} may be refused or slowed until the window resets.${reset}`,
      priority: limited ? "high" : "normal",
      projectId: null,
    });
  }
  return out;
}

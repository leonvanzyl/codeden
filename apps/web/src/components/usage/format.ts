import type { BillingMode, UsageTotals } from "@codeden/contracts";

/** "$3.20", "$0.042", "$1,284"; estimates read "≈ $3.20". */
export function money(n: number, estimated = false): string {
  const digits = n === 0 ? 2 : n < 0.1 ? 3 : n < 1000 ? 2 : 0;
  const text = new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  }).format(n);
  return estimated && n > 0 ? `≈ ${text}` : text;
}

/** Axis ticks: "$0", "$12", "$1.2k". */
export function axisMoney(n: number): string {
  if (n >= 1000) return `$${(n / 1000).toFixed(n >= 10_000 ? 0 : 1)}k`;
  if (n > 0 && n < 1) return `$${n.toFixed(2)}`;
  return `$${Math.round(n)}`;
}

/** "12.4M", "860k", "42". */
export function tokens(n: number): string {
  if (n >= 1e9) return `${(n / 1e9).toFixed(1)}B`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(n >= 1e7 ? 0 : 1)}M`;
  if (n >= 1e3) return `${Math.round(n / 1e3)}k`;
  return String(Math.round(n));
}

/** "64%", "<1%" for small non-zero shares, "—" when unknown. */
export function percent(fraction: number | null): string {
  if (fraction === null || Number.isNaN(fraction)) return "—";
  const p = fraction * 100;
  if (p > 0 && p < 1) return "<1%";
  return `${Math.round(p)}%`;
}

export function totalTokens(t: UsageTotals): number {
  return t.inputTokens + t.outputTokens + t.cacheReadTokens + t.cacheWriteTokens;
}

/** Change against the previous period: "+12%", "−4%", or null when there is no baseline. */
export function trend(current: number, previous: number): { text: string; up: boolean } | null {
  if (previous <= 0) return null;
  const change = (current - previous) / previous;
  if (Math.abs(change) < 0.005) return { text: "±0%", up: false };
  return {
    text: `${change > 0 ? "+" : "−"}${Math.round(Math.abs(change) * 100)}%`,
    up: change > 0,
  };
}

/** True when any provider in view is a subscription login (costs are API-equivalent). */
export function isApiEquivalent(billing: Record<string, BillingMode>): boolean {
  return Object.values(billing).some((b) => b === "subscription");
}

/** "Nov 7" for a YYYY-MM-DD day. */
export function shortDay(day: string): string {
  return new Date(`${day}T12:00:00Z`).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });
}

/** "Fri, Nov 7". */
export function longDay(day: string): string {
  return new Date(`${day}T12:00:00Z`).toLocaleDateString("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });
}

/** Today's local date as YYYY-MM-DD. */
export function localToday(now = new Date()): string {
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

/** `day` moved by `n` calendar days. */
export function shiftDay(day: string, n: number): string {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

export const PROVIDER_NAMES: Record<string, string> = {
  claude: "Claude",
  codex: "Codex",
  opencode: "OpenCode",
};

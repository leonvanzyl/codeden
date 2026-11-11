import type { SessionStatus, SubagentStats } from "@codeden/contracts";

/** "now", "3m", "2h", "4d" — compact age for dense lists. */
export function ageShort(iso: string, now = Date.now()): string {
  const s = Math.max(0, Math.round((now - Date.parse(iso)) / 1000));
  if (s < 45) return "now";
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h`;
  return `${Math.round(h / 24)}d`;
}

/** "just now", "3 min ago", "2 h ago", "yesterday". */
export function ago(iso: string, now = Date.now()): string {
  const short = ageShort(iso, now);
  if (short === "now") return "just now";
  if (short.endsWith("m")) return `${short.slice(0, -1)} min ago`;
  if (short.endsWith("h")) return `${short.slice(0, -1)} h ago`;
  const d = Number(short.slice(0, -1));
  return d === 1 ? "yesterday" : `${d} days ago`;
}

/** "in 38 min", "in 2 h 30 min", "tomorrow 09:00", "Mon 09:00". */
export function until(iso: string, now = Date.now()): string {
  const target = new Date(iso);
  const mins = Math.round((target.getTime() - now) / 60_000);
  if (mins <= 0) return "now";
  if (mins < 60) return `in ${mins} min`;
  if (mins < 6 * 60) {
    const h = Math.floor(mins / 60);
    const m = mins % 60;
    return m ? `in ${h} h ${m} min` : `in ${h} h`;
  }
  const time = target.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false });
  const today = new Date(now);
  const tomorrow = new Date(now + 86_400_000);
  if (target.toDateString() === today.toDateString()) return `today ${time}`;
  if (target.toDateString() === tomorrow.toDateString()) return `tomorrow ${time}`;
  // A weekday alone is ambiguous from a week out.
  if (mins >= 6 * 24 * 60)
    return `${target.toLocaleDateString([], { day: "numeric", month: "short" })} ${time}`;
  return `${target.toLocaleDateString([], { weekday: "short" })} ${time}`;
}

/** "850ms", "4.2s", "1m 36s", "1h 4m". */
export function duration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const s = ms / 1000;
  if (s < 60) return `${s < 10 ? s.toFixed(1) : Math.round(s)}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${Math.round(s % 60)}s`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

export function compact(n: number): string {
  return new Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 }).format(n);
}

export function usd(n: number): string {
  return new Intl.NumberFormat("en", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: n < 10 ? 2 : 0,
  }).format(n);
}

export function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

/**
 * A finished subagent's figures, only those its provider reported:
 * `["48.2k tokens", "23 tool calls", "1m 12s"]`; empty when there are none.
 */
export function subagentStatsParts(stats: SubagentStats | undefined): string[] {
  if (!stats) return [];
  const parts: string[] = [];
  const { totalTokens: tokens, toolUses, durationMs } = stats;
  if (tokens !== undefined)
    parts.push(`${compact(tokens).replace("K", "k")} ${tokens === 1 ? "token" : "tokens"}`);
  if (toolUses !== undefined) parts.push(plural(toolUses, "tool call"));
  if (durationMs !== undefined) parts.push(duration(durationMs));
  return parts;
}

/**
 * The same figures unrounded, for a tooltip:
 * `"48,213 tokens · 23 tool calls · 1m 12s (72,000 ms)"`; empty when there are none.
 */
export function subagentStatsTitle(stats: SubagentStats | undefined): string {
  if (!stats) return "";
  const exact = (n: number) => n.toLocaleString("en");
  const { totalTokens: tokens, toolUses, durationMs } = stats;
  const parts: string[] = [];
  if (tokens !== undefined) parts.push(`${exact(tokens)} ${tokens === 1 ? "token" : "tokens"}`);
  if (toolUses !== undefined)
    parts.push(`${exact(toolUses)} ${toolUses === 1 ? "tool call" : "tool calls"}`);
  if (durationMs !== undefined) parts.push(`${duration(durationMs)} (${exact(durationMs)} ms)`);
  return parts.join(" · ");
}

export type Tone = "running" | "waiting" | "done" | "failed" | "idle";

export const statusTone: Record<SessionStatus, Tone> = {
  created: "idle",
  queued: "idle",
  starting: "running",
  running: "running",
  waiting: "waiting",
  idle: "idle",
  interrupted: "waiting",
  completed: "done",
  failed: "failed",
  stopped: "idle",
};

export const statusLabel: Record<SessionStatus, string> = {
  created: "Created",
  queued: "Queued",
  starting: "Starting",
  running: "Working",
  waiting: "Needs you",
  idle: "Idle",
  interrupted: "Interrupted",
  completed: "Done",
  failed: "Failed",
  stopped: "Stopped",
};

/** Sessions that count as live work for Now / Next. */
export function isActive(status: SessionStatus): boolean {
  return (
    status === "running" || status === "waiting" || status === "starting" || status === "queued"
  );
}

/** `1.4 KB`, `2.1 MB`. */
export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

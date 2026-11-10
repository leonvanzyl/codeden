import type {
  BillingMode,
  GitHubPrRef,
  UsageDimension,
  UsageQuery,
  UsageReport,
} from "@codeden/contracts";
import {
  addDays,
  daysBetween,
  filterRows,
  type PricedRow,
  seriesOf,
  sessionTotals,
  totalsOf,
} from "./aggregate";

/** Names and links reports need, looked up by id. */
export interface ReportNames {
  project(id: string): string | null;
  automation(id: string): string | null;
  session(id: string): { title: string; pr: GitHubPrRef | null } | null;
  /** True when the session's PR has merged. */
  merged(id: string): boolean;
}

const ROLE_LABELS: Record<string, string> = {
  orchestrator: "Orchestrator",
  pm: "Project manager",
  agent: "Agent",
};
const SOURCE_LABELS: Record<string, string> = {
  user: "You",
  orchestrator: "Orchestrator",
  pm: "Project manager",
  automation: "Automations",
  factory: "Factory",
};
const PROVIDER_LABELS: Record<string, string> = {
  claude: "Claude",
  codex: "Codex",
  opencode: "OpenCode",
  fake: "Fake",
};

function labeller(dim: UsageDimension, names: ReportNames): (key: string) => string {
  switch (dim) {
    case "provider":
      return (k) => PROVIDER_LABELS[k] ?? k;
    case "model":
      return (k) => k;
    case "project":
      return (k) => (k ? (names.project(k) ?? "Deleted project") : "No project");
    case "role":
      return (k) => ROLE_LABELS[k] ?? k;
    case "source":
      return (k) => SOURCE_LABELS[k] ?? k;
  }
}

const DIMENSIONS: UsageDimension[] = ["provider", "model", "project", "role", "source"];

/**
 * Build the report for a query from priced rows covering the range and the equally long
 * range before it. Pure: names, merges and billing come in as lookups.
 */
export function buildReport(
  rows: PricedRow[],
  q: UsageQuery,
  timezone: string,
  names: ReportNames,
  billing: Record<string, BillingMode>,
): UsageReport {
  const days = daysBetween(q.from, q.to);
  const inRange = filterRows(rows, q);
  const previous = filterRows(rows, {
    ...q,
    from: addDays(q.from, -days.length),
    to: addDays(q.from, -1),
  });
  const totals = totalsOf(inRange);
  const series = Object.fromEntries(
    DIMENSIONS.map((dim) => [dim, seriesOf(inRange, days, dim, labeller(dim, names))]),
  ) as UsageReport["series"];

  const sessions = sessionTotals(inRange);
  const topSessions = sessions.slice(0, 25).map((s) => {
    const info = names.session(s.sessionId);
    const r = s.first;
    return {
      sessionId: s.sessionId,
      title: info?.title ?? s.sessionId,
      projectId: r.projectId,
      projectName: r.projectId ? names.project(r.projectId) : null,
      provider: r.provider,
      model: r.model,
      role: r.role,
      source: r.source,
      costUsd: s.costUsd,
      estimated: s.estimated,
      tokens: s.tokens,
      turns: s.turns,
      lastAt: s.lastAt,
      pr: info?.pr ?? null,
    };
  });

  const byAutomation = new Map<string, { costUsd: number; sessions: Set<string> }>();
  let manual = 0;
  let automation = 0;
  let factory = 0;
  for (const r of inRange) {
    if (r.source === "factory") factory += r.costUsd;
    else if (r.source === "automation") automation += r.costUsd;
    else manual += r.costUsd;
    if (r.automationId) {
      const a = byAutomation.get(r.automationId) ?? { costUsd: 0, sessions: new Set<string>() };
      a.costUsd += r.costUsd;
      a.sessions.add(r.sessionId);
      byAutomation.set(r.automationId, a);
    }
  }

  const mergedSessions = sessions.filter((s) => names.merged(s.sessionId));
  const mergedPrs = new Set(
    mergedSessions.map((s) => {
      const pr = names.session(s.sessionId)?.pr;
      return pr ? `${s.first.projectId}#${pr.number}` : s.sessionId;
    }),
  );
  const mergedCost = mergedSessions.reduce((a, s) => a + s.costUsd, 0);
  const providers = new Set(inRange.map((r) => r.provider));

  return {
    query: q,
    timezone,
    days,
    totals,
    previousTotals: totalsOf(previous),
    series,
    topSessions,
    automations: {
      manualCostUsd: round(manual),
      automationCostUsd: round(automation),
      factoryCostUsd: round(factory),
      byAutomation: [...byAutomation.entries()]
        .map(([automationId, a]) => ({
          automationId,
          name: names.automation(automationId) ?? automationId,
          costUsd: round(a.costUsd),
          sessions: a.sessions.size,
        }))
        .sort((a, b) => b.costUsd - a.costUsd),
    },
    averages: {
      perSessionUsd: totals.sessions > 0 ? round(totals.costUsd / totals.sessions) : null,
      perMergedPrUsd: mergedPrs.size > 0 ? round(mergedCost / mergedPrs.size) : null,
      mergedPrs: mergedPrs.size,
    },
    billing: Object.fromEntries([...providers].map((p) => [p, billing[p] ?? "unknown"])),
  };
}

function round(n: number): number {
  return Math.round(n * 1e6) / 1e6;
}

const CSV_COLUMNS = [
  "timestamp",
  "day",
  "session_id",
  "turn_id",
  "project_id",
  "project",
  "provider",
  "model",
  "role",
  "source",
  "automation_id",
  "input_tokens",
  "output_tokens",
  "cache_read_tokens",
  "cache_write_tokens",
  "reasoning_tokens",
  "cost_usd",
  "cost_source",
] as const;

function csvCell(value: string | number | null): string {
  if (value === null) return "";
  const s = String(value);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** The ledger rows of a query as CSV, one line per turn, oldest first. */
export function toCsv(rows: PricedRow[], q: UsageQuery, names: ReportNames): string {
  const lines = [CSV_COLUMNS.join(",")];
  const sorted = [...filterRows(rows, q)].sort((a, b) => a.ts.localeCompare(b.ts));
  for (const r of sorted) {
    lines.push(
      [
        r.ts,
        r.day,
        r.sessionId,
        r.turnId,
        r.projectId,
        r.projectId ? names.project(r.projectId) : null,
        r.provider,
        r.model,
        r.role,
        r.source,
        r.automationId,
        r.inputTokens,
        r.outputTokens,
        r.cacheReadTokens,
        r.cacheWriteTokens,
        r.reasoningTokens,
        r.costUsd.toFixed(6),
        r.costSource,
      ]
        .map(csvCell)
        .join(","),
    );
  }
  return `${lines.join("\r\n")}\r\n`;
}

import type {
  UsageDimension,
  UsageQuery,
  UsageReport,
  UsageSeries,
  UsageSettings,
  UsageTotals,
} from "@codeden/contracts";
import type { UsageApi } from "./api";

/** Sample usage for the mock client (`VITE_CODEDEN_MOCK=1`): deterministic, never persisted. */

const MODELS = [
  { key: "claude-opus-5-5", provider: "claude", weight: 0.46 },
  { key: "claude-sonnet-5-5", provider: "claude", weight: 0.28 },
  { key: "gpt-5.3-codex", provider: "codex", weight: 0.2 },
  { key: "claude-haiku-5-5", provider: "claude", weight: 0.06 },
];

function days(from: string, to: string): string[] {
  const out: string[] = [];
  for (let d = new Date(`${from}T00:00:00Z`); d.toISOString().slice(0, 10) <= to; ) {
    out.push(d.toISOString().slice(0, 10));
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return out;
}

function daily(day: string, i: number): number {
  const weekday = new Date(`${day}T00:00:00Z`).getUTCDay();
  const base = weekday === 0 || weekday === 6 ? 3 : 11;
  return Math.round((base + ((i * 7919) % 13) * 0.9) * 100) / 100;
}

function series(dayList: string[], parts: { key: string; label: string; weight: number }[]) {
  const total = dayList.map(daily);
  return parts.map((p): UsageSeries => {
    const cost = total.map((t) => Math.round(t * p.weight * 100) / 100);
    return {
      key: p.key,
      label: p.label,
      costUsd: cost.reduce((a, b) => a + b, 0),
      estimatedCostUsd: p.key.startsWith("gpt") ? cost.reduce((a, b) => a + b, 0) : 0,
      tokens: Math.round(cost.reduce((a, b) => a + b, 0) * 410_000),
      turns: Math.round(cost.reduce((a, b) => a + b, 0) * 3),
      sessions: Math.round(cost.reduce((a, b) => a + b, 0) / 2),
      dailyCostUsd: cost,
      dailyTokens: cost.map((c) => Math.round(c * 410_000)),
    };
  });
}

function totals(cost: number): UsageTotals {
  return {
    inputTokens: Math.round(cost * 9_000),
    outputTokens: Math.round(cost * 21_000),
    cacheReadTokens: Math.round(cost * 360_000),
    cacheWriteTokens: Math.round(cost * 20_000),
    reasoningTokens: Math.round(cost * 6_000),
    costUsd: cost,
    estimatedCostUsd: cost * 0.2,
    unpricedTurns: 0,
    turns: Math.round(cost * 3),
    sessions: Math.round(cost / 2),
    cacheHitRate: 0.88,
  };
}

export function mockReport(q: UsageQuery): UsageReport {
  const dayList = days(q.from, q.to);
  const bySeries: Record<UsageDimension, UsageSeries[]> = {
    model: series(
      dayList,
      MODELS.map((m) => ({ ...m, label: m.key })),
    ),
    provider: series(dayList, [
      { key: "claude", label: "Claude", weight: 0.8 },
      { key: "codex", label: "Codex", weight: 0.2 },
    ]),
    project: series(dayList, [
      { key: "p-web", label: "storefront", weight: 0.55 },
      { key: "p-api", label: "payments-api", weight: 0.35 },
      { key: "", label: "No project", weight: 0.1 },
    ]),
    role: series(dayList, [
      { key: "agent", label: "Agent", weight: 0.82 },
      { key: "pm", label: "Project manager", weight: 0.12 },
      { key: "orchestrator", label: "Orchestrator", weight: 0.06 },
    ]),
    source: series(dayList, [
      { key: "user", label: "You", weight: 0.7 },
      { key: "automation", label: "Automations", weight: 0.18 },
      { key: "factory", label: "Factory", weight: 0.12 },
    ]),
  };
  const cost = bySeries.provider.reduce((a, s) => a + s.costUsd, 0);
  return {
    query: q,
    timezone: "UTC",
    days: dayList,
    totals: totals(cost),
    previousTotals: totals(cost * 0.86),
    series: bySeries,
    topSessions: [
      ["Fix checkout race on retry", "storefront", "claude-opus-5-5", 9.12],
      ["Stripe webhook idempotency", "payments-api", "gpt-5.3-codex", 6.4],
      ["Nightly security audit", "payments-api", "claude-sonnet-5-5", 3.95],
    ].map(([title, projectName, model, costUsd], i) => ({
      sessionId: `mock-s${i}`,
      title: String(title),
      projectId: null,
      projectName: String(projectName),
      provider: String(model).startsWith("gpt") ? "codex" : "claude",
      model: String(model),
      role: "agent" as const,
      source: i === 2 ? ("automation" as const) : ("user" as const),
      costUsd: Number(costUsd),
      estimated: String(model).startsWith("gpt"),
      tokens: Math.round(Number(costUsd) * 400_000),
      turns: 12 - i * 3,
      lastAt: new Date().toISOString(),
      pr: null,
    })),
    automations: {
      manualCostUsd: cost * 0.7,
      automationCostUsd: cost * 0.18,
      factoryCostUsd: cost * 0.12,
      byAutomation: [
        { automationId: "a1", name: "Security audit", costUsd: cost * 0.11, sessions: 6 },
        { automationId: "a2", name: "Dependency updates", costUsd: cost * 0.07, sessions: 9 },
      ],
    },
    averages: { perSessionUsd: 2.1, perMergedPrUsd: 6.8, mergedPrs: 11 },
    billing: { claude: "subscription", codex: "subscription" },
  };
}

let settings: UsageSettings = { prices: [], budgets: [], rateLimitWarnPercent: 85, timezone: null };

export const mockUsageApi: UsageApi = {
  report: async (q) => mockReport(q),
  session: async (sessionId) => ({
    sessionId,
    totals: totals(1.84),
    billing: "subscription",
    turns: [],
    // The checkout transcript's Explore subagent, priced at Sonnet 5.5's list prices.
    subagents: [
      {
        itemId: "ck-explore",
        costUsd: 0.19173,
        costSource: "estimated",
        models: [
          {
            model: "claude-sonnet-5-5",
            label: "Sonnet 5.5",
            inputTokens: 1_240,
            outputTokens: 3_180,
            cacheReadTokens: 412_000,
            cacheWriteTokens: 46_500,
            reasoningTokens: 0,
            costUsd: 0.19173,
            costSource: "estimated",
          },
        ],
      },
    ],
  }),
  project: async (projectId) => ({
    projectId,
    todayUsd: 4.2,
    last7Usd: 38.6,
    monthUsd: 61.1,
    estimated: false,
    dailyUsd: Array.from({ length: 14 }, (_, i) => daily("2026-11-02", i) * 0.5),
    topModel: "claude-opus-5-5",
    budgets: [],
    billing: { claude: "subscription" },
  }),
  limits: async () => ({
    windows: [
      {
        provider: "claude",
        windowId: "5h",
        label: "5-hour window",
        status: "ok",
        usedPercent: 42,
        usedPercentAt: new Date().toISOString(),
        resetsAt: new Date(Date.now() + 2.5 * 3_600_000).toISOString(),
        observedAt: new Date().toISOString(),
        stale: false,
      },
      // Status and reset time only: Claude reported no percentage for this window yet.
      {
        provider: "claude",
        windowId: "weekly",
        label: "Weekly",
        status: "ok",
        usedPercent: null,
        usedPercentAt: null,
        resetsAt: new Date(Date.now() + 4 * 86_400_000).toISOString(),
        observedAt: new Date(Date.now() - 60_000).toISOString(),
        stale: false,
      },
      {
        provider: "claude",
        windowId: "weekly-opus",
        label: "Weekly (Opus)",
        status: "ok",
        usedPercent: 18,
        usedPercentAt: new Date(Date.now() - 20 * 60_000).toISOString(),
        resetsAt: new Date(Date.now() + 4 * 86_400_000).toISOString(),
        observedAt: new Date(Date.now() - 60_000).toISOString(),
        stale: false,
      },
    ],
    warnPercent: settings.rateLimitWarnPercent,
    billing: { claude: "subscription" },
  }),
  budgets: async () => ({ budgets: [] }),
  settings: async () => ({ settings, bundledPrices: [] }),
  saveSettings: async (next) => {
    settings = next;
    return { settings, bundledPrices: [] };
  },
  csvUrl: () => "data:text/csv,timestamp",
};

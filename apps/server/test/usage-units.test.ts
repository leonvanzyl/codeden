import type { ModelPrice, UsageBudget } from "@codeden/contracts";
import { describe, expect, it } from "vitest";
import {
  dayKey,
  daysBetween,
  type PricedRow,
  seriesOf,
  totalsOf,
} from "../src/services/usage/aggregate";
import {
  budgetAlerts,
  budgetStatus,
  periodStart,
  rateLimitAlerts,
  toWindow,
} from "../src/services/usage/alerts";
import { deltaFromTotals } from "../src/services/usage/backfill";
import { billingFromAuthMethod } from "../src/services/usage/billing";
import { reportedCost, sourceOf } from "../src/services/usage/ledger";
import { costOf, findPrice, priceTokens } from "../src/services/usage/prices";
import { toCsv } from "../src/services/usage/report";

const row = (extra: Partial<PricedRow> = {}): PricedRow => ({
  sessionId: "s1",
  turnId: "t1",
  projectId: "p1",
  provider: "claude",
  model: "claude-sonnet-4-5",
  role: "agent",
  source: "user",
  automationId: null,
  inputTokens: 100,
  outputTokens: 50,
  cacheReadTokens: 800,
  cacheWriteTokens: 100,
  reasoningTokens: 0,
  reportedCostUsd: 0.5,
  costUsd: 0.5,
  costSource: "reported",
  ts: "2026-11-07T10:00:00.000Z",
  day: "2026-11-07",
  ...extra,
});

describe("price table", () => {
  it("matches exact ids, dated snapshots, aliases and context suffixes", () => {
    expect(findPrice("claude", "claude-sonnet-4-5")?.inputPerMTok).toBe(3);
    expect(findPrice("claude", "claude-sonnet-4-5-20250929")?.label).toBe("Sonnet 4.5");
    expect(findPrice("claude", "claude-opus-5-5")?.label).toBe("Opus 5.5");
    expect(findPrice("claude", "claude-opus-5-20260101")?.label).toBe("Opus 5");
    expect(findPrice("claude", "claude-opus-5-5[1m]")?.label).toBe("Opus 5.5");
    expect(findPrice("claude", "sonnet")?.label).toBe("Sonnet (latest)");
    expect(findPrice("claude", "claude-fable-5-2")).toMatchObject({
      label: "Fable 5.2",
      inputPerMTok: 8,
      outputPerMTok: 40,
      cacheReadPerMTok: 0.2,
      cacheWritePerMTok: 10,
    });
    // `claude-fable-5` must not swallow `claude-fable-5-2`, nor 5.1 its own id.
    expect(findPrice("claude", "claude-fable-5-1")?.label).toBe("Fable 5.1");
    expect(findPrice("claude", "fable")).toMatchObject({
      label: "Fable (latest)",
      inputPerMTok: 8,
    });
    expect(findPrice("codex", "gpt-5.1-codex-mini")?.inputPerMTok).toBe(0.25);
    // `gpt-5` must not swallow `gpt-5.5`.
    expect(findPrice("codex", "gpt-5.5")?.inputPerMTok).toBe(5);
    expect(findPrice("codex", "mystery-model")).toBeNull();
    expect(findPrice("fake", "default")).toBeNull();
  });

  it("prices OpenCode's vendor/model ids from the vendor's table", () => {
    expect(findPrice("opencode", "anthropic/claude-opus-5-5")?.label).toBe("Opus 5.5");
    expect(findPrice("opencode", "anthropic/claude-sonnet-4-5-20250929")?.label).toBe("Sonnet 4.5");
    expect(findPrice("opencode", "openai/gpt-5.5")?.inputPerMTok).toBe(5);
    expect(findPrice("opencode", "openrouter/anthropic/claude-opus-5-5")).toBeNull();
    expect(findPrice("opencode", "zai/glm-5")).toBeNull();
    expect(findPrice("opencode", "default")).toBeNull();
    // A user's own price for the full OpenCode id wins.
    const override = {
      provider: "opencode",
      model: "openai/gpt-5.5",
      label: "Mine",
      inputPerMTok: 1,
      outputPerMTok: 2,
      cacheReadPerMTok: 0,
      cacheWritePerMTok: 0,
      asOf: "2026-11-10",
    };
    expect(findPrice("opencode", "openai/gpt-5.5", [override])?.label).toBe("Mine");
  });

  it("lets user overrides win over the bundled table", () => {
    const override: ModelPrice = {
      provider: "claude",
      model: "claude-sonnet-4-5",
      inputPerMTok: 1,
      outputPerMTok: 1,
      cacheReadPerMTok: 0,
      cacheWritePerMTok: 0,
      asOf: "2026-11-07",
    };
    expect(findPrice("claude", "claude-sonnet-4-5-20250929", [override])?.inputPerMTok).toBe(1);
  });

  it("prices tokens and labels the cost source", () => {
    const price = findPrice("claude", "claude-sonnet-4-5") as ModelPrice;
    // 1M input at $3 + 1M output at $15 + 1M reads at $0.30 + 1M writes at $3.75
    const tokens = {
      inputTokens: 1e6,
      outputTokens: 1e6,
      cacheReadTokens: 1e6,
      cacheWriteTokens: 1e6,
      reasoningTokens: 0,
    };
    expect(priceTokens(tokens, price)).toBeCloseTo(22.05, 6);
    const base = { ...tokens, provider: "claude", model: "claude-sonnet-4-5" };
    expect(costOf({ ...base, reportedCostUsd: 1.5 })).toEqual({
      costUsd: 1.5,
      costSource: "reported",
    });
    expect(costOf({ ...base, reportedCostUsd: null }).costSource).toBe("estimated");
    expect(costOf({ ...base, provider: "fake", reportedCostUsd: null })).toEqual({
      costUsd: 0,
      costSource: "unpriced",
    });
  });
});

describe("ledger deltas", () => {
  it("reads reported cost honestly", () => {
    expect(reportedCost({ inputTokens: 5, costUsd: 0.02 })).toBe(0.02);
    expect(reportedCost({ inputTokens: 5 })).toBeNull();
    expect(reportedCost({ inputTokens: 5, costUsd: 0 })).toBeNull();
    expect(reportedCost({ costUsd: 0 })).toBe(0);
  });

  it("turns stored running totals into per-turn usage and detects restarts", () => {
    const first = { inputTokens: 100, outputTokens: 10, costUsd: 0.1 };
    expect(deltaFromTotals(first, undefined)).toEqual(first);
    expect(deltaFromTotals({ inputTokens: 150, outputTokens: 30, costUsd: 0.25 }, first)).toEqual({
      inputTokens: 50,
      outputTokens: 20,
      costUsd: 0.15,
    });
    // A smaller total means the provider process restarted: the report is the turn's own.
    expect(deltaFromTotals({ inputTokens: 40, outputTokens: 5, costUsd: 0.03 }, first)).toEqual({
      inputTokens: 40,
      outputTokens: 5,
      costUsd: 0.03,
    });
  });

  it("classifies who started the work", () => {
    expect(sourceOf("user", "dark_factory")).toBe("user");
    expect(sourceOf("pm", "dark_factory")).toBe("factory");
    expect(sourceOf("automation", "software_factory")).toBe("factory");
    expect(sourceOf("automation", "assisted")).toBe("automation");
    expect(sourceOf("orchestrator", null)).toBe("orchestrator");
  });

  it("maps auth methods to billing modes", () => {
    expect(billingFromAuthMethod("claude.ai")).toBe("subscription");
    expect(billingFromAuthMethod("chatgpt")).toBe("subscription");
    // A Cursor login or key bills the Cursor plan.
    expect(billingFromAuthMethod("cursor")).toBe("subscription");
    expect(billingFromAuthMethod("cursor_key")).toBe("subscription");
    expect(billingFromAuthMethod("api_key")).toBe("api");
    expect(billingFromAuthMethod("an API key")).toBe("api");
    expect(billingFromAuthMethod(null)).toBe("unknown");
  });
});

describe("aggregation", () => {
  it("buckets instants into local days", () => {
    expect(dayKey("2026-11-07T23:30:00.000Z", "UTC")).toBe("2026-11-07");
    expect(dayKey("2026-11-07T23:30:00.000Z", "Africa/Johannesburg")).toBe("2026-11-08");
    expect(dayKey("2026-11-07T03:00:00.000Z", "America/Los_Angeles")).toBe("2026-11-06");
    expect(daysBetween("2026-10-30", "2026-11-02")).toEqual([
      "2026-10-30",
      "2026-10-31",
      "2026-11-01",
      "2026-11-02",
    ]);
  });

  it("totals tokens, cost, estimates and cache hit rate", () => {
    const t = totalsOf([
      row(),
      row({ sessionId: "s2", costSource: "estimated", costUsd: 0.25, reportedCostUsd: null }),
      row({ sessionId: "s2", turnId: "t2", provider: "fake", costSource: "unpriced", costUsd: 0 }),
    ]);
    expect(t.costUsd).toBeCloseTo(0.75);
    expect(t.estimatedCostUsd).toBeCloseTo(0.25);
    expect(t.unpricedTurns).toBe(1);
    expect(t.turns).toBe(3);
    expect(t.sessions).toBe(2);
    expect(t.cacheHitRate).toBeCloseTo(0.8);
    expect(totalsOf([]).cacheHitRate).toBeNull();
  });

  it("builds daily stacked series and folds the long tail into Other", () => {
    const days = ["2026-11-06", "2026-11-07"];
    const rows = [
      row({ day: "2026-11-06", costUsd: 1 }),
      row({ model: "a", costUsd: 3 }),
      row({ model: "b", costUsd: 2 }),
      row({ model: "c", costUsd: 0.5 }),
    ];
    const series = seriesOf(rows, days, "model", (k) => k.toUpperCase(), 2);
    expect(series.map((s) => s.key)).toEqual(["a", "b", "__other"]);
    expect(series[2]).toMatchObject({ label: "Other (2)", costUsd: 1.5, dailyCostUsd: [1, 0.5] });
    expect(series[0]?.label).toBe("A");
  });

  it("escapes CSV cells", () => {
    const names = {
      project: () => 'My "app", v2',
      automation: () => null,
      session: () => null,
      merged: () => false,
    };
    const csv = toCsv([row()], { from: "2026-11-07", to: "2026-11-07" }, names);
    const [header, line] = csv.trim().split("\r\n");
    expect(header?.startsWith("timestamp,day,session_id")).toBe(true);
    expect(line).toContain('"My ""app"", v2"');
    expect(line).toContain("0.500000,reported");
  });
});

describe("budgets and rate limits", () => {
  const budget: UsageBudget = {
    id: "b1",
    projectId: null,
    period: "monthly",
    limitUsd: 100,
    warnAtPercent: 80,
    enabled: true,
  };

  it("computes periods and states", () => {
    expect(periodStart("daily", "2026-11-07")).toBe("2026-11-07");
    expect(periodStart("monthly", "2026-11-07")).toBe("2026-11-01");
    expect(budgetStatus(budget, 50, "2026-11-01").state).toBe("ok");
    expect(budgetStatus(budget, 85, "2026-11-01")).toMatchObject({ state: "warning", percent: 85 });
    expect(budgetStatus(budget, 120, "2026-11-01").state).toBe("exceeded");
  });

  it("raises one alert per budget, period and level", () => {
    const warn = budgetAlerts([budgetStatus(budget, 85, "2026-11-01")], () => "x");
    expect(warn).toHaveLength(1);
    expect(warn[0]).toMatchObject({
      id: "inbox:usage:budget:b1:2026-11-01:warning",
      priority: "normal",
    });
    expect(warn[0]?.title).toContain("All projects spent $85.00 of $100.00");
    const over = budgetAlerts(
      [budgetStatus({ ...budget, projectId: "p1" }, 120, "2026-11-01")],
      () => "Shop",
    );
    expect(over[0]).toMatchObject({ priority: "high", projectId: "p1" });
    expect(over[0]?.title).toContain("Monthly budget exceeded: Shop");
    expect(budgetAlerts([budgetStatus({ ...budget, enabled: false }, 120, "x")], () => "")).toEqual(
      [],
    );
  });

  it("warns near a rate limit and ignores windows that already reset", () => {
    const now = Date.parse("2026-11-07T10:00:00.000Z");
    const base = {
      provider: "claude",
      windowId: "5h",
      status: "ok" as const,
      usedPercent: 90,
      resetsAt: "2026-11-07T12:00:00.000Z",
      observedAt: "2026-11-07T09:59:00.000Z",
    };
    const current = toWindow(base, now);
    // A row from before `used_percent_at` existed dates its figure with the reading.
    expect(current).toMatchObject({
      label: "5-hour window",
      stale: false,
      usedPercentAt: base.observedAt,
    });
    expect(toWindow({ ...base, windowId: "weekly-haiku" }, now).label).toBe("Weekly (Haiku)");
    const stale = toWindow({ ...base, resetsAt: "2026-11-07T09:00:00.000Z" }, now);
    expect(stale.stale).toBe(true);
    const alerts = rateLimitAlerts([current, stale], 85);
    expect(alerts).toHaveLength(1);
    expect(alerts[0]?.title).toBe("Claude 5-hour window at 90%");
    expect(rateLimitAlerts([toWindow({ ...base, usedPercent: 40 }, now)], 85)).toEqual([]);
    const limited = rateLimitAlerts(
      [toWindow({ ...base, windowId: "weekly", status: "limited", usedPercent: null }, now)],
      85,
    );
    expect(limited[0]).toMatchObject({ priority: "high", title: "Claude weekly limit reached" });
  });
});

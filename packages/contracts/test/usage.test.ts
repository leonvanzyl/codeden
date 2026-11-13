import { describe, expect, it } from "vitest";
import {
  ModelPrice,
  RateLimitWindow,
  SessionUsage,
  UsageBudget,
  UsageEntry,
  UsageQuery,
  UsageSettings,
} from "../src";

const totals = {
  inputTokens: 10,
  outputTokens: 20,
  cacheReadTokens: 300,
  cacheWriteTokens: 40,
  reasoningTokens: 5,
  costUsd: 0.12,
  estimatedCostUsd: 0,
  unpricedTurns: 0,
  turns: 1,
  sessions: 1,
  cacheHitRate: 0.86,
};

describe("usage contracts", () => {
  it("fills settings defaults", () => {
    expect(UsageSettings.parse({})).toEqual({
      prices: [],
      budgets: [],
      rateLimitWarnPercent: 85,
      timezone: null,
    });
    expect(
      UsageBudget.parse({ id: "b1", projectId: null, period: "daily", limitUsd: 5 }),
    ).toMatchObject({ warnAtPercent: 80, enabled: true });
    expect(
      UsageBudget.safeParse({ id: "b", projectId: null, period: "daily", limitUsd: 0 }).success,
    ).toBe(false);
  });

  it("round-trips ledger rows, prices, limits and session usage", () => {
    const entry = {
      sessionId: "s1",
      turnId: "t1",
      projectId: null,
      provider: "claude",
      model: "claude-sonnet-4-5",
      role: "agent",
      source: "user",
      automationId: null,
      inputTokens: 1,
      outputTokens: 2,
      cacheReadTokens: 3,
      cacheWriteTokens: 4,
      reasoningTokens: 0,
      reportedCostUsd: 0.01,
      costUsd: 0.01,
      costSource: "reported",
      ts: "2026-11-07T10:00:00.000Z",
    };
    expect(UsageEntry.parse(entry)).toEqual(entry);
    const price = {
      provider: "codex",
      model: "gpt-5.2",
      inputPerMTok: 1.75,
      outputPerMTok: 14,
      cacheReadPerMTok: 0.175,
      cacheWritePerMTok: 0,
      asOf: "2026-11-07",
    };
    expect(ModelPrice.parse(price)).toEqual(price);
    const window = {
      provider: "claude",
      windowId: "5h",
      label: "5-hour",
      status: "warning",
      usedPercent: 91,
      resetsAt: "2026-11-07T12:00:00.000Z",
      observedAt: "2026-11-07T10:00:00.000Z",
      stale: false,
    };
    expect(RateLimitWindow.parse(window)).toEqual(window);
    const subagent = {
      itemId: "toolu_1",
      costUsd: 0.0421,
      costSource: "estimated",
      models: [
        {
          model: "claude-haiku-5-5",
          label: "Haiku 5.5",
          inputTokens: 12,
          outputTokens: 900,
          cacheReadTokens: 410_000,
          cacheWriteTokens: 38_000,
          reasoningTokens: 0,
          costUsd: 0.0421,
          costSource: "estimated",
        },
      ],
    };
    const session = {
      sessionId: "s1",
      totals,
      billing: "subscription",
      turns: [],
      subagents: [subagent],
    };
    expect(SessionUsage.parse(session)).toEqual(session);
    // A response from before subagent costs reads as having none.
    const { subagents: _none, ...older } = session;
    expect(SessionUsage.parse(older).subagents).toEqual([]);
  });

  it("validates report queries", () => {
    expect(UsageQuery.safeParse({ from: "2026-11-01", to: "2026-11-07" }).success).toBe(true);
    expect(UsageQuery.safeParse({ from: "yesterday", to: "2026-11-07" }).success).toBe(false);
  });
});

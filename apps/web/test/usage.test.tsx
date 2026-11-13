import type { RateLimitsResponse, RateLimitWindow, SubagentCost } from "@codeden/contracts";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { BreakdownTable } from "@/components/usage/breakdown";
import {
  money,
  percent,
  subagentCostLines,
  subagentCostText,
  tokens,
  trend,
} from "@/components/usage/format";
import { mockReport } from "@/components/usage/mock-data";
import { colorSlots } from "@/components/usage/palette";
import { presetRange } from "@/components/usage/range-picker";
import { RateLimitMeters } from "@/components/usage/rate-limits";
import { costIsCurrent } from "@/components/usage/subagent-cost";
import { TopSessionsTable } from "@/components/usage/top-sessions";
import { UsageTotals } from "@/components/usage/totals";
import { ReportsPage } from "@/routes/reports";
import { renderWithClient } from "./utils";

const report = mockReport({ from: "2026-11-01", to: "2026-11-07" });

describe("usage formatting", () => {
  it("formats money, estimates, tokens, shares and trends", () => {
    expect(money(3.2)).toBe("$3.20");
    expect(money(0.042)).toBe("$0.042");
    expect(money(1284)).toBe("$1,284");
    expect(money(3.2, true)).toBe("≈ $3.20");
    expect(money(0, true)).toBe("$0.00");
    expect(tokens(12_400_000)).toBe("12M");
    expect(tokens(1_460_000)).toBe("1.5M");
    expect(tokens(860_200)).toBe("860k");
    expect(percent(0.004)).toBe("<1%");
    expect(percent(null)).toBe("—");
    expect(trend(112, 100)).toEqual({ text: "+12%", up: true });
    expect(trend(96, 100)).toEqual({ text: "−4%", up: false });
    expect(trend(5, 0)).toBeNull();
  });

  it("labels a subagent's cost and explains it per model", () => {
    const model = (name: string, costUsd: number, costSource: SubagentCost["costSource"]) => ({
      model: name,
      inputTokens: 1_200,
      outputTokens: 300,
      cacheReadTokens: 40_000,
      cacheWriteTokens: 15_000,
      reasoningTokens: 0,
      costUsd,
      costSource,
    });
    const reported: SubagentCost = {
      itemId: "a1",
      costUsd: 0.42,
      costSource: "reported",
      models: [{ ...model("anthropic/claude-opus-5-5", 0.42, "reported"), label: "Opus 5.5" }],
    };
    expect(subagentCostText(reported)).toBe("$0.42");
    expect(subagentCostLines(reported, "api")).toEqual([
      "Subagent cost",
      "Opus 5.5: $0.42 · 1k input · 300 output · 40k cache reads · 15k cache writes",
    ]);
    const partly: SubagentCost = {
      itemId: "a1",
      costUsd: 0.0123,
      costSource: "estimated",
      models: [model("claude-haiku-5-5", 0.0123, "estimated"), model("mystery", 0, "unpriced")],
    };
    expect(subagentCostText(partly)).toBe("≈ $0.012");
    expect(subagentCostLines(partly, "subscription")).toEqual([
      "API-equivalent cost (estimated from list prices) · not priced: mystery",
      "claude-haiku-5-5: ≈ $0.012 · 1k input · 300 output · 40k cache reads · 15k cache writes",
      "mystery: not priced · 1k input · 300 output · 40k cache reads · 15k cache writes",
    ]);
    const none: SubagentCost = {
      ...partly,
      costSource: "unpriced",
      models: [model("x", 0, "unpriced")],
    };
    expect(subagentCostText(none)).toBeNull();
    expect(subagentCostLines(none, "api")[0]).toBe("Not priced: no price for x");
    expect(subagentCostText(undefined)).toBeNull();
    expect(subagentCostLines(undefined, "api")).toEqual([]);
  });

  describe("whether a subagent's cost priced what its card shows", () => {
    const tokens = {
      inputTokens: 1_200,
      outputTokens: 300,
      cacheReadTokens: 40_000,
      cacheWriteTokens: 15_000,
    };
    /** What the server returns for `usage` priced at `models` (one per entry, in order). */
    const pricedAs = (
      models: { model: string; costUsd?: number; reported?: boolean; tokens?: object }[],
    ): SubagentCost => ({
      itemId: "a1",
      costUsd: 0.1,
      costSource: "estimated",
      models: models.map((m) => ({
        ...tokens,
        reasoningTokens: 0,
        ...m.tokens,
        model: m.model,
        costUsd: m.costUsd ?? 0.05,
        costSource: m.reported ? "reported" : "estimated",
      })),
    });
    const haiku = { model: "claude-haiku-5-5", ...tokens };

    it("matches the same figures, with an unnamed model priced as the session's", () => {
      expect(costIsCurrent(pricedAs([{ model: "claude-haiku-5-5" }]), [haiku])).toBe(true);
      expect(costIsCurrent(pricedAs([{ model: "claude-sonnet-4-5" }]), [tokens])).toBe(true);
      // A zero reported with tokens is no figure: the server estimated it.
      expect(
        costIsCurrent(pricedAs([{ model: "claude-haiku-5-5" }]), [{ ...haiku, costUsd: 0 }]),
      ).toBe(true);
      expect(
        costIsCurrent(pricedAs([{ model: "x", costUsd: 1.5, reported: true }]), [
          { ...haiku, model: "x", costUsd: 1.5 },
        ]),
      ).toBe(true);
    });

    it("sees changed token counts, models, allocations and reported costs", () => {
      const priced = pricedAs([{ model: "claude-haiku-5-5" }]);
      expect(costIsCurrent(undefined, [haiku])).toBe(false);
      expect(costIsCurrent(priced, [{ ...haiku, outputTokens: 900 }])).toBe(false);
      expect(costIsCurrent(priced, [{ ...haiku, reasoningTokens: 40 }])).toBe(false);
      // The same totals, but another model.
      expect(costIsCurrent(priced, [{ ...haiku, model: "claude-opus-5-5" }])).toBe(false);
      // The provider now reports a cost for the same tokens.
      expect(costIsCurrent(priced, [{ ...haiku, costUsd: 1.5 }])).toBe(false);
      expect(
        costIsCurrent(pricedAs([{ model: "x", costUsd: 1.5, reported: true }]), [
          { ...haiku, model: "x", costUsd: 2 },
        ]),
      ).toBe(false);
      // The same totals moved between two models.
      const half = {
        inputTokens: 600,
        outputTokens: 150,
        cacheReadTokens: 20_000,
        cacheWriteTokens: 7_500,
      };
      const split = pricedAs([
        { model: "claude-haiku-5-5", tokens: half },
        { model: "claude-opus-5-5", tokens: half },
      ]);
      const moved = [
        { model: "claude-haiku-5-5", ...half, outputTokens: 50 },
        { model: "claude-opus-5-5", ...half, outputTokens: 250 },
      ];
      expect(costIsCurrent(split, moved)).toBe(false);
      // A model added.
      expect(costIsCurrent(priced, [haiku, { ...haiku, model: "claude-opus-5-5" }])).toBe(false);
    });
  });

  it("computes preset ranges ending today", () => {
    expect(presetRange("7d", "2026-11-07")).toEqual({
      preset: "7d",
      from: "2026-11-01",
      to: "2026-11-07",
    });
    expect(presetRange("today", "2026-11-07").from).toBe("2026-11-07");
  });

  it("gives providers fixed colors and other values the palette in order", () => {
    const slots = colorSlots(["storefront", "claude", "docs", "codex"]);
    expect(slots.get("claude")).toBe(1);
    expect(slots.get("codex")).toBe(0);
    expect(slots.get("storefront")).toBe(2);
    expect(slots.get("docs")).toBe(3);
    expect(new Set(colorSlots(["a", "b", "c", "d", "e", "f", "g", "h"]).values()).size).toBe(8);
  });
});

describe("usage components", () => {
  it("labels subscription costs as API-equivalent and marks estimates", () => {
    renderWithClient(<UsageTotals report={report} />);
    expect(screen.getByText("API-equivalent cost")).toBeTruthy();
    expect(screen.getByTestId("usage-total").textContent).toMatch(/^≈ \$/);
    expect(screen.getByText("Per merged PR")).toBeTruthy();
    expect(screen.getByText("11 merged PRs")).toBeTruthy();
  });

  it("narrows the report from a breakdown row", () => {
    const onPick = vi.fn();
    renderWithClient(<BreakdownTable report={report} dimension="provider" onPick={onPick} />);
    fireEvent.click(screen.getByText("Codex"));
    expect(onPick).toHaveBeenCalledWith("codex");
  });

  it("links top sessions to their transcripts", async () => {
    renderWithClient(<TopSessionsTable sessions={report.topSessions} />, undefined, {
      withRouter: true,
    });
    const link = await screen.findByRole("link", { name: "Fix checkout race on retry" });
    expect(link.getAttribute("href")).toBe("/sessions/mock-s0");
  });

  it("shows rate-limit meters with warnings and stale readings", () => {
    const base: RateLimitWindow = {
      provider: "claude",
      windowId: "5h",
      label: "5-hour window",
      status: "ok",
      usedPercent: 91,
      usedPercentAt: new Date().toISOString(),
      resetsAt: new Date(Date.now() + 3_600_000).toISOString(),
      observedAt: new Date().toISOString(),
      stale: false,
    };
    const data: RateLimitsResponse = {
      windows: [base, { ...base, windowId: "weekly", label: "Weekly", stale: true }],
      warnPercent: 85,
      billing: { claude: "subscription" },
    };
    renderWithClient(<RateLimitMeters data={data} />);
    const tones = screen.getAllByTestId("limit-window").map((el) => el.dataset.tone);
    expect(tones).toEqual(["warning", "stale"]);
    expect(screen.getByText("91% used")).toBeTruthy();
    expect(screen.getByText("reset since")).toBeTruthy();
    expect(screen.getByText("Subscription login")).toBeTruthy();
  });

  // #193: Claude often reports a window's status and reset time without a percentage.
  it("shows the known status instead of '— used' and an empty bar when the percentage is unknown", () => {
    const base: RateLimitWindow = {
      provider: "claude",
      windowId: "weekly",
      label: "Weekly",
      status: "ok",
      usedPercent: null,
      usedPercentAt: null,
      resetsAt: new Date(Date.now() + 3 * 86_400_000).toISOString(),
      observedAt: new Date().toISOString(),
      stale: false,
    };
    const data: RateLimitsResponse = {
      windows: [
        base,
        { ...base, windowId: "5h", label: "5-hour window", status: "warning" },
        { ...base, windowId: "weekly-opus", label: "Weekly (Opus)", status: "limited" },
      ],
      warnPercent: 85,
      billing: { claude: "subscription" },
    };
    renderWithClient(<RateLimitMeters data={data} />);
    expect(screen.queryByText(/—/)).toBeNull();
    expect(screen.queryAllByRole("meter")).toHaveLength(0);
    expect(screen.getByText("Within limit")).toBeTruthy();
    expect(screen.getByText("Close to the limit")).toBeTruthy();
    expect(screen.getByText(/Limit reached/)).toBeTruthy();
    expect(screen.getAllByText(/^Resets /)).toHaveLength(3);
  });

  it("explains empty rate limits", () => {
    renderWithClient(<RateLimitMeters data={{ windows: [], warnPercent: 85, billing: {} }} />);
    expect(screen.getByText(/No limit readings yet/)).toBeTruthy();
  });

  it("renders the reports screen from the usage API", async () => {
    renderWithClient(<ReportsPage />, undefined, { withRouter: true });
    await waitFor(() => expect(screen.getByTestId("usage-total")).toBeTruthy());
    expect(screen.getByText("Daily spend")).toBeTruthy();
    expect(screen.getByText("Top sessions by cost")).toBeTruthy();
    expect(screen.getByText("Budgets and alerts")).toBeTruthy();
    fireEvent.click(screen.getByRole("tab", { name: "Provider" }));
    fireEvent.click(await screen.findByText("Codex"));
    expect(
      await screen.findByRole("button", { name: /Remove filter Provider: Codex/ }),
    ).toBeTruthy();
  });
});

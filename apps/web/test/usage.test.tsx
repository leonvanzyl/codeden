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

    // A cost is current while it priced the tokens the card shows.
    const shown = [
      { inputTokens: 1_200, outputTokens: 300, cacheReadTokens: 40_000, cacheWriteTokens: 15_000 },
    ];
    expect(costIsCurrent(reported, shown)).toBe(true);
    expect(costIsCurrent(reported, [{ ...shown[0], outputTokens: 900 } as never])).toBe(false);
    expect(costIsCurrent(undefined, shown)).toBe(false);
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

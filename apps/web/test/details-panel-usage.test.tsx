import type { Session, SessionUsage, Usage, UsageTotals } from "@codeden/contracts";
import { screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { mockUsageApi } from "@/components/usage/mock-data";
import { DetailsPanel } from "@/components/workbench/details-panel";
import { makeSession } from "@/lib/api/mock/fixtures/helpers";
import { emptyTranscript } from "@/lib/transcript/reducer";
import { useTranscriptsStore } from "@/stores/transcripts";
import { renderWithClient } from "./utils";

const ID = "s-usage";

const session = (over: Partial<Session> = {}): Session =>
  makeSession({
    id: ID,
    projectId: "p-storefront",
    role: "agent",
    status: "idle",
    provider: "codex",
    model: "default",
    purpose: "Check the usage figures",
    workKey: "issue:144",
    ...over,
  });

/** What the provider last reported live (the transcript store's `usage`). */
function liveUsage(usage: Usage | null) {
  useTranscriptsStore.setState({ byId: { [ID]: { ...emptyTranscript(ID), usage } } });
}

/** The session's ledger figures, as `GET /api/usage/sessions/:id` returns them. */
function ledger(totals: Partial<UsageTotals>, billing: SessionUsage["billing"] = "api") {
  vi.spyOn(mockUsageApi, "session").mockResolvedValue({
    sessionId: ID,
    billing,
    turns: [],
    totals: {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      reasoningTokens: 0,
      costUsd: 0,
      estimatedCostUsd: 0,
      unpricedTurns: 0,
      turns: 0,
      sessions: 1,
      cacheHitRate: null,
      ...totals,
    },
  });
}

afterEach(() => {
  useTranscriptsStore.setState({ byId: {} });
  vi.restoreAllMocks();
});

/** The Context window section: its text and bar width (null when there is no bar). */
async function contextWindow(expected: string) {
  const heading = await screen.findByText("Context window");
  const section = heading.closest("section") as HTMLElement;
  await waitFor(() => expect(section.textContent).toContain(expected));
  const bar = section.querySelector<HTMLElement>(".bg-primary");
  return { text: section.textContent ?? "", barWidth: bar?.style.width ?? null };
}

function render(over: Partial<Session> = {}) {
  renderWithClient(<DetailsPanel session={session(over)} />, undefined, { withRouter: true });
}

const MADE_UP = ["68k", "200k", "$1.84"];

describe("DetailsPanel context window (§12.6: cost sources are labelled honestly)", () => {
  it("shows no figures for a session that has not reported usage yet", async () => {
    ledger({ turns: 0 });
    render();
    const { text, barWidth } = await contextWindow("No usage yet");
    for (const figure of MADE_UP) expect(text).not.toContain(figure);
    expect(text).toContain("—");
    expect(barWidth).toBeNull();
  });

  it("shows a Codex session's estimated ledger cost when the provider reports none", async () => {
    liveUsage({ contextTokens: 12_000, contextWindow: 272_000, inputTokens: 9_000 });
    ledger({ turns: 2, costUsd: 0.12, estimatedCostUsd: 0.12 });
    render();
    const { text, barWidth } = await contextWindow("≈ $0.12 this session");
    expect(text).toContain("12K / 272K tokens");
    for (const figure of MADE_UP) expect(text).not.toContain(figure);
    expect(Number.parseFloat(barWidth ?? "")).toBeCloseTo((12_000 / 272_000) * 100);
  });

  it("labels a subscription's cost as API-equivalent and shows no bar without a window", async () => {
    liveUsage({ contextTokens: 50_000, costUsd: 0.05 });
    ledger({ turns: 3, costUsd: 0.42 }, "subscription");
    render({ provider: "claude", model: "opus" });
    const { text, barWidth } = await contextWindow("$0.42 API-equivalent");
    expect(text).toContain("50K / — tokens");
    expect(text).not.toContain("$0.05");
    for (const figure of MADE_UP) expect(text).not.toContain(figure);
    expect(barWidth).toBeNull();
  });

  it("says a session is not priced instead of showing a cost", async () => {
    liveUsage({ inputTokens: 4_000 });
    ledger({ turns: 2, unpricedTurns: 2 });
    render();
    const { text, barWidth } = await contextWindow("Not priced");
    expect(text).not.toContain("$");
    for (const figure of MADE_UP) expect(text).not.toContain(figure);
    expect(barWidth).toBeNull();
  });
});

import {
  type FactoryItem,
  FactoryLimits,
  FactoryStatus,
  type FactoryWorkItem,
} from "@codeden/contracts";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { PipelineBoard } from "@/components/factory-view/pipeline-board";
import { viewPipeline } from "@/components/factory-view/stages";
import { createMockClient } from "@/lib/api/mock";
import { renderWithClient } from "./utils";

/**
 * Issue #265: the "Needs you" lane showed three failed cards while the header said "0 need you",
 * and its cards offered nothing to do. The lane and the header count the same thing, and each
 * card says what is needed and offers the action.
 */

const NOW = new Date(2026, 10, 14, 15, 0, 0).getTime();
const minutesAgo = (m: number) => new Date(NOW - m * 60_000).toISOString();

function w(id: string, n: number, patch: Partial<FactoryWorkItem>): FactoryWorkItem {
  return {
    id,
    title: `Item ${n}`,
    workKey: `issue:${n}`,
    issue: { number: n, url: `https://github.com/acme/shop/issues/${n}` },
    pr: null,
    score: null,
    sessionId: null,
    reviewerSessionId: null,
    activeSessionId: null,
    stage: "failed",
    step: "stopped",
    type: "bug",
    trust: "trusted",
    author: "octocat",
    source: "issue",
    attempts: 0,
    reason: "The builder session stopped without a pull request",
    note: null,
    failureKind: "checks",
    stepSince: minutesAgo(60),
    mergedAt: null,
    finishedAt: minutesAgo(60),
    checks: null,
    ownedPr: null,
    recovering: false,
    updatedAt: minutesAgo(60),
    ...patch,
  };
}

function status(recent: FactoryWorkItem[]): FactoryStatus {
  return FactoryStatus.parse({
    projectId: "p1",
    mode: "software_factory",
    experimental: true,
    loopState: "idle",
    pausedReason: null,
    killSwitch: false,
    globalKillSwitch: false,
    limits: FactoryLimits.parse({ dailyBudget: { usd: 20 } }),
    tuning: {},
    spendToday: { usd: 0, tokens: 0 },
    mergesToday: 0,
    consecutiveFailures: 0,
    activeSessions: 0,
    backlog: [],
    inProgress: [],
    mergeChecks: [],
    recent,
    visionExists: true,
    lastDigest: null,
    lastTickAt: null,
  });
}

// The three cards of the report: two builders stopped, one finished, none with a PR.
const reported = status([
  w("i234", 234, {}),
  w("i91", 91, {}),
  w("i189", 189, {
    reason: "The builder finished without a pull request (success: No pull request is needed)",
  }),
]);

const prRef = (n: number) => ({
  number: n,
  url: `https://github.com/acme/shop/pull/${n}`,
  state: "open" as const,
});

// One card of each kind that waits on a person, and one the factory recovers by itself.
const variants = status([
  w("escalated", 1, { stage: "escalated", step: "merge", pr: prRef(11), ownedPr: prRef(11) }),
  w("rounds", 2, { attempts: 3, pr: prRef(12), ownedPr: prRef(12) }),
  w("no-pr", 3, {}),
  w("asking", 4, {
    stage: "building",
    step: "implement",
    activeSessionId: "s4",
    failureKind: null,
    reason: null,
    finishedAt: null,
  }),
  w("recovering", 5, { failureKind: "infrastructure", recovering: true }),
]);
const asking = new Map([["s4", { status: "waiting" as const, progress: null }]]);

describe("the Factory view's needs-you lane (#265)", () => {
  it("counts what the lane lists in the header", () => {
    const p = viewPipeline(reported, new Map(), NOW);
    expect(p.needsYou).toHaveLength(3);
    expect(p.needsPerson).toBe(p.needsYou.length);
    // With every kind of need, and a failure the factory puts back by itself.
    const all = viewPipeline(variants, asking, NOW);
    expect(all.needsPerson).toBe(all.needsYou.length);
    expect(all.needsYou.map((c) => c.item.id)).toEqual(["escalated", "rounds", "no-pr", "asking"]);
    expect(all.stages.building.map((c) => c.item.id)).toEqual(["recovering"]);
  });

  it("says what each card needs", () => {
    const p = viewPipeline(variants, asking, NOW);
    expect(p.needsYou.map((c) => [c.item.id, c.need?.kind, c.need?.label])).toEqual([
      ["escalated", "merge", "Review and merge PR #11"],
      ["rounds", "retry", "Retry: stopped after 3 review rounds"],
      ["no-pr", "retry_or_dismiss", "Retry or dismiss: stopped without a pull request"],
      ["asking", "answer", "Answer the agent's question"],
    ]);
  });

  it("offers each needs-you card its action", () => {
    const p = viewPipeline(reported, new Map(), NOW);
    renderWithClient(<PipelineBoard f={reported} pipeline={p} now={NOW} onOpen={() => {}} />);
    const lane = screen.getByTestId("factory-view-needs-you");
    expect(within(lane).getAllByRole("button", { name: /retry/i })).toHaveLength(3);
    expect(within(lane).getAllByRole("button", { name: /dismiss/i })).toHaveLength(3);
  });

  it("gives every kind of card its button, and the buttons act in place", async () => {
    const client = createMockClient();
    const retry = vi.spyOn(client.factory, "retry").mockResolvedValue({} as FactoryItem);
    const dismiss = vi.spyOn(client.factory, "dismiss").mockResolvedValue({} as FactoryItem);
    const p = viewPipeline(variants, asking, NOW);
    renderWithClient(
      <PipelineBoard f={variants} pipeline={p} now={NOW} onOpen={() => {}} />,
      client,
      { withRouter: true },
    );
    const lane = await screen.findByTestId("factory-view-needs-you");
    const need = (kind: string) =>
      within(lane)
        .getAllByTestId("factory-view-need")
        .find((n) => n.dataset.need === kind) as HTMLElement;
    expect(within(need("merge")).getByRole("button", { name: /open pr/i })).toBeTruthy();
    expect(within(need("retry")).getByRole("button", { name: "Retry #2" })).toBeTruthy();
    expect(within(need("retry")).queryByRole("button", { name: /dismiss/i })).toBeNull();
    expect(
      within(need("answer"))
        .getByRole("link", { name: /answer/i })
        .getAttribute("href"),
    ).toBe("/sessions/s4");
    fireEvent.click(within(need("retry_or_dismiss")).getByRole("button", { name: "Dismiss #3" }));
    await waitFor(() => expect(dismiss).toHaveBeenCalledWith("p1", "no-pr"));
    fireEvent.click(within(need("retry")).getByRole("button", { name: "Retry #2" }));
    await waitFor(() => expect(retry).toHaveBeenCalledWith("p1", "rounds"));
  });
});

import {
  FactoryLimits,
  type FactoryPrEntry,
  FactoryStatus,
  type FactoryWorkItem,
} from "@codeden/contracts";
import { describe, expect, it } from "vitest";
import { stepTrail } from "@/components/factory-view/item-sheet";
import {
  describeMoves,
  placesOf,
  type SessionInfo,
  viewPipeline,
} from "@/components/factory-view/stages";
import { openPrs, shortDuration, viewStats } from "@/components/factory-view/view-stats";

/**
 * Issue #181: the Factory view places every work item on one stage of the pipeline, puts what
 * waits on a person in its own lane, and shows the panel's figures.
 */

const NOW = new Date(2026, 10, 13, 15, 0, 0).getTime();
const minutesAgo = (m: number) => new Date(NOW - m * 60_000).toISOString();
const url = (n: number) => `https://github.com/acme/shop/issues/${n}`;
const prRef = (n: number, state: "open" | "merged" | "closed" = "open") => ({
  number: n,
  url: `https://github.com/acme/shop/pull/${n}`,
  state,
});

function w(id: string, n: number, patch: Partial<FactoryWorkItem>): FactoryWorkItem {
  return {
    id,
    title: `Item ${n}`,
    workKey: `issue:${n}`,
    issue: { number: n, url: url(n) },
    pr: null,
    score: null,
    sessionId: null,
    reviewerSessionId: null,
    activeSessionId: null,
    stage: "building",
    step: "implement",
    type: "feature",
    trust: "trusted",
    author: "octocat",
    source: "issue",
    attempts: 0,
    reason: null,
    note: null,
    failureKind: null,
    stepSince: minutesAgo(10),
    mergedAt: null,
    finishedAt: null,
    updatedAt: minutesAgo(1),
    ...patch,
  };
}

const pr = (itemId: string, n: number, patch: Partial<FactoryPrEntry>): FactoryPrEntry => ({
  itemId,
  title: `PR ${n}`,
  pr: prRef(n),
  state: "checking",
  queuePosition: null,
  note: null,
  ...patch,
});

function status(patch: Partial<FactoryStatus> = {}): FactoryStatus {
  return FactoryStatus.parse({
    projectId: "p1",
    mode: "dark_factory",
    experimental: true,
    loopState: "building",
    pausedReason: null,
    killSwitch: false,
    globalKillSwitch: false,
    limits: FactoryLimits.parse({ dailyBudget: { usd: 20 }, autoMerge: true }),
    tuning: {},
    spendToday: { usd: 12, tokens: 900_000 },
    mergesToday: 2,
    consecutiveFailures: 1,
    activeSessions: 2,
    backlog: [],
    inProgress: [],
    mergeChecks: [],
    recent: [],
    visionExists: true,
    lastDigest: null,
    lastTickAt: null,
    ...patch,
  });
}

const backlog = [
  w("candidate", 1, { stage: "candidate", step: "intake", type: null }),
  w("queued", 2, { stage: "backlog", step: "queued", type: "bug" }),
];
const inProgress = [
  w("analyze", 3, { stage: "building", step: "analyze", sessionId: "s3", activeSessionId: "s3" }),
  w("implement", 4, { stage: "building", step: "implement", stepSince: minutesAgo(40) }),
  w("review", 5, { stage: "verifying", step: "review", activeSessionId: "s5r", sessionId: "s5" }),
  w("second", 6, { stage: "verifying", step: "merge", pr: prRef(16) }),
  w("first", 7, { stage: "verifying", step: "merge", pr: prRef(17) }),
  w("yours", 8, { stage: "verifying", step: "merge", pr: prRef(18) }),
  w("watching", 9, { stage: "watching", step: "merge", mergedAt: minutesAgo(5) }),
];
const recent = [
  w("merged", 10, { stage: "merged", step: "done", mergedAt: minutesAgo(30) }),
  w("old-merge", 11, { stage: "merged", step: "done", mergedAt: minutesAgo(60 * 30) }),
  w("escalated", 12, { stage: "escalated", step: "merge", reason: "Touches payments" }),
  w("failed", 13, { stage: "failed", step: "stopped", finishedAt: minutesAgo(60), reason: "x" }),
  w("old-fail", 14, { stage: "failed", step: "stopped", finishedAt: minutesAgo(60 * 40) }),
  w("old-fail-pr", 15, {
    stage: "failed",
    step: "stopped",
    finishedAt: minutesAgo(60 * 40),
    pr: prRef(25),
  }),
  w("rejected", 19, { stage: "rejected", step: "stopped" }),
  w("reverted", 20, { stage: "reverted", step: "stopped" }),
];
const pullRequests = [
  pr("first", 17, { state: "updating", queuePosition: 1 }),
  pr("second", 16, { state: "queued", queuePosition: 2, note: "Number 2 in line" }),
  pr("yours", 18, { state: "waiting_for_you" }),
  pr("old-fail-pr", 25, { state: "waiting_for_you" }),
  pr("merged", 30, { state: "merged" }),
];
const sessions = new Map<string, SessionInfo>([
  ["s3", { status: "running", progress: "Reading the checkout code" }],
  ["s5r", { status: "waiting", progress: null }],
]);
const f = status({ backlog, inProgress, recent, pullRequests });

describe("the Factory view's pipeline (#181)", () => {
  const p = viewPipeline(f, sessions, NOW);
  const ids = (cards: { item: { id: string } }[]) => cards.map((c) => c.item.id);

  it("puts each live item on exactly one stage", () => {
    expect(ids(p.stages.intake)).toEqual(["candidate"]);
    expect(ids(p.stages.type)).toEqual(["queued"]);
    // Longest in its step first.
    expect(ids(p.stages.building)).toEqual(["implement", "analyze"]);
    expect(ids(p.stages.reviewing)).toEqual(["review"]);
    expect(ids(p.stages.merged)).toEqual(["watching", "merged"]);
    expect(ids(p.needsYou)).toEqual(["escalated", "failed", "old-fail-pr"]);
    const all = [...Object.values(p.stages).flat(), ...p.needsYou].map((c) => c.item.id);
    expect(new Set(all).size).toBe(all.length);
    // Yesterday's merge, an old failure without a PR, rejected and reverted work stay off.
    for (const gone of ["old-merge", "old-fail", "rejected", "reverted"])
      expect(all).not.toContain(gone);
  });

  it("orders the merge queue as it merges, then the PRs that aren't queued", () => {
    expect(ids(p.stages.merge)).toEqual(["first", "second", "yours"]);
    expect(p.stages.merge.map((c) => c.pr?.state)).toEqual([
      "updating",
      "queued",
      "waiting_for_you",
    ]);
  });

  it("marks what runs, waits, needs a person or failed, and counts them", () => {
    const state = (id: string) =>
      [...Object.values(p.stages).flat(), ...p.needsYou].find((c) => c.item.id === id)?.state;
    expect(state("analyze")).toBe("running");
    expect(state("implement")).toBe("waiting");
    // The reviewer waits on the user's answer.
    expect(state("review")).toBe("person");
    expect(state("yours")).toBe("person");
    expect(state("escalated")).toBe("person");
    expect(state("failed")).toBe("failed");
    expect(state("watching")).toBe("running");
    expect(state("merged")).toBe("done");
    expect(p.needsPerson).toBe(3);
    expect(p.failed).toBe(2);
  });

  it("says what each card is doing, and since when", () => {
    const card = (id: string) =>
      [...Object.values(p.stages).flat(), ...p.needsYou].find((c) => c.item.id === id);
    expect(card("analyze")?.activity).toBe("Reading the checkout code");
    expect(card("second")?.activity).toBe("Number 2 in line");
    expect(card("escalated")?.activity).toBe("Touches payments");
    expect(card("queued")?.activity).toBe("Waiting for an agent");
    expect(card("implement")?.since).toBe(minutesAgo(40));
    // Before `stepSince` existed: the last update.
    const old = viewPipeline(
      status({ inProgress: [w("legacy", 40, { stepSince: null, updatedAt: minutesAgo(7) })] }),
      new Map(),
      NOW,
    );
    expect(old.stages.building[0]?.since).toBe(minutesAgo(7));
    // The reviewer is the session at work while reviewing.
    expect(card("review")?.sessionId).toBe("s5r");
  });

  it("announces cards that move, and none that stay", () => {
    const before = placesOf(p);
    expect(describeMoves(before, p)).toEqual([]);
    const moved = viewPipeline(
      status({
        backlog: [backlog[0] as FactoryWorkItem],
        inProgress: [
          ...inProgress,
          w("queued", 2, { stage: "building", step: "reproduce", type: "bug" }),
          w("new", 50, { stage: "building", step: "implement" }),
        ],
        recent,
        pullRequests,
      }),
      sessions,
      NOW,
    );
    expect(describeMoves(before, moved)).toEqual(
      expect.arrayContaining(["#2 moved to Building.", "#50 arrived in Building."]),
    );
    expect(describeMoves(before, moved)).toHaveLength(2);
  });
});

describe("the Factory view's figures (#181)", () => {
  const byId = (s: FactoryStatus) => Object.fromEntries(viewStats(s).map((t) => [t.id, t]));

  it("shows the panel's spend, merges and agents, and the open PRs", () => {
    const t = byId(f);
    expect(t.spend).toMatchObject({ value: "$12", detail: "of $20" });
    expect(t.spend?.bar).toEqual({ value: 12, max: 20, warn: true });
    expect(t.merges).toMatchObject({ value: "2", detail: "of 5 a day" });
    expect(t.agents).toMatchObject({ value: "2", detail: "of 2" });
    // Merged and superseded PRs aren't open.
    expect(openPrs(f)).toHaveLength(4);
    expect(t.prs).toMatchObject({ value: "4", detail: "2 for you" });
  });

  it("counts merges without a cap when auto-merge is off, and spend in tokens without dollars", () => {
    const t = byId(
      status({
        limits: FactoryLimits.parse({ dailyBudget: { tokens: 2_000_000 }, autoMerge: false }),
        stats: {
          mergedToday: 4,
          failedToday: 1,
          revertedToday: 0,
          medianMergeMs7d: 2.5 * 3_600_000,
          merged7d: 6,
        },
      }),
    );
    expect(t.merges).toMatchObject({ value: "4", detail: "auto-merge off" });
    expect(t.merges?.bar).toBeUndefined();
    expect(t.spend).toMatchObject({ value: "900K", detail: "of 2M tokens" });
    expect(t.failures).toMatchObject({ value: "1 · 0", alert: true });
    expect(t.median).toMatchObject({ value: "2h 30m", detail: "median of 6 merges, 7 days" });
  });

  it("shows no median without merges", () => {
    expect(byId(f).median).toMatchObject({ value: "—", detail: "no merges in 7 days" });
    expect(shortDuration(20_000)).toBe("1m");
    expect(shortDuration(45 * 60_000)).toBe("45m");
    expect(shortDuration(3 * 86_400_000)).toBe("3.0d");
  });
});

describe("the item sheet's steps (#181)", () => {
  const marks = (item: Parameters<typeof stepTrail>[0]) =>
    stepTrail(item).map((s) => `${s.step}:${s.mark}`);

  it("marks the steps of the item's pipeline done, current or next", () => {
    expect(marks({ type: "bug", step: "implement", mergedAt: null })).toEqual([
      "intake:done",
      "reproduce:done",
      "implement:current",
      "review:next",
      "merge:next",
    ]);
    // Queued: typed, waiting on its first step.
    expect(marks({ type: "docs", step: "queued", mergedAt: null })).toEqual([
      "intake:done",
      "implement:next",
      "review:next",
      "merge:next",
    ]);
    expect(marks({ type: "feature", step: "merge", mergedAt: minutesAgo(3) })).toEqual([
      "intake:done",
      "analyze:done",
      "implement:done",
      "review:done",
      "merge:done",
    ]);
  });
});

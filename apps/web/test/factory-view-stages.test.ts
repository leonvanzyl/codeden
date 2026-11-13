import {
  FactoryLimits,
  type FactoryPrEntry,
  FactoryStatus,
  type FactoryWorkItem,
} from "@codeden/contracts";
import { describe, expect, it } from "vitest";
import { latestTurns } from "@/components/factory-view/latest-turns";
import {
  currentPr,
  describeMoves,
  placesOf,
  prLabel,
  type SessionInfo,
  viewPipeline,
} from "@/components/factory-view/stages";
import { stepTrail } from "@/components/factory-view/step-trail";
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
    checks: null,
    ownedPr: null,
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
    // Merged and done: nobody has to act, nothing runs.
    expect(state("merged")).toBe("waiting");
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
    stepTrail(item).map((s) => `${s.step}:${s.mark}${s.note ? ` (${s.note})` : ""}`);

  it("marks the steps of the item's pipeline done, current or next", () => {
    expect(marks({ type: "bug", step: "implement", stage: "building" })).toEqual([
      "intake:done",
      "reproduce:done",
      "implement:current",
      "review:next",
      "merge:next",
    ]);
  });

  it("marks the waiting step of a queued item and keeps Merge current while CI is watched", () => {
    // Queued: typed, waiting for an agent on its first step.
    expect(marks({ type: "docs", step: "queued", stage: "backlog" })).toEqual([
      "intake:done",
      "implement:current (Waiting for a free agent)",
      "review:next",
      "merge:next",
    ]);
    // Merged automatically, main CI still watched: not done yet.
    expect(marks({ type: "feature", step: "merge", stage: "watching" })).toEqual([
      "intake:done",
      "analyze:done",
      "implement:done",
      "review:done",
      "merge:current (Merged; watching CI on the default branch)",
    ]);
    expect(
      marks({ type: "feature", step: "done", stage: "merged" }).every((m) => m.endsWith(":done")),
    ).toBe(true);
    // A stopped item has no current step.
    expect(
      stepTrail({ type: "bug", step: "stopped", stage: "failed" }).some(
        (s) => s.mark === "current",
      ),
    ).toBe(false);
  });
});

describe("the factory's pull requests on the view (#181)", () => {
  it("keeps an item's current PR and queue place when a superseded PR is listed after it", () => {
    // As the server lists them: the queue first, then the others, superseded ones among them.
    const prs = [
      pr("a", 11, { state: "updating", queuePosition: 1 }),
      pr("b", 12, { state: "queued", queuePosition: 2 }),
      pr("a", 9, { state: "superseded", note: "Superseded by #11: closing it" }),
    ];
    const items = [
      w("a", 1, { stage: "verifying", step: "merge", pr: prRef(11) }),
      w("b", 2, { stage: "verifying", step: "merge", pr: prRef(12) }),
    ];
    expect(currentPr(items[0] as FactoryWorkItem, prs)?.pr.number).toBe(11);
    const p = viewPipeline(status({ inProgress: items, pullRequests: prs }), new Map(), NOW);
    expect(p.stages.merge.map((c) => [c.item.id, c.pr?.pr.number, c.pr?.queuePosition])).toEqual([
      ["a", 11, 1],
      ["b", 12, 2],
    ]);
    // A rebuild has no PR of its own yet: the replaced PR it lists is the one that counts.
    expect(
      currentPr(w("r", 3, { pr: null }), [
        pr("r", 7, { state: "superseded" }),
        pr("r", 8, { state: "rebuilding" }),
      ])?.state,
    ).toBe("rebuilding");
  });

  it("keeps a stuck PR in the merge queue as waiting on a person, and counts it", () => {
    // How the server shows one: the item failed for good (`stuck`), its PR still open.
    const stuck = w("stuck", 30, {
      stage: "failed",
      step: "stopped",
      failureKind: "stuck",
      pr: prRef(30),
      reason: "Rebuilt once and still conflicting",
      finishedAt: minutesAgo(60 * 48),
    });
    const p = viewPipeline(
      status({
        recent: [stuck],
        pullRequests: [pr("stuck", 30, { state: "stuck", note: "In your inbox" })],
      }),
      new Map(),
      NOW,
    );
    expect(p.needsYou).toEqual([]);
    expect(p.stages.merge.map((c) => [c.item.id, c.state])).toEqual([["stuck", "person"]]);
    expect(p.needsPerson).toBe(1);
    // It still failed: the header counts it there too.
    expect(p.failed).toBe(1);
  });

  it("says the PR's state with its queue place", () => {
    const labels = { updating: "Updating", rebasing: "Rebasing", waiting_ci: "Waiting for CI" };
    expect(prLabel(pr("a", 1, { state: "updating", queuePosition: 1 }), labels)).toBe(
      "Updating · #1",
    );
    expect(prLabel(pr("a", 1, { state: "queued", queuePosition: 2 }), labels)).toBe("Queued #2");
    expect(prLabel(pr("a", 1, { state: "rebasing" }), labels)).toBe("Rebasing");
    expect(prLabel(pr("a", 1, { state: "checking" }), labels)).toBeNull();
    expect(prLabel(null, labels)).toBeNull();
  });
});

describe("finished work beyond the recent list (#181)", () => {
  it("shows escalations, open failures and today's merges that 30 newer results pushed out", () => {
    const newer = Array.from({ length: 30 }, (_, n) =>
      w(`rejected-${n}`, 200 + n, { stage: "rejected", step: "stopped" }),
    );
    const viewRecent = [
      w("escalated", 40, {
        stage: "escalated",
        step: "merge",
        finishedAt: minutesAgo(60 * 24 * 9),
      }),
      w("open-fail", 41, {
        stage: "failed",
        step: "stopped",
        pr: prRef(41),
        finishedAt: minutesAgo(60 * 24 * 3),
      }),
      w("merged", 42, { stage: "merged", step: "done", mergedAt: minutesAgo(90) }),
    ];
    const p = viewPipeline(
      status({
        recent: newer,
        viewRecent,
        pullRequests: [pr("open-fail", 41, { state: "waiting_for_you" })],
      }),
      new Map(),
      NOW,
    );
    expect(p.needsYou.map((c) => c.item.id)).toEqual(["escalated", "open-fail"]);
    expect(p.stages.merged.map((c) => c.item.id)).toEqual(["merged"]);
    expect(p.needsPerson).toBe(1);
    expect(p.failed).toBe(1);
  });

  it("passes each item's check counts to its card", () => {
    const p = viewPipeline(
      status({
        inProgress: [
          w("rev", 50, {
            stage: "verifying",
            step: "review",
            checks: { passed: 5, failed: 1, total: 8 },
          }),
        ],
      }),
      new Map(),
      NOW,
    );
    expect(p.stages.reviewing[0]?.item.checks).toEqual({ passed: 5, failed: 1, total: 8 });
  });
});

describe("the quick chat's latest turns (#181)", () => {
  it("keeps the latest turns of the thread and counts the ones it cut", () => {
    const turnIds = ["t1", "t2", "t3", "t4", "t5"];
    const items = Object.fromEntries(
      turnIds.flatMap((t) => [
        [`${t}-u`, { turnId: t, threadId: "root", item: { id: `${t}-u` } }],
        [`${t}-a`, { turnId: t, threadId: "root", item: { id: `${t}-a` } }],
      ]),
    );
    const transcript = {
      sessionId: "s",
      seq: 1,
      rootThreadId: "root",
      threads: {
        root: {
          id: "root",
          parentThreadId: null,
          parentItemId: null,
          title: null,
          agentType: null,
          itemIds: Object.keys(items),
          turnIds,
        },
      },
      turns: {},
      items,
      usage: null,
      title: null,
      model: null,
    } as unknown as Parameters<typeof latestTurns>[0];
    const { transcript: cut, hidden } = latestTurns(transcript, "root", 3);
    expect(hidden).toBe(2);
    expect(cut.threads.root?.turnIds).toEqual(["t3", "t4", "t5"]);
    expect(cut.threads.root?.itemIds).toEqual(["t3-u", "t3-a", "t4-u", "t4-a", "t5-u", "t5-a"]);
    // Short chats are left alone.
    expect(latestTurns(transcript, "root", 5)).toEqual({ transcript, hidden: 0 });
  });
});

describe("work the capped PR list leaves out (#181)", () => {
  it("keeps an open failure the PR list doesn't have, from the item's own PR", () => {
    const open = w("open-fail", 60, {
      stage: "failed",
      step: "stopped",
      failureKind: "checks",
      pr: prRef(60),
      ownedPr: prRef(60),
      finishedAt: minutesAgo(60 * 24 * 3),
    });
    // Listed by the server as still mattering, with no PR-list entry.
    const fromViewRecent = viewPipeline(status({ viewRecent: [open] }), new Map(), NOW);
    expect(fromViewRecent.needsYou.map((c) => [c.item.id, c.state])).toEqual([
      ["open-fail", "failed"],
    ]);
    expect(fromViewRecent.failed).toBe(1);
    // Only in `recent` (an older server): its own open PR still keeps it.
    const fromRecent = viewPipeline(
      status({ recent: [{ ...open, ownedPr: null }] }),
      new Map(),
      NOW,
    );
    expect(fromRecent.needsYou.map((c) => c.item.id)).toEqual(["open-fail"]);
  });

  it("treats a failed rebuild that owns its original PR as stuck in the merge queue", () => {
    // The rebuild failed before opening a PR: no PR of its own, the original still the factory's.
    const rebuild = w("rebuild", 61, {
      stage: "failed",
      step: "stopped",
      failureKind: "stuck",
      pr: null,
      ownedPr: prRef(52),
      finishedAt: minutesAgo(60 * 24 * 2),
    });
    const p = viewPipeline(status({ viewRecent: [rebuild] }), new Map(), NOW);
    expect(p.stages.merge.map((c) => [c.item.id, c.state])).toEqual([["rebuild", "person"]]);
    expect(p.needsPerson).toBe(1);
    expect(p.failed).toBe(1);
    // With its PR-list entry, that entry decides.
    const listed = viewPipeline(
      status({ viewRecent: [rebuild], pullRequests: [pr("rebuild", 52, { state: "stuck" })] }),
      new Map(),
      NOW,
    );
    expect(listed.stages.merge[0]?.pr?.pr.number).toBe(52);
  });

  it("leaves out an old failure that owns nothing and that the server no longer lists", () => {
    const old = w("old", 62, {
      stage: "failed",
      step: "stopped",
      finishedAt: minutesAgo(60 * 24 * 4),
    });
    const p = viewPipeline(status({ recent: [old] }), new Map(), NOW);
    expect(p.needsYou).toEqual([]);
    expect(p.failed).toBe(0);
  });
});

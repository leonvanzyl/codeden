import {
  FactoryLimits,
  type FactoryPrEntry,
  FactoryStatus,
  type FactoryWorkItem,
  type ScoutStatus,
} from "@codeden/contracts";
import { describe, expect, it } from "vitest";
import { sceneTargets } from "@/components/factory-view/pixel/layout";
import {
  budgetGauge,
  type Scene,
  sceneEvents,
  sceneOf,
  sceneSummary,
} from "@/components/factory-view/pixel/scene-model";
import { type SessionInfo, viewPipeline } from "@/components/factory-view/stages";

/**
 * Issue #209: pixel mode maps the factory's live state to a floor of workers, tickets, crates
 * and machines. Only the mapping is tested: which things exist, on which slot, in which pose.
 */

const NOW = new Date(2026, 10, 13, 15, 0, 0).getTime();
const minutesAgo = (m: number) => new Date(NOW - m * 60_000).toISOString();
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
    issue: { number: n, url: `https://github.com/acme/shop/issues/${n}` },
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

const prEntry = (itemId: string, n: number, patch: Partial<FactoryPrEntry>): FactoryPrEntry => ({
  itemId,
  title: `PR ${n}`,
  pr: prRef(n),
  state: "checking",
  queuePosition: null,
  note: null,
  ...patch,
});

const scoutStatus: ScoutStatus = {
  phase: "reviewing",
  sessionId: "scout",
  lenses: [
    { area: "ux", sessionId: "l1", reported: true, active: false },
    { area: "performance", sessionId: "l2", reported: false, active: true },
    { area: "security", sessionId: "l3", reported: false, active: false },
  ],
  findings: 3,
  filed: 1,
  lastRoundAt: null,
  nextRoundAt: null,
  rounds: 4,
  runNowBlockedBy: null,
};

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
    stats: { mergedToday: 7 },
    consecutiveFailures: 0,
    activeSessions: 2,
    backlog: [],
    inProgress: [],
    mergeChecks: [],
    recent: [],
    visionExists: true,
    lastDigest: null,
    lastTickAt: null,
    scout: scoutStatus,
    ...patch,
  });
}

const backlog = [
  w("new", 1, { stage: "candidate", step: "intake", type: null }),
  w("sorted-bug", 2, { stage: "backlog", step: "queued", type: "bug" }),
  w("sorted-docs", 3, { stage: "backlog", step: "queued", type: "docs" }),
];
const inProgress = [
  w("hammering", 4, { stage: "building", step: "implement", activeSessionId: "s4" }),
  w("asking", 5, { stage: "building", step: "analyze", activeSessionId: "s5" }),
  w("idle", 6, { stage: "building", step: "implement" }),
  w("review", 7, { stage: "verifying", step: "review", activeSessionId: "s7" }),
  w("second", 8, { stage: "verifying", step: "merge", pr: prRef(18) }),
  w("first", 9, { stage: "verifying", step: "merge", pr: prRef(19) }),
  w("yours", 10, { stage: "verifying", step: "merge", pr: prRef(20) }),
  w("watching", 11, { stage: "watching", step: "merge", mergedAt: minutesAgo(5) }),
];
const recent = [
  w("merged", 12, { stage: "merged", step: "done", mergedAt: minutesAgo(30) }),
  w("escalated", 13, { stage: "escalated", step: "merge", reason: "Touches payments" }),
  w("failed", 14, { stage: "failed", step: "stopped", finishedAt: minutesAgo(60), reason: "x" }),
];
const pullRequests = [
  prEntry("first", 19, { state: "queued", queuePosition: 1 }),
  prEntry("second", 18, { state: "queued", queuePosition: 2 }),
  prEntry("yours", 20, { state: "waiting_for_you" }),
];
const sessions = new Map<string, SessionInfo>([
  ["s4", { status: "running", progress: "Wiring the wishlist button" }],
  ["s5", { status: "waiting", progress: null }],
  ["s7", { status: "running", progress: null }],
]);

function sceneFor(patch: Partial<FactoryStatus> = {}, live = sessions): Scene {
  const f = status({ backlog, inProgress, recent, pullRequests, ...patch });
  return sceneOf(f, viewPipeline(f, live, NOW));
}

const ids = (items: { card: { item: { id: string } } }[]) => items.map((x) => x.card.item.id);

describe("pixel mode's scene (#209)", () => {
  const scene = sceneFor();

  it("piles new and sorted issues as tickets at the door, tinted once sorted", () => {
    expect(ids(scene.tickets.items)).toEqual(["new", "sorted-bug", "sorted-docs"]);
    expect(scene.tickets.items.map((t) => [t.slot, t.tint])).toEqual([
      [0, "paper"],
      [1, "bug"],
      [2, "docs"],
    ]);
  });

  it("puts one worker at a bench per build, posed by its session", () => {
    expect(scene.builders.items.map((b) => [b.card.item.id, b.slot, b.pose])).toEqual([
      ["hammering", 0, "work"],
      ["asking", 1, "ask"],
      ["idle", 2, "idle"],
    ]);
    // The builder's speech bubble is its session's progress line.
    expect(scene.builders.items[0]?.card.activity).toBe("Wiring the wishlist button");
  });

  it("has a reviewer with a clipboard per review", () => {
    expect(scene.reviewers.items.map((r) => [r.card.item.id, r.slot, r.pose])).toEqual([
      ["review", 0, "work"],
    ]);
  });

  it("lines up crates on the conveyor in merge order, flagging the ones waiting on you", () => {
    expect(scene.queue.items.map((c) => [c.card.item.id, c.slot, c.flag])).toEqual([
      ["first", 0, null],
      ["second", 1, null],
      ["yours", 2, "person"],
    ]);
  });

  it("stacks today's merges on the dock, with a light while CI is watched", () => {
    expect(scene.shipped.items.map((s) => [s.card.item.id, s.watching])).toEqual([
      ["watching", true],
      ["merged", false],
    ]);
  });

  it("puts failed and escalated work on broken machines, smoking only when it failed", () => {
    expect(scene.machines.items.map((m) => [m.card.item.id, m.slot, m.failed])).toEqual([
      ["escalated", 0, false],
      ["failed", 1, true],
    ]);
  });

  it("caps each station and counts the rest", () => {
    const many = Array.from({ length: 9 }, (_, i) =>
      w(`b${i}`, 100 + i, { stage: "building", step: "implement", stepSince: minutesAgo(90 - i) }),
    );
    const crowded = sceneFor({ inProgress: many });
    expect(crowded.builders.items.map((b) => b.slot)).toEqual([0, 1, 2, 3, 4, 5]);
    expect(crowded.builders.more).toBe(3);
    expect(crowded.builders.ids).toHaveLength(9);
  });

  it("sends the scout walking with its area reviewers during a round, in a dark factory only", () => {
    expect(scene.scout).toMatchObject({ walking: true, round: 4, findings: 3, filed: 1 });
    expect(scene.scout?.helpers.map((h) => [h.label, h.state, h.slot])).toEqual([
      ["UI & UX", "done", 0],
      ["Performance", "writing", 1],
      ["Security", "waiting", 2],
    ]);
    const idle = sceneFor({ scout: { ...scoutStatus, phase: "idle", lenses: [] } });
    expect(idle.scout).toMatchObject({ walking: false, helpers: [] });
    expect(sceneFor({ mode: "software_factory", scout: null }).scout).toBeNull();
  });

  it("dims the lights and sits everyone down when the loop is stopped", () => {
    expect(scene.stopped).toBe(false);
    for (const stop of [
      { killSwitch: true },
      { globalKillSwitch: true },
      { loopState: "stopped" as const },
    ]) {
      const stopped = sceneFor(stop);
      expect(stopped.stopped).toBe(true);
      const poses = [...stopped.builders.items, ...stopped.reviewers.items].map((x) => x.pose);
      expect(new Set(poses)).toEqual(new Set(["sit"]));
    }
  });

  it("reads the budget gauge in dollars, else tokens, and leaves it empty without a budget", () => {
    expect(scene.gauge).toBeCloseTo(0.6);
    const tokens = status({ limits: FactoryLimits.parse({ dailyBudget: { tokens: 1_800_000 } }) });
    expect(budgetGauge(tokens)).toBeCloseTo(0.5);
    expect(budgetGauge(status({ limits: FactoryLimits.parse({}) }))).toBeNull();
    expect(budgetGauge(status({ spendToday: { usd: 50, tokens: 0 } }))).toBe(1);
  });

  it("counts merges today as the figures do, with auto-merge on or off", () => {
    expect(scene.mergesToday).toBe(2);
    expect(sceneFor({ limits: FactoryLimits.parse({ autoMerge: false }) }).mergesToday).toBe(7);
  });

  it("gives every drawn work item a target that opens its card", () => {
    const targets = sceneTargets(scene);
    expect(targets.map((t) => t.key)).toEqual([
      "ticket:new",
      "ticket:sorted-bug",
      "ticket:sorted-docs",
      "builder:hammering",
      "builder:asking",
      "builder:idle",
      "reviewer:review",
      "crate:first",
      "crate:second",
      "crate:yours",
      "shipped:watching",
      "shipped:merged",
      "machine:escalated",
      "machine:failed",
    ]);
    expect(targets.find((t) => t.key === "crate:yours")?.card.item.title).toBe("Item 10");
  });
});

describe("pixel mode's moments (#209)", () => {
  const before = sceneFor();

  it("plays nothing on the first scene", () => {
    expect(sceneEvents(null, before)).toEqual({ buildStarted: [], shipped: [] });
    expect(sceneEvents(before, before)).toEqual({ buildStarted: [], shipped: [] });
  });

  it("carries a ticket to a bench when its build starts", () => {
    const started = w("sorted-bug", 2, { stage: "building", step: "reproduce", type: "bug" });
    const after = sceneFor({
      backlog: backlog.filter((x) => x.id !== "sorted-bug"),
      inProgress: [...inProgress, started],
    });
    expect(sceneEvents(before, after).buildStarted).toEqual(["sorted-bug"]);
  });

  it("doesn't carry a ticket when work goes back from review to a bench", () => {
    const revise = inProgress.map((x) =>
      x.id === "review" ? { ...x, stage: "building" as const, step: "implement" as const } : x,
    );
    expect(sceneEvents(before, sceneFor({ inProgress: revise })).buildStarted).toEqual([]);
  });

  it("ships a crate when a queued pull request merges", () => {
    const merged = w("first", 9, { stage: "merged", step: "done", mergedAt: minutesAgo(0) });
    const after = sceneFor({
      inProgress: inProgress.filter((x) => x.id !== "first"),
      recent: [merged, ...recent],
      pullRequests: pullRequests.filter((p) => p.itemId !== "first"),
    });
    expect(sceneEvents(before, after).shipped).toEqual(["first"]);
  });
});

describe("pixel mode's caption (#209)", () => {
  it("says what the floor shows, in full counts", () => {
    expect(sceneSummary(sceneFor())).toBe(
      "3 in intake, 3 building, 1 in review, 3 in the merge queue, 2 merged today, 2 need you. The scout is on round 4.",
    );
  });

  it("says when the floor is quiet or the loop is stopped", () => {
    const quiet = sceneFor({
      backlog: [],
      inProgress: [],
      recent: [],
      pullRequests: [],
      mergesToday: 0,
      killSwitch: true,
      scout: null,
    });
    expect(sceneSummary(quiet)).toBe("The factory floor is quiet. The loop is stopped.");
    // The scout sits down with everyone else.
    expect(sceneSummary(sceneFor({ killSwitch: true }))).toMatch(
      /2 need you\. The loop is stopped\.$/,
    );
    const one = sceneFor({
      inProgress: [],
      recent: recent.slice(1, 2),
      pullRequests: [],
      backlog: [],
    });
    expect(sceneSummary(one)).toBe("2 merged today, 1 needs you. The scout is on round 4.");
  });
});

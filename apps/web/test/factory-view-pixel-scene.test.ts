import { FactoryLimits, type FactoryStatus } from "@codeden/contracts";
import { describe, expect, it } from "vitest";
import { STATIONS } from "@/components/factory-view/pixel/floor";
import {
  budgetGauge,
  type Scene,
  sceneEvents,
  sceneOf,
  sceneSummary,
} from "@/components/factory-view/pixel/scene-model";
import { sameSeating } from "@/components/factory-view/pixel/seating";
import type { SessionInfo } from "@/components/factory-view/stages";
import { inputs, minutesAgo, prEntry, prRef, running, status, w } from "./pixel-fixtures";

/**
 * Issues #209 and #264: pixel mode maps the factory's live state to a floor of agents at their
 * stations, tickets at intake, a repair bay and a shipped counter, and acts out real
 * transitions once. Only the mapping is tested, never pixels.
 */

const backlog = [
  w("new", 1, { stage: "candidate", step: "intake", type: null }),
  w("sorted-bug", 2, { stage: "backlog", step: "queued", type: "bug" }),
];
const inProgress = [
  w("build", 4, { stage: "building", step: "implement", sessionId: "s4", activeSessionId: "s4" }),
  w("review", 7, {
    stage: "verifying",
    step: "review",
    pr: prRef(17),
    sessionId: "s4b",
    reviewerSessionId: "r7",
    activeSessionId: "r7",
  }),
  w("first", 9, { stage: "verifying", step: "merge", pr: prRef(19), reviewerSessionId: "r9" }),
];
const recent = [
  w("merged", 12, { stage: "merged", step: "done", mergedAt: minutesAgo(30) }),
  w("failed", 14, {
    stage: "failed",
    step: "stopped",
    pr: prRef(24),
    ownedPr: prRef(24),
    attempts: 2,
    finishedAt: minutesAgo(60),
    reason: "Review requested changes twice",
  }),
];
const pullRequests = [
  prEntry("review", 17, { state: "checking" }),
  prEntry("first", 19, { state: "queued", queuePosition: 1 }),
  prEntry("failed", 24, { state: "waiting_for_you" }),
];
const sessions = new Map<string, SessionInfo>([
  ["s4", running("Wiring the button", 1)],
  ["r7", running("Reading the diff", 1, { workKey: "factory:review:17" })],
]);

function sceneFor(patch: Partial<FactoryStatus> = {}, prev: Scene | null = null): Scene {
  const f = status({
    backlog,
    inProgress,
    recent,
    pullRequests,
    scout: null,
    mode: "software_factory",
    ...patch,
  });
  return sceneOf(inputs(f, sessions), prev?.seating ?? null);
}

describe("pixel mode's scene (#264)", () => {
  const scene = sceneFor();

  it("piles new and sorted issues as tickets at intake, tinted once sorted", () => {
    expect(scene.tickets.items.map((t) => [t.card.item.id, t.tint])).toEqual([
      ["new", "paper"],
      ["sorted-bug", "bug"],
    ]);
  });

  it("seats the builder at a bench, the reviewer at a desk, the merging PR at the conveyor", () => {
    const seat = (key: string) => scene.seating.seats.get(key);
    expect(seat("item:build:builder")).toMatchObject({
      station: "bench",
      tile: STATIONS.bench.seats[0],
    });
    expect(seat("item:review:reviewer")).toMatchObject({
      station: "review",
      tile: STATIONS.review.seats[0],
    });
    expect(seat("item:first:reviewer")).toMatchObject({
      station: "merge",
      tile: STATIONS.merge.seats[0],
    });
    expect(seat("pm")).toMatchObject({ station: "pm" });
  });

  it("keeps merged history off the floor: only the counter shows it", () => {
    expect(scene.agents.some((a) => a.card?.item.id === "merged")).toBe(false);
    expect(scene.merged).toEqual(["merged"]);
    expect(scene.shipped).toBe(2);
    expect(sceneFor({ limits: FactoryLimits.parse({ autoMerge: false }) }).shipped).toBe(7);
  });

  it("puts stopped work in the repair bay with its reason", () => {
    expect(scene.bay.map((c) => [c.kind, c.entries.map((e) => [e.card.item.id, e.label])])).toEqual(
      [["merge", [["failed", "Yours to merge"]]]],
    );
  });

  it("gives the same seats when the same data comes again", () => {
    const again = sceneFor({}, scene);
    expect(sameSeating(scene.seating, again.seating)).toBe(true);
    expect(sceneEvents(scene, again)).toEqual([]);
  });

  it("dims the lights when the loop is stopped", () => {
    expect(scene.stopped).toBe(false);
    for (const stop of [
      { killSwitch: true },
      { globalKillSwitch: true },
      { loopState: "stopped" as const },
    ])
      expect(sceneFor(stop).stopped).toBe(true);
  });

  it("reads the budget gauge in dollars, else tokens, and leaves it empty without a budget", () => {
    expect(scene.gauge).toBeCloseTo(0.6);
    const tokens = status({ limits: FactoryLimits.parse({ dailyBudget: { tokens: 1_800_000 } }) });
    expect(budgetGauge(tokens)).toBeCloseTo(0.5);
    expect(budgetGauge(status({ limits: FactoryLimits.parse({}) }))).toBeNull();
    expect(budgetGauge(status({ spendToday: { usd: 50, tokens: 0 } }))).toBe(1);
  });
});

describe("pixel mode's moments (#264)", () => {
  const before = sceneFor();
  const next = (patch: Partial<FactoryStatus>) => sceneFor(patch, before);
  const without = (id: string) => inProgress.filter((x) => x.id !== id);

  it("plays nothing on the first scene", () => {
    expect(sceneEvents(null, before)).toEqual([]);
  });

  it("walks a builder in with its ticket when its build starts", () => {
    const started = w("sorted-bug", 2, { stage: "building", step: "reproduce", type: "bug" });
    const after = next({ backlog: backlog.slice(0, 1), inProgress: [...inProgress, started] });
    expect(sceneEvents(before, after)).toEqual([
      { kind: "arrive", key: "item:sorted-bug:builder", to: STATIONS.prep.seats[0] },
    ]);
  });

  it("has the builder carry its PR crate to the review desk when review starts", () => {
    const reviewing = w("build", 4, {
      stage: "verifying",
      step: "review",
      pr: prRef(30),
      sessionId: "s4",
      reviewerSessionId: "r4",
    });
    const after = next({ inProgress: [reviewing, ...without("build")] });
    const events = sceneEvents(before, after);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      kind: "handoff",
      agent: { key: "item:build:builder", role: "builder" },
      from: STATIONS.bench.seats[0],
      // In front of the second review desk (the first is taken).
      to: { c: STATIONS.review.seats[1]?.c, r: (STATIONS.review.seats[1]?.r ?? 0) - 1 },
    });
  });

  it("has the reviewer stamp the crate and carry it to the conveyor when it passes", () => {
    const passed = { ...(inProgress[1] as (typeof inProgress)[number]), step: "merge" as const };
    const after = next({
      inProgress: [inProgress[0], passed, inProgress[2]].filter((x) => x !== undefined),
      pullRequests: [
        prEntry("review", 17, { state: "queued", queuePosition: 2 }),
        ...pullRequests.slice(1),
      ],
    });
    expect(sceneEvents(before, after)).toEqual([
      {
        kind: "move",
        key: "item:review:reviewer",
        from: STATIONS.review.seats[0],
        to: STATIONS.merge.seats[1],
        carry: "crate",
        stamp: true,
        celebrate: false,
      },
    ]);
  });

  it("ships the crate with a celebration when a queued pull request merges", () => {
    const merged = w("first", 9, {
      stage: "merged",
      step: "done",
      mergedAt: minutesAgo(0),
      reviewerSessionId: "r9",
    });
    const after = next({
      inProgress: without("first"),
      recent: [merged, ...recent],
      pullRequests: pullRequests.filter((p) => p.itemId !== "first"),
    });
    expect(sceneEvents(before, after).map((e) => e.kind)).toEqual(["celebrate", "ship"]);
  });

  it("walks the reviewer to the shipping door, celebrating, when CI is watched after a merge", () => {
    const watching = w("first", 9, {
      stage: "watching",
      step: "merge",
      pr: prRef(19),
      mergedAt: minutesAgo(0),
      reviewerSessionId: "r9",
    });
    const after = next({ inProgress: [...without("first"), watching] });
    expect(sceneEvents(before, after)).toEqual([
      expect.objectContaining({
        kind: "move",
        key: "item:first:reviewer",
        to: STATIONS.ship.seats[0],
        celebrate: true,
      }),
      { kind: "ship", row: STATIONS.merge.seats[0]?.r },
    ]);
  });

  it("puffs smoke and slumps when work fails into the repair bay", () => {
    const failed = w("build", 4, {
      stage: "failed",
      step: "stopped",
      sessionId: "s4",
      finishedAt: minutesAgo(0),
      reason: "The build never reported",
    });
    const after = next({ inProgress: without("build"), recent: [...recent, failed] });
    expect(sceneEvents(before, after)).toEqual([
      expect.objectContaining({
        kind: "fail",
        agent: expect.objectContaining({ key: "item:build:builder" }),
        stays: false,
      }),
    ]);
  });
});

describe("pixel mode's caption (#209, #264)", () => {
  it("says what the floor shows, in full counts, with the repair bay", () => {
    expect(sceneSummary(sceneFor())).toBe(
      "2 in intake, 1 building, 1 in review, 1 in the merge queue, 2 merged today, 1 in the repair bay.",
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
    });
    expect(sceneSummary(quiet)).toBe("The factory floor is quiet. The loop is stopped.");
  });
});

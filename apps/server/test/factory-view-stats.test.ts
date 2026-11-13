import type { FactoryItem } from "@codeden/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { localDay } from "../src/services/factory/policy";
import { factoryStats, median, viewRecentItems } from "../src/services/factory/stats";
import { createFactoryEnv, type FactoryEnv } from "./support/factory-env";

const NOW = new Date(2026, 10, 13, 15, 0, 0);
const HOUR = 60 * 60 * 1000;
const at = (hoursAgo: number) => new Date(NOW.getTime() - hoursAgo * HOUR).toISOString();

const base: FactoryItem = {
  id: "i0",
  projectId: "p1",
  workKey: "issue:1",
  title: "Work",
  summary: "",
  source: "issue",
  area: null,
  acceptanceCriteria: [],
  score: null,
  stage: "merged",
  type: "feature",
  classification: null,
  trust: "trusted",
  author: null,
  admittedBy: null,
  investigation: null,
  issue: null,
  pr: null,
  builderSessionId: null,
  builderProvider: null,
  reviewerSessionId: null,
  reviewerProvider: null,
  reviewerNote: null,
  review: null,
  checks: [],
  attempts: 0,
  reason: null,
  failureKind: null,
  rebuiltFrom: null,
  note: null,
  mergeSha: null,
  revertOf: null,
  triageRequestedAt: null,
  nudges: {},
  largeChange: null,
  sessionsArchivedAt: null,
  earlierSessionIds: [],
  stepSince: null,
  createdAt: at(100),
  updatedAt: at(1),
  mergedAt: null,
  finishedAt: null,
};
const item = (id: string, patch: Partial<FactoryItem>): FactoryItem => ({ ...base, id, ...patch });

describe("the Factory view's stats (§10.1)", () => {
  it("takes the median of an odd or even count, and none of nothing", () => {
    expect(median([])).toBeNull();
    expect(median([5, 1, 3])).toBe(3);
    expect(median([4, 1, 3, 2])).toBe(2.5);
  });

  it("counts today's merges, failures and reverts by the local day", () => {
    // Midnight today, local time: anything before it is yesterday.
    const startOfDay = new Date(NOW.getFullYear(), NOW.getMonth(), NOW.getDate()).getTime();
    const yesterday = new Date(startOfDay - 60_000).toISOString();
    expect(localDay(new Date(yesterday))).not.toBe(localDay(NOW));
    const stats = factoryStats(
      [
        item("m1", { stage: "merged", mergedAt: at(2), finishedAt: at(1) }),
        item("m2", { stage: "watching", mergedAt: at(1) }),
        item("m3", { stage: "merged", mergedAt: yesterday, finishedAt: yesterday }),
        // Merged today, then reverted today: a merge and a revert.
        item("r1", { stage: "reverted", mergedAt: at(3), finishedAt: at(1) }),
        item("r2", { stage: "reverted", mergedAt: yesterday, finishedAt: yesterday }),
        item("f1", { stage: "failed", finishedAt: at(2) }),
        item("f2", { stage: "failed", finishedAt: yesterday }),
        // Failed earlier today, then retried: no longer a failure.
        item("f3", { stage: "building", finishedAt: at(2) }),
      ],
      NOW,
    );
    expect(stats).toMatchObject({ mergedToday: 3, failedToday: 1, revertedToday: 1 });
  });

  it("takes the median time from intake to merge over the last 7 days", () => {
    const stats = factoryStats(
      [
        item("a", { createdAt: at(10), mergedAt: at(8) }), // 2 h
        item("b", { createdAt: at(30), mergedAt: at(24) }), // 6 h
        item("c", { createdAt: at(60), mergedAt: at(56) }), // 4 h
        // Merged 8 days ago: outside the window.
        item("d", { createdAt: at(200), mergedAt: at(8 * 24) }),
        // Not merged.
        item("e", { stage: "building", createdAt: at(5) }),
      ],
      NOW,
    );
    expect(stats.merged7d).toBe(3);
    expect(stats.medianMergeMs7d).toBe(4 * HOUR);
    expect(factoryStats([item("x", { stage: "building" })], NOW)).toEqual({
      mergedToday: 0,
      failedToday: 0,
      revertedToday: 0,
      medianMergeMs7d: null,
      merged7d: 0,
    });
  });
});

describe("time in step (§10.1)", () => {
  let env: FactoryEnv;
  afterEach(() => {
    env?.close();
    vi.useRealTimers();
  });

  it("starts at creation and restarts only when the pipeline step changes", () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-11-13T10:00:00.000Z"));
    env = createFactoryEnv();
    const store = env.factory.data;
    const created = store.createItem({
      projectId: env.project.id,
      workKey: "issue:7",
      title: "Add a counter",
      summary: "Users want to count things",
      source: "issue",
      stage: "backlog",
      type: "feature",
    });
    expect(created.stepSince).toBe("2026-11-13T10:00:00.000Z");

    // A note is progress, not a new step.
    vi.setSystemTime(new Date("2026-11-13T10:05:00.000Z"));
    const noted = store.updateItem(created.id, (i) => ({ ...i, note: "Waiting for an agent" }));
    expect(noted.updatedAt).toBe("2026-11-13T10:05:00.000Z");
    expect(noted.stepSince).toBe("2026-11-13T10:00:00.000Z");

    // An agent takes it: queued -> analyze.
    vi.setSystemTime(new Date("2026-11-13T10:10:00.000Z"));
    const building = store.updateItem(created.id, (i) => ({ ...i, stage: "building" }));
    expect(building.stepSince).toBe("2026-11-13T10:10:00.000Z");

    // The analysis is in: analyze -> implement, within the same stage.
    vi.setSystemTime(new Date("2026-11-13T10:30:00.000Z"));
    const implementing = store.updateItem(created.id, (i) => ({
      ...i,
      investigation: {
        kind: "analysis",
        outcome: "implement",
        summary: "Not there yet",
        details: null,
        testPath: null,
        at: "2026-11-13T10:30:00.000Z",
      },
    }));
    expect(implementing.stepSince).toBe("2026-11-13T10:30:00.000Z");

    // Bookkeeping that keeps `updatedAt` still records a step change.
    vi.setSystemTime(new Date("2026-11-13T11:00:00.000Z"));
    const verifying = store.updateItem(created.id, (i) => ({ ...i, stage: "verifying" }), {
      touch: false,
    });
    expect(verifying.updatedAt).toBe("2026-11-13T10:30:00.000Z");
    expect(verifying.stepSince).toBe("2026-11-13T11:00:00.000Z");
    expect(store.item(created.id)?.stepSince).toBe("2026-11-13T11:00:00.000Z");
  });
});

describe("finished work the Factory view keeps (§10.1)", () => {
  let env: FactoryEnv;
  afterEach(() => {
    env?.close();
    vi.useRealTimers();
  });

  it("keeps escalations, recent or open failures and today's merges", () => {
    const openPr = { number: 9, url: "https://github.com/acme/app/pull/9", state: "open" as const };
    const original = {
      number: 5,
      url: "https://github.com/acme/app/pull/5",
      state: "open" as const,
    };
    const owns = (i: FactoryItem) =>
      i.pr?.state === "open" || (i.pr === null && i.rebuiltFrom?.state === "open");
    const kept = viewRecentItems(
      [
        item("esc", { stage: "escalated", finishedAt: at(24 * 30) }),
        item("fail-new", { stage: "failed", finishedAt: at(3) }),
        item("fail-open", { stage: "failed", finishedAt: at(24 * 5), pr: openPr }),
        // A rebuild that failed without a PR of its own: the original is still the factory's.
        item("rebuild", {
          stage: "failed",
          failureKind: "stuck",
          finishedAt: at(24 * 3),
          rebuiltFrom: original,
        }),
        item("fail-old", { stage: "failed", finishedAt: at(30) }),
        item("merged-today", { stage: "merged", mergedAt: at(2) }),
        item("merged-old", { stage: "merged", mergedAt: at(24 * 2) }),
        item("rejected", { stage: "rejected", finishedAt: at(1) }),
      ],
      NOW,
      owns,
    ).map((i) => i.id);
    expect(kept).toEqual(["esc", "fail-new", "fail-open", "rebuild", "merged-today"]);
  });

  it("lists them however much newer history there is, beyond 500 finished items", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    let clock = Date.parse("2026-11-13T06:00:00.000Z");
    const tick = () => {
      clock += 30_000;
      vi.setSystemTime(new Date(clock));
    };
    tick();
    env = createFactoryEnv();
    const store = env.factory.data;
    const base = { projectId: env.project.id, summary: "", source: "issue" as const };
    const daysAgo = (d: number) => new Date(clock - d * 24 * 60 * 60 * 1000).toISOString();
    tick();
    const escalated = store.createItem({
      ...base,
      workKey: "issue:1",
      title: "Touches payments",
      stage: "escalated",
      finishedAt: daysAgo(9),
    });
    tick();
    const failed = store.createItem({
      ...base,
      workKey: "issue:2",
      title: "Checks failed twice",
      stage: "failed",
      failureKind: "checks",
      pr: { number: 7, url: "https://github.com/acme/app/pull/7", state: "open" },
      finishedAt: daysAgo(3),
    });
    tick();
    // A rebuild that failed before it opened a PR: no PR of its own, the original still open.
    const rebuild = store.createItem({
      ...base,
      workKey: "issue:3",
      title: "Kept conflicting",
      stage: "failed",
      failureKind: "stuck",
      rebuiltFrom: { number: 5, url: "https://github.com/acme/app/pull/5", state: "open" },
      finishedAt: daysAgo(2),
    });
    // More newer finished history than the item list reads (500), all of it old news.
    for (let n = 0; n < 501; n++) {
      tick();
      store.createItem({
        ...base,
        workKey: `issue:${1000 + n}`,
        title: `Shipped ${n}`,
        stage: "merged",
        mergedAt: daysAgo(3),
      });
    }
    tick();
    const today = store.createItem({
      ...base,
      workKey: "issue:4",
      title: "Shipped today",
      stage: "merged",
      mergedAt: new Date(clock).toISOString(),
    });
    expect(store.items(env.project.id)).toHaveLength(500);

    const status = await env.factory.status(env.project.id);
    const ids = (list: { id: string }[]) => list.map((w) => w.id);
    expect(status.recent).toHaveLength(30);
    for (const gone of [escalated.id, failed.id, rebuild.id])
      expect(ids(status.recent)).not.toContain(gone);
    expect(ids(status.viewRecent).sort()).toEqual(
      [escalated.id, failed.id, rebuild.id, today.id].sort(),
    );
    // The rebuild's original PR is the one it owns, as the PR list says.
    expect(status.viewRecent.find((w) => w.id === rebuild.id)).toMatchObject({
      pr: null,
      ownedPr: { number: 5 },
      failureKind: "stuck",
    });
    expect(status.viewRecent.find((w) => w.id === failed.id)?.ownedPr?.number).toBe(7);
  });

  it("owns a failed rebuild's original PR as the PR list does, after 30 newer results", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    let clock = Date.parse("2026-11-13T09:00:00.000Z");
    const tick = () => {
      clock += 60_000;
      vi.setSystemTime(new Date(clock));
    };
    tick();
    env = createFactoryEnv();
    const store = env.factory.data;
    const base = { projectId: env.project.id, summary: "", source: "issue" as const };
    tick();
    const rebuild = store.createItem({
      ...base,
      workKey: "issue:3",
      title: "Kept conflicting",
      stage: "failed",
      failureKind: "stuck",
      rebuiltFrom: { number: 5, url: "https://github.com/acme/app/pull/5", state: "open" },
      finishedAt: new Date(clock - 2 * 24 * 60 * 60 * 1000).toISOString(),
    });
    for (let n = 0; n < 31; n++) {
      tick();
      store.createItem({
        ...base,
        workKey: `issue:${100 + n}`,
        title: `No ${n}`,
        stage: "rejected",
      });
    }
    const status = await env.factory.status(env.project.id);
    expect(status.recent.map((w) => w.id)).not.toContain(rebuild.id);
    expect(status.pullRequests.find((p) => p.itemId === rebuild.id)).toMatchObject({
      pr: { number: 5 },
      state: "stuck",
    });
    expect(status.viewRecent.find((w) => w.id === rebuild.id)?.ownedPr?.number).toBe(5);
  });
});

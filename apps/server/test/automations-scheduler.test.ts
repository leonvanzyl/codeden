import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Automation, AutomationGuards, type Project } from "@codeden/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type Database, openDatabase } from "../src/db/client";
import { ScheduleStore } from "../src/services/automations/schedule-store";
import { CronScheduler, type SchedulePair } from "../src/services/automations/scheduler";

const ts = "2026-11-07T10:00:00.000Z";

const project: Project = {
  id: "p1",
  kind: "local",
  name: "Widgets",
  slug: "widgets",
  path: "/tmp/widgets",
  defaultBranch: "main",
  defaultProvider: null,
  defaultModel: null,
  defaultEffort: null,
  autonomy: null,
  autonomyMode: "assisted",
  visionPath: ".codeden/VISION.md",
  factoryLimits: {} as Project["factoryLimits"],
  killSwitch: false,
  timezone: "UTC",
  agentCiEnv: true,
  pinned: false,
  sortOrder: 0,
  createdAt: ts,
  updatedAt: ts,
  archivedAt: null,
};

function automation(catchUpMissed: boolean): Automation {
  return {
    id: "a1",
    name: "Audit",
    description: null,
    enabled: true,
    source: "database",
    templateId: "security-audit",
    trigger: { type: "cron", expression: "*/5 * * * *" },
    action: { type: "start_session", prompt: "Audit" },
    target: { type: "project", projectId: "p1" },
    guards: AutomationGuards.parse({ catchUpMissed }),
    workKey: "automation:security-audit",
    createdAt: ts,
    updatedAt: ts,
  };
}

describe("cron scheduler: persisted next runs, catch-up, skips", () => {
  let dir: string;
  let db: Database;
  let clock: Date;
  let fired: string[];
  let skipped: string[];
  let pairs: SchedulePair[];

  const scheduler = (store = new ScheduleStore(db.db)) =>
    new CronScheduler({
      store,
      pairs: () => pairs,
      fire: async (_pair, kind) => {
        fired.push(`${kind}@${clock.toISOString()}`);
      },
      skipped: (_pair, at) => {
        skipped.push(at);
      },
      now: () => clock,
      maxWaitMs: 60_000,
    });
  const pair = (catchUp = false): SchedulePair => ({
    automation: automation(catchUp),
    project,
    expression: "*/5 * * * *",
    timezone: "UTC",
  });

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "codeden-sched-"));
    db = openDatabase(join(dir, "codeden.db"));
    clock = new Date("2026-11-07T10:00:30Z");
    fired = [];
    skipped = [];
    pairs = [pair()];
  });
  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("persists the next run and fires when it is due", async () => {
    const s = scheduler();
    s.start();
    expect(s.upcoming("p1", 10)).toEqual([
      expect.objectContaining({
        automationId: "a1",
        at: "2026-11-07T10:05:00.000Z",
        skipped: false,
      }),
    ]);
    clock = new Date("2026-11-07T10:05:01Z");
    await s.tick();
    expect(fired).toEqual(["cron@2026-11-07T10:05:01.000Z"]);
    expect(s.upcoming("p1", 1)[0]?.at).toBe("2026-11-07T10:10:00.000Z");
    // A restart keeps the stored next run.
    s.stop();
    const again = scheduler();
    again.start();
    expect(again.upcoming("p1", 1)[0]?.at).toBe("2026-11-07T10:10:00.000Z");
    again.stop();
  });

  it("drops runs missed during downtime unless catch-up is on, then runs once", async () => {
    const s = scheduler();
    s.start();
    s.stop();
    // The server was down from 10:00 to 10:31: the 10:05 occurrence was missed.
    clock = new Date("2026-11-07T10:31:00Z");
    const after = scheduler();
    after.start();
    await after.tick();
    expect(fired).toEqual([]);
    expect(after.upcoming("p1", 1)[0]?.at).toBe("2026-11-07T10:35:00.000Z");
    after.stop();

    pairs = [pair(true)];
    clock = new Date("2026-11-07T11:20:00Z");
    const caught = scheduler();
    caught.start();
    await caught.tick();
    await caught.tick();
    expect(fired).toEqual(["catch_up@2026-11-07T11:20:00.000Z"]);
    expect(caught.upcoming("p1", 1)[0]?.at).toBe("2026-11-07T11:25:00.000Z");
    caught.stop();
  });

  it("skips the occurrence a PM skipped and lists the one after it", async () => {
    const s = scheduler();
    s.start();
    expect(s.skipNext("a1", "p1")?.skipAt).toBe("2026-11-07T10:05:00.000Z");
    expect(s.upcoming("p1", 10).map((r) => [r.at, r.skipped])).toEqual([
      ["2026-11-07T10:05:00.000Z", true],
      ["2026-11-07T10:10:00.000Z", false],
    ]);
    clock = new Date("2026-11-07T10:05:02Z");
    await s.tick();
    expect(fired).toEqual([]);
    expect(skipped).toEqual(["2026-11-07T10:05:00.000Z"]);
    clock = new Date("2026-11-07T10:10:01Z");
    await s.tick();
    expect(fired).toEqual(["cron@2026-11-07T10:10:01.000Z"]);
    s.stop();
  });

  it("undoes a skip so the next occurrence runs again", async () => {
    const s = scheduler();
    s.start();
    expect(s.unskipNext("a1", "p1")).toBeNull();
    s.skipNext("a1", "p1");
    expect(s.unskipNext("a1", "p1")?.skipAt).toBeNull();
    expect(s.upcoming("p1", 1).map((r) => [r.at, r.skipped])).toEqual([
      ["2026-11-07T10:05:00.000Z", false],
    ]);
    clock = new Date("2026-11-07T10:05:02Z");
    await s.tick();
    expect(skipped).toEqual([]);
    expect(fired).toEqual(["cron@2026-11-07T10:05:02.000Z"]);
    s.stop();
  });

  it("clears unscheduled pairs and recomputes changed expressions", () => {
    const store = new ScheduleStore(db.db);
    const s = scheduler(store);
    s.start();
    pairs = [{ ...pair(), expression: "0 * * * *" }];
    s.refresh();
    expect(store.get("a1", "p1")?.nextRunAt).toBe("2026-11-07T11:00:00.000Z");
    pairs = [];
    s.refresh();
    expect(store.get("a1", "p1")?.nextRunAt).toBeNull();
    expect(s.upcoming(null, 10)).toEqual([]);
    s.stop();
  });

  it("reports changes to visible schedule state, not bookkeeping", () => {
    const changes: string[] = [];
    const store = new ScheduleStore(db.db, (c) => changes.push(`${c.automationId}/${c.projectId}`));
    const s = scheduler(store);
    s.start();
    expect(changes).toEqual(["a1/p1"]); // first next run
    s.refresh();
    expect(changes).toHaveLength(1);
    s.skipNext("a1", "p1");
    store.upsert("a1", "p1", { lastFiredAt: ts });
    store.upsert("a1", "p1", { paused: true });
    store.setProjectEnabled("p1", false);
    expect(changes).toEqual(["a1/p1", "a1/p1", "a1/p1", "null/p1"]);
    s.stop();
  });
});

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type AgentEvent,
  agentEventToNewEvent,
  type Session,
  type Usage,
} from "@codeden/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type Database, openDatabase } from "../src/db/client";
import { githubPrs, inboxItems, turns } from "../src/db/schema";
import { rateLimitWindows, usageLedger } from "../src/db/schema-usage";
import { EventStore } from "../src/events/store";
import { backfillUsageLedger } from "../src/services/usage/backfill";
import { UsageService } from "../src/services/usage/usage-service";
import { sampleSession } from "./helpers";

let dir: string;
let database: Database;
let store: EventStore;
let usage: UsageService;
const NOW = Date.parse("2026-11-07T15:00:00.000Z");

const session = (extra: Partial<Session> = {}): Session => ({
  ...sampleSession,
  provider: "claude",
  model: "claude-sonnet-4-5",
  ...extra,
});

function emit(sessionId: string, ...events: AgentEvent[]) {
  store.append(events.map((e) => agentEventToNewEvent(sessionId, e)));
}

function turn(sessionId: string, turnId: string, report: Usage) {
  emit(
    sessionId,
    { type: "turn.started", threadId: "t", turnId },
    { type: "usage.updated", threadId: "t", turnId, usage: report },
    { type: "turn.completed", threadId: "t", turnId },
  );
}

beforeEach(() => {
  // Events are stamped with the wall clock; pin it so the fixed report window always matches.
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  dir = mkdtempSync(join(tmpdir(), "codeden-usage-"));
  database = openDatabase(join(dir, "codeden.db"));
  store = new EventStore(database.db);
  usage = new UsageService({
    db: database.db,
    store,
    settingsFile: join(dir, "usage-settings.json"),
    billing: async () => ({ claude: "subscription" }),
    now: () => NOW,
  });
  usage.saveSettings({ timezone: "UTC" });
  store.append([
    {
      type: "project.created",
      sessionId: null,
      payload: {
        project: {
          id: "p1",
          kind: "local",
          name: "Shop",
          slug: "shop",
          path: dir,
          defaultBranch: "main",
          defaultProvider: null,
          autonomy: null,
          autonomyMode: "assisted",
          visionPath: ".codeden/VISION.md",
          factoryLimits: null,
          killSwitch: false,
          timezone: null,
          github: null,
          createdAt: "2026-11-01T00:00:00.000Z",
          updatedAt: "2026-11-01T00:00:00.000Z",
          archivedAt: null,
        },
      },
    } as never,
    {
      type: "session.created",
      sessionId: "s1",
      payload: { session: session({ projectId: "p1", title: "Fix checkout" }) },
    },
  ]);
  emit("s1", { type: "thread.started", thread: { id: "t" } });
});

afterEach(() => {
  usage.stop();
  database.close();
  rmSync(dir, { recursive: true, force: true });
  vi.useRealTimers();
});

describe("usage ledger projection", () => {
  it("stores each turn's own usage with attribution and replaces it as the turn grows", () => {
    turn("s1", "u1", { inputTokens: 10, outputTokens: 20, cachedInputTokens: 300, costUsd: 0.05 });
    emit("s1", {
      type: "usage.updated",
      threadId: "t",
      turnId: "u1",
      usage: { inputTokens: 12, outputTokens: 40, cachedInputTokens: 300, costUsd: 0.07 },
    });
    const rows = database.db.select().from(usageLedger).all();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      sessionId: "s1",
      turnId: "u1",
      projectId: "p1",
      provider: "claude",
      model: "claude-sonnet-4-5",
      role: "agent",
      source: "user",
      inputTokens: 12,
      outputTokens: 40,
      cacheReadTokens: 300,
      reportedCostUsd: 0.07,
    });
  });

  it("keeps rate-limit readings without touching the turn's tokens", () => {
    turn("s1", "u1", { inputTokens: 10, outputTokens: 20, costUsd: 0.05 });
    emit("s1", {
      type: "usage.updated",
      threadId: "t",
      turnId: "u1",
      usage: {
        rateLimits: [
          { id: "5h", status: "warning", usedPercent: 91, resetsAt: "2026-11-07T17:00:00.000Z" },
        ],
      },
    });
    expect(database.db.select().from(usageLedger).get()?.outputTokens).toBe(20);
    const turnRow = database.db.select().from(turns).get();
    expect(turnRow?.usage?.outputTokens).toBe(20);
    expect(database.db.select().from(rateLimitWindows).get()).toMatchObject({
      provider: "claude",
      windowId: "5h",
      usedPercent: 91,
    });
  });
});

describe("UsageService", () => {
  it("reports totals, series, top sessions and billing", async () => {
    turn("s1", "u1", {
      inputTokens: 1000,
      outputTokens: 500,
      cachedInputTokens: 9000,
      costUsd: 1.25,
    });
    store.append([
      {
        type: "session.created",
        sessionId: "s2",
        payload: {
          session: session({ id: "s2", provider: "codex", model: "gpt-5.2", projectId: "p1" }),
        },
      },
    ]);
    emit("s2", { type: "thread.started", thread: { id: "t" } });
    turn("s2", "v1", { inputTokens: 1_000_000, outputTokens: 0 });

    const report = await usage.report({ from: "2026-11-01", to: "2026-11-07" });
    expect(report.days).toHaveLength(7);
    expect(report.totals.turns).toBe(2);
    expect(report.totals.costUsd).toBeCloseTo(1.25 + 1.75);
    expect(report.totals.estimatedCostUsd).toBeCloseTo(1.75);
    expect(report.series.provider.map((s) => s.label)).toEqual(["Codex", "Claude"]);
    expect(report.series.project[0]?.label).toBe("Shop");
    expect(report.topSessions[0]).toMatchObject({ sessionId: "s2", estimated: true });
    expect(report.topSessions[1]).toMatchObject({ title: "Fix checkout", projectName: "Shop" });
    expect(report.billing).toEqual({ claude: "subscription", codex: "unknown" });
    expect(report.averages.perSessionUsd).toBeCloseTo(1.5);

    const csv = usage.csv({ from: "2026-11-01", to: "2026-11-07", provider: "codex" });
    expect(csv.trim().split("\r\n")).toHaveLength(2);

    const s1 = await usage.sessionUsage("s1");
    expect(s1).toMatchObject({ billing: "subscription", totals: { costUsd: 1.25 } });
    expect(s1.turns).toEqual([expect.objectContaining({ turnId: "u1", costSource: "reported" })]);

    const spend = await usage.projectSpend("p1");
    expect(spend.todayUsd).toBeCloseTo(3);
    expect(spend.dailyUsd).toHaveLength(14);
    expect(spend.topModel).toBe("gpt-5.2");
  });

  it("raises budget and rate-limit alerts once", async () => {
    usage.saveSettings({
      timezone: "UTC",
      budgets: [{ id: "daily", projectId: null, period: "daily", limitUsd: 1 }],
    });
    turn("s1", "u1", { inputTokens: 10, outputTokens: 20, costUsd: 1.5 });
    emit("s1", {
      type: "usage.updated",
      threadId: "t",
      usage: {
        rateLimits: [
          { id: "weekly", status: "ok", usedPercent: 95, resetsAt: "2026-11-10T00:00:00.000Z" },
        ],
      },
    });
    const raised = await usage.checkAlerts();
    expect(raised.map((i) => i.id).sort()).toEqual([
      "inbox:usage:budget:daily:2026-11-07:exceeded",
      "inbox:usage:limit:claude:weekly:2026-11-10T00:00:00.000Z:warning",
    ]);
    expect(await usage.checkAlerts()).toEqual([]);
    expect(database.db.select().from(inboxItems).all()).toHaveLength(2);
    expect(usage.budgets().budgets[0]).toMatchObject({ state: "exceeded", spentUsd: 1.5 });
    expect(usage.spendSince("2026-11-07", "p1").usd).toBeCloseTo(1.5);
  });

  it("prices finished subagents for their cards without counting them anywhere else", async () => {
    usage.saveSettings({
      timezone: "UTC",
      budgets: [{ id: "daily", projectId: null, period: "daily", limitUsd: 1 }],
    });
    turn("s1", "u1", { inputTokens: 10, outputTokens: 20, cachedInputTokens: 300, costUsd: 0.05 });
    const range = { from: "2026-11-01", to: "2026-11-07" };
    const before = {
      session: await usage.sessionUsage("s1"),
      ledger: database.db.select().from(usageLedger).all(),
      report: (await usage.report(range)).totals,
      budgets: usage.budgets(),
      spend: usage.spendSince("2026-11-07", "p1"),
    };
    expect(before.session.subagents).toEqual([]);

    const card = (id: string, status: "in_progress" | "completed", stats?: object) =>
      ({
        type: "item.completed",
        threadId: "t",
        turnId: "u1",
        item: {
          id,
          kind: "subagent",
          status,
          childThreadId: `t-${id}`,
          ...(stats ? { stats } : {}),
        },
      }) as AgentEvent;
    const haiku = {
      model: "claude-haiku-5-5",
      inputTokens: 1_000,
      outputTokens: 2_000,
      cacheReadTokens: 100_000,
      cacheWriteTokens: 20_000,
    };
    emit(
      "s1",
      card("a1", "completed", { totalTokens: 123_000, usage: [haiku] }),
      // Still running, or finished without tokens per model: no cost.
      card("a2", "in_progress"),
      card("a3", "completed", { totalTokens: 5, toolUses: 1 }),
    );

    const after = await usage.sessionUsage("s1");
    expect(after.subagents).toEqual([
      {
        itemId: "a1",
        // $0.0001 + $0.001 + $0.001 + $0.0025 at Haiku 5.5's list prices.
        costUsd: 0.0046,
        costSource: "estimated",
        models: [
          {
            ...haiku,
            label: "Haiku 5.5",
            reasoningTokens: 0,
            costUsd: 0.0046,
            costSource: "estimated",
          },
        ],
      },
    ]);
    const { subagents: _added, ...rest } = after;
    const { subagents: _none, ...restBefore } = before.session;
    expect(rest).toEqual(restBefore);
    expect(database.db.select().from(usageLedger).all()).toEqual(before.ledger);
    expect((await usage.report(range)).totals).toEqual(before.report);
    expect(usage.budgets()).toEqual(before.budgets);
    expect(usage.spendSince("2026-11-07", "p1")).toEqual(before.spend);
  });

  it("rejects duplicate budget ids", () => {
    const b = { id: "x", projectId: null, period: "daily" as const, limitUsd: 1 };
    expect(() => usage.saveSettings({ budgets: [b, b] })).toThrow(/unique/);
  });

  it("costs merged PRs from session.pr and synced github_prs rows", async () => {
    const pr = (number: number, state: "open" | "merged") => ({
      number,
      url: `https://github.com/acme/shop/pull/${number}`,
      state,
    });
    store.append([
      {
        type: "session.updated",
        sessionId: "s1",
        payload: { session: session({ projectId: "p1", pr: pr(4, "merged") }) },
      },
      ...(["s2", "s3"] as const).map((id) => ({
        type: "session.created" as const,
        sessionId: id,
        payload: {
          session: session({ id, projectId: "p1", pr: id === "s3" ? pr(5, "open") : null }),
        },
      })),
    ]);
    for (const id of ["s2", "s3"]) emit(id, { type: "thread.started", thread: { id: "t" } });
    turn("s1", "u1", { inputTokens: 1, outputTokens: 1, costUsd: 1 });
    turn("s2", "u1", { inputTokens: 1, outputTokens: 1, costUsd: 3 });
    turn("s3", "u1", { inputTokens: 1, outputTokens: 1, costUsd: 10 });
    // s2 never recorded its PR; GitHub sync linked and merged it.
    database.db
      .insert(githubPrs)
      .values({
        projectId: "p1",
        number: 9,
        title: "Speed up search",
        state: "merged",
        url: "https://github.com/acme/shop/pull/9",
        headBranch: "codeden/search",
        baseBranch: "main",
        checks: { state: "success", total: 1, passed: 1, failed: 0, pending: 0, checks: [] },
        sessionId: "s2",
        updatedAt: "2026-11-07T10:00:00.000Z",
        syncedAt: "2026-11-07T10:00:00.000Z",
      })
      .run();

    const report = await usage.report({ from: "2026-11-01", to: "2026-11-07" });
    expect(report.averages.mergedPrs).toBe(2);
    expect(report.averages.perMergedPrUsd).toBeCloseTo(2);
    expect(report.topSessions.find((t) => t.sessionId === "s2")?.pr).toMatchObject({ number: 9 });
  });
});

describe("backfill", () => {
  it("converts running totals stored before the ledger into per-turn rows", () => {
    turn("s1", "u1", { inputTokens: 10, outputTokens: 20, costUsd: 0.1 });
    turn("s1", "u2", { inputTokens: 25, outputTokens: 50, costUsd: 0.3 });
    // Simulate a database from before the ledger existed.
    database.db.delete(usageLedger).run();
    database.db.update(turns).set({ startedAt: "2026-11-07T10:00:00.000Z" }).run();
    database.client
      .prepare("UPDATE turns SET started_at = '2026-11-07T11:00:00.000Z' WHERE id = 'u2'")
      .run();
    expect(backfillUsageLedger(database.db)).toBe(2);
    const rows = database.db.select().from(usageLedger).all();
    const u2 = rows.find((r) => r.turnId === "u2");
    expect(u2).toMatchObject({ inputTokens: 15, outputTokens: 30 });
    expect(u2?.reportedCostUsd).toBeCloseTo(0.2);
    expect(backfillUsageLedger(database.db)).toBe(0);
  });
});

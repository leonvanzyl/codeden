import { describe, expect, it } from "vitest";
import {
  EventEnvelope,
  FactoryAllowLargeChangeRequest,
  FactoryDecisionRequest,
  FactoryDigest,
  FactoryItem,
  FactoryLimits,
  FactoryLoop,
  FactoryStatus,
  isFactoryMode,
  Notice,
  ReviewVerdict,
  SetAutonomyModeRequest,
} from "../src";
import { ts } from "./fixtures";

const item: FactoryItem = {
  id: "i1",
  projectId: "p1",
  workKey: "issue:3",
  title: "Add a counter",
  summary: "Users count things",
  source: "discovery",
  area: "features",
  acceptanceCriteria: ["Counter increments"],
  score: 0.8,
  stage: "verifying",
  type: "feature",
  classification: {
    type: "feature",
    confidence: "high",
    rationale: "Asks for new behaviour",
    by: "model",
    at: ts,
  },
  trust: "trusted",
  author: "octocat",
  admittedBy: null,
  investigation: {
    kind: "analysis",
    outcome: "implement",
    summary: "Not there yet",
    details: "A counter in the header",
    testPath: null,
    at: ts,
  },
  issue: { number: 3, url: "https://github.com/acme/app/issues/3" },
  pr: { number: 4, url: "https://github.com/acme/app/pull/4", state: "open" },
  builderSessionId: "s1",
  builderProvider: "claude",
  reviewerSessionId: "s2",
  reviewerProvider: "codex",
  reviewerNote: null,
  review: null,
  checks: [{ name: "ci", state: "pass", detail: null, escalate: false, at: ts }],
  attempts: 0,
  reason: null,
  note: null,
  mergeSha: null,
  revertOf: null,
  triageRequestedAt: ts,
  nudges: { verifying: ts },
  largeChange: null,
  sessionsArchivedAt: null,
  earlierSessionIds: [],
  createdAt: ts,
  updatedAt: ts,
  mergedAt: null,
  finishedAt: null,
};

describe("factory API contracts (§10.1)", () => {
  it("round-trips items, loops and the item event", () => {
    expect(FactoryItem.parse(item)).toEqual(item);
    const finished = {
      ...item,
      stage: "backlog" as const,
      sessionsArchivedAt: ts,
      earlierSessionIds: ["s1", "s2"],
    };
    expect(FactoryItem.parse(JSON.parse(JSON.stringify(finished)))).toEqual(finished);
    const loop = FactoryLoop.parse({
      projectId: "p1",
      state: "building",
      pausedReason: null,
      consecutiveFailures: 0,
      day: "2026-11-07",
      mergesToday: 1,
      discovery: [{ sessionId: "s3", area: "ux", startedAt: ts }],
      nextArea: 2,
      lastDiscoveryAt: ts,
      lastDigestDay: null,
      enabledAt: ts,
      lastTickAt: null,
      updatedAt: ts,
    });
    expect(loop.tuning.maxChangedLines).toBe(5_000);
    expect(loop.tuning.maxChangedFiles).toBeNull();
    expect(loop.tuning.areas).toContain("security");
    expect(loop.seenFailedShas).toEqual([]);
    expect(loop.scout).toEqual({
      sessionId: null,
      lensSessions: {},
      round: null,
      lastRoundAt: null,
      rounds: 0,
    });
    // Items stored before `largeChange`, the pipelines and session cleanup existed still parse,
    // as trusted work whose sessions were not archived yet.
    const {
      largeChange: _l,
      sessionsArchivedAt: _sa,
      earlierSessionIds: _es,
      type: _t,
      classification: _c,
      trust: _tr,
      author: _a,
      admittedBy: _ab,
      investigation: _i,
      ...old
    } = item;
    expect(FactoryItem.parse(old)).toMatchObject({
      largeChange: null,
      sessionsArchivedAt: null,
      earlierSessionIds: [],
      type: null,
      trust: "trusted",
      investigation: null,
    });
    // A tuning change carries only what it sets: the rest of the saved tuning is kept.
    expect(
      SetAutonomyModeRequest.parse({ mode: "dark_factory", tuning: { maxChangedLines: null } })
        .tuning,
    ).toEqual({ maxChangedLines: null });
    expect(
      SetAutonomyModeRequest.safeParse({ mode: "dark_factory", tuning: { maxChangedLines: 0 } })
        .success,
    ).toBe(false);
    expect(
      FactoryAllowLargeChangeRequest.parse({ itemId: "i1", reason: "Initial scaffold" }),
    ).toEqual({ itemId: "i1", reason: "Initial scaffold" });
    const event = EventEnvelope.parse({
      seq: 1,
      sessionId: null,
      ts,
      type: "factory.item.updated",
      payload: { item },
    });
    expect(event.type).toBe("factory.item.updated");
  });

  it("validates verdicts, reports and mode requests", () => {
    const verdict = ReviewVerdict.parse({
      verdict: "approve",
      summary: "ok",
      vision: { aligned: true },
      tests: { adequate: true },
      security: {},
    });
    expect(verdict.criteria).toEqual([]);
    expect(verdict.security.concerns).toEqual([]);
    expect(ReviewVerdict.safeParse({ verdict: "maybe", summary: "x" }).success).toBe(false);
    const decision = FactoryDecisionRequest.parse({
      question: "Polish index.html or migrate first?",
      decision: "Migrate first",
      reasoning: "The vision names the stack",
    });
    expect(decision.needsHuman).toBe(false);
    expect(FactoryDecisionRequest.parse(JSON.parse(JSON.stringify(decision)))).toEqual(decision);
    expect(FactoryDecisionRequest.safeParse({ ...decision, reasoning: "" }).success).toBe(false);
    // Digests stored before decisions existed still parse.
    const digest = FactoryDigest.parse({
      id: "d1",
      projectId: "p1",
      day: "2026-11-09",
      shipped: [],
      rejected: [],
      spend: { usd: 0, tokens: 0, budgetUsd: null, budgetTokens: null },
      waiting: [],
      text: "",
      createdAt: ts,
    });
    expect(digest.decisions).toEqual([]);
    // "autopilot" is the software factory's id from before 0.6.
    const req = SetAutonomyModeRequest.parse({
      mode: "autopilot",
      limits: { dailyBudget: { usd: 5 } },
      tuning: { maxFixAttempts: 2 },
    });
    expect(req.mode).toBe("software_factory");
    expect(req.limits?.maxConcurrentSessions).toBe(2);
    expect(req.limits?.autoMerge).toBe(false);
    expect(isFactoryMode("software_factory")).toBe(true);
    expect(isFactoryMode("assisted")).toBe(false);
  });

  it("carries the factory panel status and factory notices", () => {
    const status = FactoryStatus.parse({
      projectId: "p1",
      mode: "dark_factory",
      experimental: true,
      loopState: "verifying",
      pausedReason: null,
      killSwitch: false,
      globalKillSwitch: false,
      limits: FactoryLimits.parse({ dailyBudget: { usd: 5 } }),
      tuning: {},
      spendToday: { usd: 1.5, tokens: 1000 },
      mergesToday: 1,
      consecutiveFailures: 0,
      activeSessions: 1,
      backlog: [],
      inProgress: [],
      mergeChecks: [
        {
          itemId: "i1",
          prNumber: 4,
          title: "Add a counter",
          checks: item.checks,
          reviewerProvider: "codex",
          reviewerNote: null,
          verdict: null,
        },
      ],
      recent: [],
      visionExists: true,
      lastDigest: null,
      lastTickAt: null,
    });
    expect(status.tuning.requireCi).toBe(true);
    const notice = Notice.parse({
      id: "n1",
      type: "factory.update",
      projectId: "p1",
      target: "orchestrator",
      sessionId: null,
      title: "Factory digest",
      createdAt: ts,
      deliveredAt: null,
      data: { event: "digest", text: "Shipped 1" },
    });
    expect(notice.type === "factory.update" && notice.data.itemIds).toEqual([]);
  });
});

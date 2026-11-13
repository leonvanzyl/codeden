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
  FactoryTuning,
  isFactoryMode,
  Notice,
  REVIEW_SUMMARY_MAX,
  REVIEW_SUMMARY_TRUNCATED,
  ReviewVerdict,
  ReviewVerdictSubmission,
  SCOUT_UNAVAILABLE,
  ScoutStatus,
  SetAutonomyModeRequest,
  truncateReviewSummary,
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
  failureKind: null,
  rebuiltFrom: null,
  note: null,
  mergeSha: null,
  revertOf: null,
  triageRequestedAt: ts,
  nudges: { verifying: ts },
  largeChange: null,
  sessionsArchivedAt: null,
  earlierSessionIds: [],
  stepSince: ts,
  createdAt: ts,
  updatedAt: ts,
  mergedAt: null,
  finishedAt: null,
};

describe("review summaries (§10.1)", () => {
  const verdict = (summary: string) => ({
    verdict: "request_changes",
    summary,
    vision: { aligned: true },
    tests: { adequate: false },
    security: {},
  });

  it("keeps a summary up to the limit and cuts a longer one with a marker", () => {
    const fits = "a".repeat(REVIEW_SUMMARY_MAX);
    expect(truncateReviewSummary(fits)).toBe(fits);
    const cut = truncateReviewSummary(`${"b".repeat(REVIEW_SUMMARY_MAX)} and more`);
    expect(cut.length).toBeLessThanOrEqual(REVIEW_SUMMARY_MAX);
    expect(cut.endsWith(` ${REVIEW_SUMMARY_TRUNCATED}`)).toBe(true);
    expect(cut.startsWith("bbbb")).toBe(true);
    // An emoji at the cut is dropped whole, never split into half a surrogate pair.
    const keep = REVIEW_SUMMARY_MAX - REVIEW_SUMMARY_TRUNCATED.length - 2;
    const emoji = truncateReviewSummary(`${"c".repeat(keep)}😀${"d".repeat(100)}`);
    expect(emoji).toBe(`${"c".repeat(keep)} ${REVIEW_SUMMARY_TRUNCATED}`);
  });

  it("accepts a submission of any length but stores at most the limit", () => {
    const long = "e".repeat(REVIEW_SUMMARY_MAX + 1);
    expect(ReviewVerdictSubmission.safeParse(verdict(long)).success).toBe(true);
    expect(ReviewVerdictSubmission.safeParse(verdict("")).success).toBe(false);
    expect(ReviewVerdict.safeParse(verdict(long)).success).toBe(false);
    expect(ReviewVerdict.safeParse(verdict(truncateReviewSummary(long))).success).toBe(true);
    // Verdicts stored under the old 4,000-character limit still parse.
    expect(ReviewVerdict.safeParse(verdict("f".repeat(4_000))).success).toBe(true);
  });
});

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
    // A rebuilt item that failed for a reason outside its code.
    const rebuilt = {
      ...item,
      stage: "failed" as const,
      failureKind: "infrastructure" as const,
      rebuiltFrom: { number: 4, url: "https://github.com/acme/app/pull/4", state: "closed" },
    };
    expect(FactoryItem.parse(JSON.parse(JSON.stringify(rebuilt)))).toEqual(rebuilt);
    expect(FactoryItem.safeParse({ ...item, failureKind: "flaky" }).success).toBe(false);
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
    // Loops saved before the idle grace existed get its default.
    expect(loop.tuning.idleGraceMin).toBe(10);
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
      failureKind: _fk,
      rebuiltFrom: _rf,
      stepSince: _ss,
      ...old
    } = item;
    expect(FactoryItem.parse(old)).toMatchObject({
      failureKind: null,
      rebuiltFrom: null,
      stepSince: null,
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
      SetAutonomyModeRequest.parse({ mode: "dark_factory", tuning: { idleGraceMin: 30 } }).tuning,
    ).toEqual({ idleGraceMin: 30 });
    expect(
      SetAutonomyModeRequest.safeParse({ mode: "dark_factory", tuning: { idleGraceMin: 0 } })
        .success,
    ).toBe(false);
    // Loops saved before the reviewer settings keep today's behaviour.
    expect(loop.tuning).toMatchObject({
      builderModel: null,
      reviewerProvider: "auto",
      reviewerModel: null,
      reviewerFallback: "builder",
    });
    const agents = {
      builderProvider: "claude",
      builderModel: "claude-opus-5-5",
      reviewerProvider: "codex",
      reviewerModel: "gpt-5.5",
      reviewerFallback: "wait",
    } as const;
    const tuned = FactoryTuning.parse(agents);
    expect(FactoryTuning.parse(JSON.parse(JSON.stringify(tuned)))).toEqual(tuned);
    expect(tuned).toMatchObject(agents);
    expect(SetAutonomyModeRequest.parse({ mode: "dark_factory", tuning: agents }).tuning).toEqual(
      agents,
    );
    expect(FactoryTuning.safeParse({ reviewerFallback: "never" }).success).toBe(false);
    expect(FactoryTuning.safeParse({ reviewerModel: "" }).success).toBe(false);
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
    expect(ReviewVerdict.parse(JSON.parse(JSON.stringify(verdict)))).toEqual(verdict);
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
    // A status from before the Factory view's stats still parses, with empty figures.
    expect(status.stats).toEqual({
      mergedToday: 0,
      failedToday: 0,
      revertedToday: 0,
      medianMergeMs7d: null,
      merged7d: 0,
    });
    const work = {
      id: "i1",
      title: "Add a counter",
      workKey: "issue:3",
      issue: item.issue,
      pr: item.pr,
      score: null,
      sessionId: "s1",
      stage: "failed",
      step: "stopped",
      source: "issue",
      reason: "Checks failed",
      note: null,
      updatedAt: ts,
    };
    // Work items from before it lack the step time, merge and finish times, failure kind and
    // check counts; a status without the view's uncapped list reads it as empty.
    const before = FactoryStatus.parse({ ...status, recent: [work] });
    expect(before.recent[0]).toMatchObject({
      stepSince: null,
      mergedAt: null,
      finishedAt: null,
      failureKind: null,
      checks: null,
      ownedPr: null,
    });
    expect(before.viewRecent).toEqual([]);
    const owning = FactoryStatus.parse({
      ...status,
      viewRecent: [{ ...work, pr: null, ownedPr: item.pr }],
    });
    expect(FactoryStatus.parse(JSON.parse(JSON.stringify(owning)))).toEqual(owning);
    expect(owning.viewRecent[0]?.ownedPr?.number).toBe(4);
    const withChecks = FactoryStatus.parse({
      ...status,
      viewRecent: [{ ...work, checks: { passed: 5, failed: 1, total: 8 } }],
    });
    expect(FactoryStatus.parse(JSON.parse(JSON.stringify(withChecks)))).toEqual(withChecks);
    expect(withChecks.viewRecent[0]?.checks).toEqual({ passed: 5, failed: 1, total: 8 });
    expect(
      FactoryStatus.safeParse({
        ...status,
        viewRecent: [{ ...work, checks: { passed: -1, failed: 0, total: 1 } }],
      }).success,
    ).toBe(false);
    const viewed = FactoryStatus.parse({
      ...status,
      stats: {
        mergedToday: 2,
        failedToday: 1,
        revertedToday: 1,
        medianMergeMs7d: 5_400_000,
        merged7d: 9,
      },
      recent: [{ ...work, stepSince: ts, finishedAt: ts, failureKind: "stuck" }],
    });
    expect(FactoryStatus.parse(JSON.parse(JSON.stringify(viewed)))).toEqual(viewed);
    expect(
      FactoryStatus.safeParse({ ...status, stats: { ...viewed.stats, failedToday: -1 } }).success,
    ).toBe(false);
    // A status from before the merge queue still parses; its entries round-trip.
    expect(status.pullRequests).toEqual([]);
    const pullRequests = [
      {
        itemId: "i1",
        title: "Add a counter",
        pr: item.pr,
        state: "queued",
        queuePosition: 1,
        note: "Queued to merge",
      },
      {
        itemId: "i2",
        title: "Fix the header",
        pr: { number: 5, url: "https://github.com/acme/app/pull/5", state: "open" },
        state: "rebasing",
        queuePosition: null,
        note: null,
      },
      {
        itemId: "i3",
        title: "Fix the footer",
        pr: { number: 2, url: "https://github.com/acme/app/pull/2", state: "open" },
        state: "superseded",
        queuePosition: null,
        note: "Superseded by #6: closing it",
      },
    ];
    const withQueue = FactoryStatus.parse({ ...status, pullRequests });
    expect(FactoryStatus.parse(JSON.parse(JSON.stringify(withQueue)))).toEqual(withQueue);
    expect(withQueue.pullRequests.map((p) => p.state)).toEqual([
      "queued",
      "rebasing",
      "superseded",
    ]);
    expect(
      FactoryStatus.safeParse({
        ...status,
        pullRequests: [{ ...pullRequests[0], queuePosition: 0 }],
      }).success,
    ).toBe(false);
    expect(
      FactoryStatus.safeParse({ ...status, pullRequests: [{ ...pullRequests[0], state: "idle" }] })
        .success,
    ).toBe(false);
    // The scout: a status from before "Run scout now" still parses; the reason round-trips.
    const scout = {
      phase: "idle",
      sessionId: null,
      lenses: [],
      findings: 0,
      filed: 0,
      lastRoundAt: null,
      nextRoundAt: null,
      rounds: 0,
    } as const;
    expect(ScoutStatus.parse(scout).runNowBlockedBy).toBeNull();
    const blocked = ScoutStatus.parse({ ...scout, runNowBlockedBy: "A round is already running" });
    expect(ScoutStatus.parse(JSON.parse(JSON.stringify(blocked)))).toEqual(blocked);
    expect(SCOUT_UNAVAILABLE).toBe("scout_unavailable");
    // Setting the backlog threshold alone carries nothing else; 0 is allowed, negatives aren't.
    expect(
      SetAutonomyModeRequest.parse({ mode: "dark_factory", tuning: { minBacklog: 0 } }).tuning,
    ).toEqual({ minBacklog: 0 });
    expect(
      SetAutonomyModeRequest.safeParse({ mode: "dark_factory", tuning: { minBacklog: -1 } })
        .success,
    ).toBe(false);
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

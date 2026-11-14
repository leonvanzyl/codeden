import { agentEventToNewEvent, type ReviewVerdictInit } from "@codeden/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { REVIEWER_NUDGE } from "../src/services/factory/prompts";
import { createFactoryEnv, type FactoryEnv } from "./support/factory-env";
import { APPROVE, factorySteps } from "./support/factory-steps";

/**
 * Issue #247: a reviewer that ends its turn without a verdict is nudged once (`nudges.reviewer`)
 * and its review fails when it ends again without one and stays idle past the grace period.
 * When that reviewer is replaced (it died, was stopped, its provider failed, its environment
 * blocked it, or a fresh one takes a conflict re-check), the new reviewer is owed its own nudge:
 * it must not inherit the old one's and fail the review without ever being reminded.
 *
 * The clock is fake (`Date` only), so session stamps and the factory's clock move together.
 */

const MIN = 60_000;
/** The default `idleGraceMin`. */
const GRACE = 10 * MIN;

const ENVIRONMENT_ONLY: ReviewVerdictInit = {
  ...APPROVE,
  verdict: "request_changes",
  summary: "The code is right, but node_modules is broken here, so the tests couldn't run",
  criteria: [{ criterion: "Counter increments", met: false, note: "Couldn't run locally" }],
  blockers: "environment",
};

let env: FactoryEnv;
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-11-14T10:00:00.000Z"));
});
afterEach(() => {
  env?.close();
  vi.useRealTimers();
});
const { item, tick, enable, verifying, review, lastMessageTo } = factorySteps(() => env);

const reviewerOf = (id: string) => item(id).reviewerSessionId as string;
const advance = (ms: number) => vi.setSystemTime(Date.now() + ms);
/** A session's turn starts or ends (or the session stops or dies) a second later on the clock. */
const setStatus = (sessionId: string, status: "running" | "idle" | "stopped" | "failed") => {
  advance(1_000);
  env.repo.update(sessionId, (s) => ({ ...s, status }));
};
const nudges = (sessionId: string) =>
  env.messages.filter((m) => m.sessionId === sessionId && m.text === REVIEWER_NUDGE).length;
/** Why the review check failed, or null while it hasn't. */
const reviewFailure = (id: string) => {
  const review = item(id).checks.find((c) => c.name === "review");
  return review?.state === "fail" ? (review.detail ?? "failed") : null;
};

/** A feature PR in verification (CI still running) with its independent reviewer at work. */
async function reviewing() {
  await enable();
  const { id, pr, builder } = await verifying("pending");
  const first = reviewerOf(id);
  expect(first).toBeTruthy();
  return { id, pr, builder, first };
}

/** The reviewer ends its turn without a verdict and gets the factory's nudge. */
async function endsTurnAndIsNudged(sessionId: string) {
  setStatus(sessionId, "idle");
  await tick();
  expect(env.messages.at(-1)).toEqual({ sessionId, text: REVIEWER_NUDGE });
}

/** The reviewer's turn fails on its provider's usage limit. */
function hitsUsageLimit(sessionId: string) {
  const T = `t-${sessionId}`;
  const retryAt = new Date(Date.now() + 30 * 60 * MIN).toISOString();
  env.store.append(
    [
      { type: "thread.started", thread: { id: T } } as const,
      { type: "turn.started", threadId: T, turnId: "u1" } as const,
      {
        type: "turn.failed",
        threadId: T,
        turnId: "u1",
        error: { message: "Usage limit", kind: "usage_limit", retryAt },
      } as const,
    ].map((e) => agentEventToNewEvent(sessionId, e)),
  );
  setStatus(sessionId, "idle");
}

/**
 * The tick after the first reviewer was replaced starts a fresh one, which then ends a turn
 * without a verdict, ends the next one without a verdict too, and stays idle. `kept` is the
 * nudge counting the replacement, which must survive it.
 */
async function replacementStalls(id: string, first: string, kept: string) {
  await tick();
  const fresh = reviewerOf(id);
  expect(fresh).toBeTruthy();
  expect(fresh).not.toBe(first);
  expect(item(id).nudges[kept]).toBeDefined();
  setStatus(fresh, "idle");
  await tick();
  const nudged = nudges(fresh);
  const afterFirstTurn = reviewFailure(id);
  // It ends its turn again without a verdict: its own grace period starts now.
  setStatus(fresh, "idle");
  advance(GRACE - MIN);
  await tick();
  const withinGrace = reviewFailure(id);
  advance(MIN + 1_000);
  await tick();
  return { nudged, afterFirstTurn, withinGrace, afterGrace: reviewFailure(id) };
}

/** Nudged once, and its review fails only once it stayed idle past its own grace period. */
const NUDGED_THEN_FAILED = {
  nudged: 1,
  afterFirstTurn: null,
  withinGrace: null,
  afterGrace: "The reviewer ended without a verdict",
};

describe("a replacement reviewer after its predecessor was nudged (#247)", () => {
  it("is nudged itself when the nudged reviewer died", async () => {
    env = createFactoryEnv();
    const { id, first } = await reviewing();
    await endsTurnAndIsNudged(first);
    setStatus(first, "failed");
    await tick();
    expect(await replacementStalls(id, first, "reviewer_failed_1")).toEqual(NUDGED_THEN_FAILED);
  });

  it("is nudged itself when the nudged reviewer was stopped and restarted", async () => {
    env = createFactoryEnv();
    const { id, first } = await reviewing();
    await endsTurnAndIsNudged(first);
    setStatus(first, "stopped");
    await tick();
    expect(await replacementStalls(id, first, "reviewer_restarted")).toEqual(NUDGED_THEN_FAILED);
  });

  it("is nudged itself when the nudged reviewer's provider hit its usage limit", async () => {
    env = createFactoryEnv();
    const { id, first } = await reviewing();
    await endsTurnAndIsNudged(first);
    hitsUsageLimit(first);
    await tick();
    expect(env.stopped).toContain(first);
    expect(await replacementStalls(id, first, "reviewer_provider_failed_1")).toEqual(
      NUDGED_THEN_FAILED,
    );
  });

  it("is nudged itself when the nudged reviewer was blocked by its environment", async () => {
    env = createFactoryEnv();
    const { id, first } = await reviewing();
    // Its environment stops it once; told to review again, it ends without a verdict twice.
    review(id, ENVIRONMENT_ONLY);
    await endsTurnAndIsNudged(first);
    setStatus(first, "idle");
    advance(GRACE + 1_000);
    await tick();
    expect(item(id)).toMatchObject({ stage: "failed", failureKind: "infrastructure" });
    expect(await replacementStalls(id, first, "review_clean_worktree")).toEqual(NUDGED_THEN_FAILED);
  });

  it("is nudged itself when a fresh reviewer takes over a conflict re-check", async () => {
    env = createFactoryEnv();
    const { id, pr, builder, first } = await reviewing();
    review(id);
    await tick();
    // The PR conflicts after the approval: the builder resolves it, the reviewer re-checks.
    pr.mergeable = "conflicting";
    await tick();
    env.gh.rebase(pr, "resolved", "pending");
    setStatus(builder, "idle");
    await tick();
    expect(lastMessageTo(first)).toContain("git range-diff");
    await endsTurnAndIsNudged(first);
    setStatus(first, "failed");
    await tick();
    expect(await replacementStalls(id, first, "reviewer_failed_1")).toEqual(NUDGED_THEN_FAILED);
    // The replacement was a fresh reviewer for the re-check.
    const briefs = env.starts.map((s) => s.input?.text ?? "");
    expect(briefs.filter((text) => text.includes("git range-diff"))).toHaveLength(1);
  });
});

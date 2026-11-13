import type { FactoryItem, ReviewVerdictInit } from "@codeden/contracts";
import { ReviewVerdict } from "@codeden/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  BUILDER_NUDGE,
  FOREGROUND_COMMANDS,
  REPRODUCE_NUDGE,
  REVIEWER_NUDGE,
} from "../src/services/factory/prompts";
import { createFactoryEnv, type FactoryEnv } from "./support/factory-env";

/**
 * Issue #124: an agent that runs a command in the background ends its turn ("the install is
 * still running, I'll carry on when it finishes") and is woken when the command exits. The
 * factory nudges it once on the first idle tick; the agent answers that it is still waiting and
 * ends its turn again. That second turn end must not fail the item while the agent is within
 * the grace period: only an agent that stays idle past it has really stopped.
 *
 * The clock is fake (`Date` only), so session stamps and the factory's clock move together.
 */

const APPROVE: ReviewVerdictInit = {
  verdict: "approve",
  summary: "Meets the criteria",
  criteria: [{ criterion: "Works", met: true }],
  vision: { aligned: true },
  tests: { adequate: true },
  security: { concerns: [] },
};

/** How often the factory loop ticks in production. */
const TICK_MS = 30_000;
const MIN = 60_000;

let env: FactoryEnv;
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-11-12T10:00:00.000Z"));
});
afterEach(() => {
  env?.close();
  vi.useRealTimers();
});

const enable = (tuning: { idleGraceMin?: number } = {}) =>
  env.factory.setMode(env.project.id, {
    mode: "software_factory",
    limits: env.project.factoryLimits,
    tuning,
  });
const tick = () => env.factory.tick(env.project.id);
const item = (id: string) => env.factory.data.item(id) as FactoryItem;
const byIssue = (number: number) =>
  env.factory.data.items(env.project.id).find((i) => i.issue?.number === number) as FactoryItem;
const builderOf = (id: string) => env.repo.get(item(id).builderSessionId as string);
const advance = (ms: number) => vi.setSystemTime(Date.now() + ms);
/** A session's turn starts (`running`) or ends (`idle`) a second later on the clock. */
const setStatus = (sessionId: string, status: "running" | "idle") => {
  advance(1_000);
  env.repo.update(sessionId, (s) => ({ ...s, status }));
};

/** A bug picked up by a builder, which is now working on the reproduction. */
async function buildingBug(): Promise<string> {
  const bug = env.gh.openIssue({
    projectId: env.project.id,
    title: "Save crashes on empty title",
    author: "codeden",
    labels: ["bug"],
  });
  await tick();
  const id = byIssue(bug.number).id;
  expect(item(id)).toMatchObject({ stage: "building", type: "bug" });
  return id;
}

/** A feature whose analysis is in, so the builder now owes a pull request. */
async function implementingFeature(): Promise<string> {
  const feat = env.gh.openIssue({
    projectId: env.project.id,
    title: "Add CSV export",
    author: "codeden",
    labels: ["enhancement"],
  });
  await tick();
  const id = byIssue(feat.number).id;
  await env.factory.submitAnalysis(builderOf(id), {
    decision: "implement",
    summary: "Not there yet",
    spec: "An Export button that downloads CSV",
    acceptanceCriteria: ["Export downloads a CSV"],
  });
  return id;
}

/** A feature PR in verification with its independent reviewer at work. */
async function reviewing(): Promise<string> {
  const id = await implementingFeature();
  const sessionId = item(id).builderSessionId as string;
  env.gh.openPr({ sessionId, title: item(id).title, files: ["src/export.ts", "test/e.test.ts"] });
  setStatus(sessionId, "idle");
  await tick();
  expect(item(id).stage).toBe("verifying");
  expect(item(id).reviewerSessionId).not.toBeNull();
  return id;
}

/**
 * The agent ends its turn, gets the nudge, answers that its background command is still running
 * and ends its turn again (the nudge put it back to running).
 */
async function endsTurnTwiceWaiting(sessionId: string, nudge: string) {
  setStatus(sessionId, "idle");
  await tick();
  expect(env.messages.at(-1)).toEqual({ sessionId, text: nudge });
  setStatus(sessionId, "idle");
}

describe("an agent waiting on its own background command (#124)", () => {
  it("keeps a bug builder that ends its turn again within the grace period", async () => {
    env = createFactoryEnv();
    enable();
    const id = await buildingBug();
    const builder = item(id).builderSessionId as string;
    await endsTurnTwiceWaiting(builder, REPRODUCE_NUDGE);
    // The next ticks while the install runs: the builder is still waiting, not stopped.
    advance(TICK_MS);
    await tick();
    expect(item(id).stage, item(id).reason ?? "").toBe("building");
    advance(8 * MIN);
    await tick();
    expect(item(id).stage, item(id).reason ?? "").toBe("building");
    expect(env.stopped).not.toContain(builder);
    // The install finishes and wakes the builder: it reports and opens its PR.
    setStatus(builder, "running");
    await env.factory.reportReproduction(builderOf(id), {
      reproduced: true,
      summary: "save('') throws",
      testPath: "test/save.test.ts",
    });
    env.gh.openPr({ sessionId: builder, title: item(id).title, files: ["src/save.ts"] });
    setStatus(builder, "idle");
    await tick();
    expect(item(id).stage).toBe("verifying");
  });

  it("keeps a builder without a pull request that ends its turn again within the grace period", async () => {
    env = createFactoryEnv();
    enable();
    const id = await implementingFeature();
    const builder = item(id).builderSessionId as string;
    await endsTurnTwiceWaiting(builder, BUILDER_NUDGE);
    advance(TICK_MS);
    await tick();
    expect(item(id).stage, item(id).reason ?? "").toBe("building");
    expect(env.stopped).not.toContain(builder);
    env.gh.openPr({ sessionId: builder, title: item(id).title, files: ["src/export.ts"] });
    setStatus(builder, "idle");
    await tick();
    expect(item(id).stage).toBe("verifying");
  });

  it("keeps a reviewer that ends its turn again within the grace period", async () => {
    env = createFactoryEnv();
    enable();
    const id = await reviewing();
    const reviewer = item(id).reviewerSessionId as string;
    await endsTurnTwiceWaiting(reviewer, REVIEWER_NUDGE);
    advance(TICK_MS);
    await tick();
    const review = item(id).checks.find((c) => c.name === "review");
    expect(review?.state, review?.detail ?? "").not.toBe("fail");
    expect(item(id)).toMatchObject({ stage: "verifying", attempts: 0 });
    env.factory.submitReview(env.repo.get(reviewer), ReviewVerdict.parse(APPROVE));
    await tick();
    expect(item(id).review?.verdict).toBe("approve");
    expect(item(id).attempts).toBe(0);
  });

  it("tells builders and reviewers to wait for their commands within the turn", async () => {
    env = createFactoryEnv();
    enable();
    await reviewing();
    const [builder, reviewer] = env.starts.map((s) => s.input?.text ?? "");
    expect(builder).toContain(FOREGROUND_COMMANDS);
    expect(reviewer).toContain(FOREGROUND_COMMANDS);
  });
});

describe("an agent that has really stopped (#124)", () => {
  it("fails a bug builder idle past the grace period after its last turn", async () => {
    env = createFactoryEnv();
    enable();
    const id = await buildingBug();
    const builder = item(id).builderSessionId as string;
    await endsTurnTwiceWaiting(builder, REPRODUCE_NUDGE);
    advance(9 * MIN);
    await tick();
    expect(item(id).stage).toBe("building");
    // Its command finishes and wakes it, but it ends this turn without reporting too: the
    // grace period starts again from this turn.
    setStatus(builder, "running");
    await tick();
    setStatus(builder, "idle");
    advance(9 * MIN);
    await tick();
    expect(item(id).stage).toBe("building");
    advance(MIN + 1_000);
    await tick();
    expect(item(id)).toMatchObject({
      stage: "failed",
      reason: "The builder ended without reporting its reproduction",
    });
  });

  it("fails a builder without a pull request idle past the grace period", async () => {
    env = createFactoryEnv();
    enable();
    const id = await implementingFeature();
    const builder = item(id).builderSessionId as string;
    await endsTurnTwiceWaiting(builder, BUILDER_NUDGE);
    advance(10 * MIN + 1_000);
    await tick();
    expect(item(id)).toMatchObject({
      stage: "failed",
      reason: "The builder finished without a pull request (no pull request)",
    });
  });

  it("fails the review of a reviewer idle past the grace period set in the tuning", async () => {
    env = createFactoryEnv();
    enable({ idleGraceMin: 2 });
    const id = await reviewing();
    const reviewer = item(id).reviewerSessionId as string;
    await endsTurnTwiceWaiting(reviewer, REVIEWER_NUDGE);
    advance(MIN);
    await tick();
    expect(item(id)).toMatchObject({ stage: "verifying", attempts: 0 });
    advance(MIN + 1_000);
    await tick();
    expect(item(id).checks.find((c) => c.name === "review")).toMatchObject({
      state: "fail",
      detail: "The reviewer ended without a verdict",
    });
    // A failed review is fixable: the builder gets a revise round.
    expect(item(id)).toMatchObject({ stage: "building", attempts: 1 });
  });
});

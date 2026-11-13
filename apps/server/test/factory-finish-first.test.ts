import type { FactoryLimits } from "@codeden/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { covers, namedPaths } from "../src/services/factory/overlap";
import { SlotBoard } from "../src/services/factory/slots";
import { createFactoryEnv, type FactoryEnv } from "./support/factory-env";
import { APPROVE, factorySteps } from "./support/factory-steps";

/**
 * Finish before starting (§10.1, issue #199): a free agent goes to reviews first, then fixes and
 * rebases, then builds (resumed ones before new ones), then the scout; at the work-in-progress
 * limit (`maxOpenPrs`) no new build starts and the scout files nothing; and queued work that
 * clearly overlaps an open PR waits behind work that doesn't. Driven through the real loop with
 * a fixed clock, scripted sessions and a scripted GitHub.
 */

let env: FactoryEnv;
afterEach(() => env?.close());
const { item, tick, later, lastMessageTo, enable, backlogItem, openPr, verifying, review } =
  factorySteps(() => env);

const reviewerOf = (id: string) => item(id).reviewerSessionId as string;
const status = () => env.factory.status(env.project.id);
const loop = () => env.factory.data.loopOrNew(env.project.id);

/** Change the factory limits the way the limits editor does (the loop reads them each tick). */
function setLimits(patch: Partial<FactoryLimits>) {
  const current = env.factory.ctx.projects.get(env.project.id).factoryLimits;
  env.updateProject({ factoryLimits: { ...current, ...patch } });
}

/** A build whose builder session died (a failure outside its code): it carries on later. */
async function stalledBuild(title: string, issue: number) {
  const created = backlogItem(title, issue);
  const res = await env.factory.ctx.sessions.startBuilder(created, "", "claude");
  if (res.status !== "started") throw new Error(`builder not started: ${res.status}`);
  await env.setStatus(res.sessionId, "failed");
  return env.factory.data.updateItem(created.id, (i) => ({
    ...i,
    stage: "failed",
    builderSessionId: res.sessionId,
    builderProvider: "claude",
    reason: "The builder session failed (the runner restarted)",
    failureKind: "infrastructure",
    finishedAt: new Date().toISOString(),
  }));
}

describe("slot priority (§10.1)", () => {
  it("serves waiting work by tier, what waited longer first within one, and forgets work that doesn't come back", () => {
    const board = new SlotBoard();
    board.beginTick("p");
    expect(board.claim("p", "build", "build:x", 0)).toBe(false);
    expect(board.claim("p", "review_early", "review:y", 0)).toBe(false);
    // One slot: the waiting review goes before the waiting build, whichever asks first.
    board.beginTick("p");
    expect(board.claim("p", "build", "build:x", 1)).toBe(false);
    expect(board.claim("p", "review_early", "review:y", 1)).toBe(true);
    // A new build waits behind the build that waited longer.
    board.beginTick("p");
    expect(board.claim("p", "build", "build:z", 1)).toBe(false);
    expect(board.claim("p", "build", "build:x", 1)).toBe(true);
    // The scout waits behind the build that is still waiting...
    board.beginTick("p");
    expect(board.claim("p", "scout", "scout", 1)).toBe(false);
    // ...which stops counting once it doesn't ask again (its item moved on).
    board.beginTick("p");
    expect(board.claim("p", "scout", "scout", 1)).toBe(true);
  });

  it("gives a freed agent to the waiting review, then the resumed builder, then the queued build", async () => {
    env = createFactoryEnv();
    await enable("software_factory", { tuning: { maxOpenPrs: 10 } });
    // Two builders hold both agents.
    const a = backlogItem("Add a counter", 3);
    const b = backlogItem("Add a timer", 4);
    await tick();
    expect([item(a.id).stage, item(b.id).stage]).toEqual(["building", "building"]);
    // Meanwhile an issue is queued, and a build whose builder died waits to carry on.
    const queued = backlogItem("Add a clock", 5);
    const stalled = await stalledBuild("Add a stopwatch", 6);
    // Agents at once goes down to 1 while both builders work.
    setLimits({ maxConcurrentSessions: 1 });

    // A's PR is up, but B's builder holds the only agent: the review waits, and so does the rest.
    await openPr(a.id);
    await tick();
    expect(item(a.id)).toMatchObject({
      stage: "verifying",
      reviewerSessionId: null,
      note: "Waiting for a free agent for the review",
    });
    expect(item(stalled.id).stage).toBe("failed");
    expect(item(queued.id).stage).toBe("backlog");

    // B's builder ends its turn: the free agent goes to A's waiting review, not to the stalled
    // builder (which the recovery used to resume first) nor to the queue, nor to B's new review.
    await openPr(b.id);
    await tick();
    expect(item(a.id).reviewerSessionId).not.toBeNull();
    expect(item(b.id)).toMatchObject({ stage: "verifying", reviewerSessionId: null });
    expect(item(stalled.id)).toMatchObject({
      stage: "failed",
      note: expect.stringMatching(/carries on when an agent is free/),
    });
    expect(item(queued.id).stage).toBe("backlog");

    // A's review approves and ends: the next agent goes to B's review.
    await review(a.id);
    await env.setStatus(reviewerOf(a.id), "idle");
    await tick();
    expect(item(a.id).stage).toBe("watching");
    expect(item(b.id).reviewerSessionId).not.toBeNull();
    expect(item(stalled.id).stage).toBe("failed");
    expect(item(queued.id).stage).toBe("backlog");

    // B's review ends: the stalled builder carries on before the queued issue starts.
    await review(b.id);
    await env.setStatus(reviewerOf(b.id), "idle");
    await tick();
    expect(item(stalled.id).stage).toBe("building");
    expect(item(queued.id).stage).toBe("backlog");
  });

  it("starts a revise round only when an agent is free, and never past the agent limit", async () => {
    env = createFactoryEnv();
    await enable("software_factory", { tuning: { maxOpenPrs: 10 } });
    const { id, builder } = await verifying();
    const other = backlogItem("Add a timer", 4);
    await tick();
    expect(item(other.id).stage).toBe("building");

    // The reviewer asks for changes; its turn and the other builder's hold both agents.
    await review(id, { ...APPROVE, verdict: "request_changes", summary: "Missing a test" });
    await tick();
    expect(item(id)).toMatchObject({
      stage: "verifying",
      attempts: 0,
      note: expect.stringMatching(/^Revise round 1 \(.*review.*\): waiting for a free agent$/),
    });
    expect(env.messages.filter((m) => m.sessionId === builder)).toEqual([]);

    // The reviewer's turn ends: its agent goes to the revise round.
    await env.setStatus(reviewerOf(id), "idle");
    await tick();
    expect(item(id)).toMatchObject({ stage: "building", attempts: 1 });
    expect(lastMessageTo(builder)).not.toBe("");
  });
});

describe("the work-in-progress limit (maxOpenPrs)", () => {
  it("starts no new build and files nothing at the limit, and builds again once a PR merges", async () => {
    env = createFactoryEnv({ limits: { maxConcurrentSessions: 3 } });
    await enable("dark_factory", {
      tuning: { maxOpenPrs: 2, minBacklog: 3, discoveryPerRound: 0 },
    });
    // The scout's round starts while nothing is open.
    await tick();
    const scout = env.repo.get(loop().scout.sessionId as string);
    expect(loop().scout.round?.phase).toBe("planning");

    // Two PRs open: the limit holds.
    const a = await verifying("success", "Add a counter", 3);
    const b = await verifying("success", "Add a timer", 4);
    expect((await status()).wip).toEqual({ openPrs: 2, limit: 2, holding: true });

    // The scout files nothing while open work is being finished.
    await env.factory.planRound(scout, { lenses: [] });
    const issue = {
      title: "Archive finished sessions",
      summary: "Worktrees pile up",
      type: "feature" as const,
      acceptanceCriteria: ["Archived sessions lose their worktree"],
      priority: "normal" as const,
    };
    await expect(env.factory.fileIssue(scout, issue)).rejects.toThrow(
      /Finishing open work \(2 of 2 PRs open\)/,
    );
    expect(env.gh.issues).toEqual([]);
    // Its round ends; the next one is due but doesn't start at the limit.
    await env.setStatus(scout.id, "idle");
    await tick();
    expect(loop().scout.round).toBeNull();
    later(loop().tuning.discoveryIntervalMin * 60_000 + 1);

    // A queued issue waits; a repair of the default branch still starts (every PR waits on it).
    const queued = backlogItem("Add a clock", 5);
    const repair = env.factory.data.createItem({
      projectId: env.project.id,
      workKey: "factory:fix-main-abc1234",
      title: "Fix failing checks on main",
      summary: "Checks failing on abc1234: test.",
      source: "failed_check",
      stage: "backlog",
      type: "bug",
      score: 1,
      acceptanceCriteria: ["CI on main is green"],
      issue: null,
    });
    await tick();
    expect(item(queued.id)).toMatchObject({
      stage: "backlog",
      note: "Waiting: finishing open work (2 of 2 PRs open)",
    });
    expect(item(repair.id).stage).toBe("building");
    expect(loop().scout.round).toBeNull();
    const held = await status();
    expect(held.scout?.runNowBlockedBy).toMatch(/^Finishing open work \(2 of 2 PRs open\)/);
    expect(held.backlog.find((w) => w.id === queued.id)?.note).toMatch(/finishing open work/);

    // A's PR merges: one PR open, so the queued issue gets the free agent.
    await review(a.id);
    await env.setStatus(reviewerOf(a.id), "idle");
    await tick();
    expect(item(a.id).stage).toBe("watching");
    expect(item(queued.id)).toMatchObject({ stage: "building", note: null });
    expect((await status()).wip).toEqual({ openPrs: 1, limit: 2, holding: false });
    expect(item(b.id).stage).toBe("verifying");
  });

  it("follows Agents at once until it is set, and counts PRs waiting for a person to merge", async () => {
    env = createFactoryEnv({ limits: { maxConcurrentSessions: 1 } });
    await enable("software_factory", { autoMerge: false });
    expect(loop().tuning.maxOpenPrs).toBeNull();
    // Reviewed and ready for a person to merge: still open, so the one PR the limit allows.
    const { id } = await verifying();
    await review(id);
    await env.setStatus(reviewerOf(id), "idle");
    const queued = backlogItem("Add a timer", 4);
    await tick();
    expect((await status()).wip).toEqual({ openPrs: 1, limit: 1, holding: true });
    expect(item(queued.id)).toMatchObject({
      stage: "backlog",
      note: "Waiting: finishing open work (1 of 1 PRs open)",
    });
    // Raised in the limits: the queued issue starts.
    await enable("software_factory", { autoMerge: false, tuning: { maxOpenPrs: 3 } });
    await tick();
    expect(item(queued.id).stage).toBe("building");
    expect((await status()).wip).toEqual({ openPrs: 1, limit: 3, holding: false });
  });
});

describe("overlap-aware scheduling", () => {
  it("defers a queued item that overlaps an open PR, and still starts it when it is the only one", async () => {
    env = createFactoryEnv();
    await enable("software_factory", { tuning: { maxOpenPrs: 10 } });
    // An open PR changes src/counter.ts; its reviewer holds one of the two agents.
    const { pr } = await verifying();
    const overlapping = backlogItem("Count clicks", 7);
    env.factory.data.updateItem(overlapping.id, (i) => ({
      ...i,
      summary: "Clicks should be counted too, in `src/counter.ts`.",
    }));
    const separate = backlogItem("Add a timer", 8);

    // The overlapping item is first in the queue, but the other one gets the free agent.
    await tick();
    expect(item(separate.id).stage).toBe("building");
    expect(item(overlapping.id)).toMatchObject({
      stage: "backlog",
      note: `Deferred: likely overlaps open PR #${pr.ref.number} (src/counter.ts)`,
    });

    // Nothing else waits: it starts when an agent is free, overlap or not.
    setLimits({ maxConcurrentSessions: 3 });
    await tick();
    expect(item(overlapping.id)).toMatchObject({ stage: "building", note: null });
  });

  it("estimates the paths an issue names and when they clearly overlap a change", () => {
    expect(
      namedPaths(
        "Fix `apps/web/src/components/factory/` and docs/DESIGN.md. See https://github.com/acme/app/blob/main/x/y.ts, and/or ./src/a.ts.",
      ).sort(),
    ).toEqual(["and/or", "apps/web/src/components/factory", "docs/DESIGN.md", "src/a.ts"]);
    expect(namedPaths("Make the counter faster")).toEqual([]);
    expect(covers("docs/DESIGN.md", "docs/DESIGN.md")).toBe(true);
    expect(covers("factory/loop.ts", "apps/server/src/services/factory/loop.ts")).toBe(true);
    expect(covers("apps/web/src", "apps/web/src/main.tsx")).toBe(true);
    expect(covers("components/factory", "apps/web/src/components/factory/x.tsx")).toBe(true);
    expect(covers("src/loop.ts", "src/loop.tsx")).toBe(false);
    expect(covers("apps/web", "apps/website/index.ts")).toBe(false);
    expect(covers("and/or", "src/counter.ts")).toBe(false);
  });
});

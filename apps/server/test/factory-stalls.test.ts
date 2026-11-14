import type { FactoryItem } from "@codeden/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { PROVIDER_WAIT_NOTICE_MS } from "../src/services/factory/provider-wait";
import { stuckInboxId } from "../src/services/factory/stuck";
import { createFactoryEnv, type FactoryEnv } from "./support/factory-env";
import { factorySteps } from "./support/factory-steps";

/**
 * The factory doesn't stall silently (issue #236): a PR GitHub keeps refusing to merge leaves
 * the merge queue after a few tries, work waiting on a signed-out or limited provider doesn't
 * hold the work-in-progress limit, and no tick starts more builds than the limit has room for.
 * Driven through the real loop with the factory test clock and a scripted GitHub.
 */

let env: FactoryEnv;
afterEach(() => env?.close());
const { item, tick, later, enable, backlogItem, verifying, review } = factorySteps(() => env);

/** Hold merges (the loop is paused) while work in flight keeps moving. */
function pause() {
  const loop = env.factory.data.loopOrNew(env.project.id);
  env.factory.data.saveLoop({ ...loop, state: "paused", pausedReason: "held by the test" });
}

const REFUSED = "Pull Request is not mergeable: a required status check is expected";

/** GitHub refuses to merge PR `number` (branch protection, a required check that never reports). */
function refuseMerges(number: number) {
  const merge = env.gh.merge.bind(env.gh);
  const attempts = { count: 0 };
  env.gh.merge = async (projectId, n, opts) => {
    if (n !== number) return merge(projectId, n, opts);
    attempts.count++;
    throw new Error(REFUSED);
  };
  return attempts;
}

/** The PM notices about an item that say it failed or is stuck. */
const failedNotices = (itemId: string) =>
  env.notices.filter((n) => {
    const data = n.data as { event: string; itemIds?: string[] };
    return data.event === "failed" && data.itemIds?.includes(itemId);
  });

/** Two approved PRs, A queued ahead of B. */
async function twoQueued() {
  const a = await verifying("success", "Add a counter", 3);
  const b = await verifying("success", "Add a timer", 4);
  pause();
  review(a.id);
  await tick();
  later(1_000);
  review(b.id);
  await tick();
  env.factory.resume(env.project.id);
  return { a, b };
}

describe("a PR GitHub refuses to merge", () => {
  it("leaves the queue after 3 refused merges, with one notice, and the next PR merges", async () => {
    env = createFactoryEnv();
    await enable();
    const { a, b } = await twoQueued();
    const attempts = refuseMerges(a.pr.ref.number);

    await tick();
    expect(item(a.id)).toMatchObject({
      stage: "verifying",
      note: `Merge failed: ${REFUSED} (try 1 of 3)`,
    });
    for (let n = 0; n < 5; n++) await tick();

    expect({
      stage: item(a.id).stage,
      failureKind: item(a.id).failureKind,
      reason: item(a.id).reason,
      mergeAttempts: attempts.count,
      merged: env.gh.merges.map((m) => m.number),
      notices: failedNotices(a.id).length,
      inbox: env.inbox.find(stuckInboxId(a.id))?.status,
    }).toEqual({
      stage: "failed",
      failureKind: "stuck",
      reason: `Merge failed 3 times in a row; GitHub said: ${REFUSED}`,
      mergeAttempts: 3,
      merged: [b.pr.ref.number],
      notices: 1,
      inbox: "open",
    });
    // Out of the queue: the panel no longer gives it a place in line.
    const entry = (await env.factory.status(env.project.id)).pullRequests.find(
      (p) => p.itemId === a.id,
    );
    expect(entry?.queuePosition).toBeNull();
  });

  it("starts counting again on a new head commit", async () => {
    env = createFactoryEnv();
    await enable();
    const { a } = await twoQueued();
    const attempts = refuseMerges(a.pr.ref.number);
    await tick();
    await tick();
    expect(attempts.count).toBe(2);

    // A new head: verification sees it, its checks pass again, and the count starts afresh.
    env.gh.rebase(a.pr, "head-new", "success");
    await tick();
    await tick();
    expect(attempts.count).toBe(4);
    expect(item(a.id)).toMatchObject({
      stage: "verifying",
      note: `Merge failed: ${REFUSED} (try 2 of 3)`,
    });
    await tick();
    expect(attempts.count).toBe(5);
    expect(item(a.id).stage).toBe("failed");
  });

  it("leaves the queue after 3 refused updates with the default branch", async () => {
    env = createFactoryEnv();
    await enable();
    const { a, b } = await twoQueued();
    // A merges; B is behind main now, and GitHub refuses to bring it up to date.
    await tick();
    expect(env.gh.merges.map((m) => m.number)).toEqual([a.pr.ref.number]);
    env.gh.updateBranch = async () => {
      throw new Error("Resource not accessible by integration");
    };
    for (let n = 0; n < 4; n++) await tick();
    expect(item(b.id)).toMatchObject({
      stage: "failed",
      failureKind: "stuck",
      reason:
        "Could not update it with main 3 times in a row; GitHub said: Resource not accessible by integration",
    });
    expect(failedNotices(b.id)).toHaveLength(1);
  });
});

/** A build whose builder's provider failed it, with its PR open: it goes back once the provider is back. */
async function waitingOnProvider(provider: string, title: string, issue: number) {
  const created = backlogItem(title, issue);
  const res = await env.factory.ctx.sessions.startBuilder(created, "", provider);
  if (res.status !== "started") throw new Error(`builder not started: ${res.status}`);
  const pr = env.gh.openPr({ sessionId: res.sessionId, title, files: ["src/clock.ts"] });
  await env.setStatus(res.sessionId, "failed");
  return env.factory.data.updateItem(
    created.id,
    (i): FactoryItem => ({
      ...i,
      stage: "failed",
      builderSessionId: res.sessionId,
      builderProvider: provider,
      pr: pr.ref,
      reason: "The builder session failed (Codex is at its usage limit)",
      failureKind: "infrastructure",
      finishedAt: new Date().toISOString(),
    }),
  );
}

describe("work waiting on a provider", () => {
  it("doesn't count toward the work-in-progress limit, says so, and tells the PM once", async () => {
    env = createFactoryEnv({ limits: { maxConcurrentSessions: 2 } });
    await enable("software_factory", { tuning: { maxOpenPrs: 1 } });
    // Codex is at its usage limit for hours: its failed build can't go back yet.
    env.rateLimits = [
      {
        provider: "codex",
        status: "limited",
        resetsAt: new Date(Date.now() + 5 * 3_600_000).toISOString(),
        observedAt: new Date().toISOString(),
      },
    ];
    const stalled = await waitingOnProvider("codex", "Add a clock", 5);
    const queued = backlogItem("Add a timer", 6);

    await tick();
    expect(item(stalled.id).stage).toBe("failed");
    expect(item(queued.id)).toMatchObject({ stage: "building", note: null });
    const { wip } = await env.factory.status(env.project.id);
    expect(wip).toEqual({
      openPrs: 0,
      limit: 1,
      holding: false,
      waitingOnProvider: 1,
      note: expect.stringMatching(
        /^1 PR waits on codex \(at its usage limit until \w{3} \d\d:\d\d\) and doesn't count$/,
      ),
    });
    expect(failedNotices(stalled.id)).toEqual([]);

    // Waiting for longer than a few ticks: the PM hears once.
    later(PROVIDER_WAIT_NOTICE_MS);
    await tick();
    await tick();
    expect(failedNotices(stalled.id)).toEqual([
      expect.objectContaining({ title: expect.stringMatching(/^Factory work waits on codex/) }),
    ]);
    later(PROVIDER_WAIT_NOTICE_MS);
    await tick();
    expect(failedNotices(stalled.id)).toHaveLength(1);

    // Codex is back: the item goes back to verification, and its PR counts again.
    env.rateLimits = [];
    await tick();
    expect(item(stalled.id).stage).toBe("verifying");
    const marks = Object.keys(item(stalled.id).nudges).filter((k) => k.startsWith("provider_wait"));
    expect(marks).toEqual([]);
    expect((await env.factory.status(env.project.id)).wip).toMatchObject({
      openPrs: 1,
      waitingOnProvider: 0,
      note: null,
    });
  });
});

describe("the work-in-progress limit", () => {
  it("starts no more builds than it has room for, within one tick and on the next", async () => {
    env = createFactoryEnv({ limits: { maxConcurrentSessions: 3 } });
    await enable("software_factory", { tuning: { maxOpenPrs: 1 } });
    const items = [
      backlogItem("Add a counter", 3),
      backlogItem("Add a timer", 4),
      backlogItem("Add a clock", 5),
    ];

    const stages = () => items.map((i) => item(i.id).stage).sort();
    await tick();
    expect(stages()).toEqual(["backlog", "backlog", "building"]);
    const waiting = items.filter((i) => item(i.id).stage === "backlog");
    expect(waiting.map((i) => item(i.id).note)).toEqual([
      "Waiting: finishing open work (0 of 1 PRs open, 1 more being built)",
      "Waiting: finishing open work (0 of 1 PRs open, 1 more being built)",
    ]);
    // The build has no PR yet, but it will open one: the next tick starts nothing either.
    await tick();
    expect(stages()).toEqual(["backlog", "backlog", "building"]);
  });
});

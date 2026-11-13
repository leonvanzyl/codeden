import { afterEach, describe, expect, it } from "vitest";
import { createFactoryEnv, type FactoryEnv } from "./support/factory-env";
import { APPROVE, factorySteps } from "./support/factory-steps";

/**
 * The merge queue (§10.1, Merge): with auto-merge on, approved PRs merge one at a time, oldest
 * approved first. The head of the queue is brought up to date with main through GitHub's
 * update-branch (no agent) and merges once CI passes on the new head. A conflict an agent
 * resolves after the approval is re-checked by the reviewer, the resolution only.
 */

let env: FactoryEnv;
afterEach(() => env?.close());
const { item, tick, later, lastMessageTo, enable, verifying, review } = factorySteps(() => env);

const prEntry = async (itemId: string) =>
  (await env.factory.status(env.project.id)).pullRequests.find((p) => p.itemId === itemId);

/** Hold merges (the loop is paused) while work in flight keeps moving. */
function pause() {
  const loop = env.factory.data.loopOrNew(env.project.id);
  env.factory.data.saveLoop({ ...loop, state: "paused", pausedReason: "held by the test" });
}

describe("the merge queue", () => {
  it("merges approved PRs one at a time, oldest approved first, updating the next with main", async () => {
    env = createFactoryEnv();
    await enable();
    const a = await verifying("success", "Add a counter", 3);
    const b = await verifying("success", "Add a timer", 4);
    pause();
    review(a.id);
    await tick();
    later(1_000);
    review(b.id);
    await tick();
    expect(env.gh.merges).toEqual([]);
    const queued = (await env.factory.status(env.project.id)).pullRequests;
    expect(queued.map((p) => [p.itemId, p.state, p.queuePosition])).toEqual([
      [a.id, "queued", 1],
      [b.id, "queued", 2],
    ]);

    env.factory.resume(env.project.id);
    await tick();
    // One merge per tick, the oldest approval first.
    expect(env.gh.merges.map((m) => m.number)).toEqual([a.pr.ref.number]);
    expect(item(b.id).stage).toBe("verifying");

    // Main moved, so B is behind: GitHub merges main into it (no agent), its head pinned.
    const before = b.pr.headSha as string;
    await tick();
    expect(env.gh.updates).toEqual([{ number: b.pr.ref.number, expectedHeadSha: before }]);
    expect(await prEntry(b.id)).toMatchObject({ state: "updating", queuePosition: 1 });
    expect(env.gh.merges).toHaveLength(1);

    // CI runs on the new head: it waits at the head of the queue until CI passes.
    await tick();
    expect(await prEntry(b.id)).toMatchObject({ state: "waiting_ci", queuePosition: 1 });
    expect(env.gh.merges).toHaveLength(1);
    b.pr.checks = "success";
    await tick();
    expect(env.gh.merges.map((m) => m.number)).toEqual([a.pr.ref.number, b.pr.ref.number]);
    expect(item(b.id).stage).toBe("watching");
    expect(await prEntry(b.id)).toMatchObject({ state: "merged", queuePosition: null });
    // Merging main in needs no new review.
    expect(env.messages.some((m) => /range-diff/.test(m.text))).toBe(false);
    expect(env.gh.updates).toHaveLength(1);
  });

  it("has the reviewer re-check only the resolution after an agent rebased an approved PR", async () => {
    env = createFactoryEnv();
    await enable();
    const { id, pr, builder } = await verifying("pending");
    review(id);
    await tick();
    expect(item(id).stage).toBe("verifying");
    const oldHead = pr.headSha as string;

    pr.mergeable = "conflicting";
    await tick();
    expect(lastMessageTo(builder)).toMatch(/\*\*Rebase\*\*/);
    expect(item(id).attempts).toBe(0);
    expect(await prEntry(id)).toMatchObject({ state: "rebasing", queuePosition: null });

    // The builder rebases; CI passes on the new head, but the approval waits for the re-check.
    env.gh.rebase(pr, "rebased1", "success");
    await env.setStatus(builder, "idle");
    await tick();
    const reviewer = item(id).reviewerSessionId as string;
    expect(item(id).checks.find((c) => c.name === "review")).toMatchObject({
      state: "pending",
      detail: expect.stringMatching(/re-checks the resolution/),
    });
    expect(lastMessageTo(reviewer)).toContain(`git range-diff ${oldHead}...rebased1`);
    expect(env.gh.merges).toEqual([]);

    const res = review(id, { ...APPROVE, summary: "The resolution keeps both sides" });
    expect(res).toMatchObject({
      recorded: true,
      message: expect.stringMatching(/earlier verdict/),
    });
    expect(item(id).review?.summary).toBe(APPROVE.summary);
    await tick();
    expect(env.gh.merges.map((m) => m.number)).toEqual([pr.ref.number]);
  });
});

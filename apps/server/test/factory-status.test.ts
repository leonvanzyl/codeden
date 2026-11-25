import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createFactoryEnv, type FactoryEnv } from "./support/factory-env";
import { factorySteps } from "./support/factory-steps";

/**
 * The panel's "Merge checks" column is the CI of a PR the factory still has something to do with.
 * A PR whose GitHub state already settled - closed unmerged, or merged - decides nothing the
 * factory can act on, so it must not gate there. What the item recorded for that PR (its checks,
 * its review) stays where it was: the evidence is kept, and nothing reopens, retries or rebuilds.
 */

let env: FactoryEnv;
const steps = factorySteps(() => env);
const { item, tick, enable, verifying, review, prEntry } = steps;
afterEach(() => env?.close());
beforeEach(() => {
  env = createFactoryEnv();
});

/** A reviewed feature whose PR is open and green; auto-merge is off, so a person merges it. */
async function approved() {
  enable(undefined, { autoMerge: false });
  const { id } = await verifying("success");
  await review(id);
  await env.setStatus(item(id).reviewerSessionId as string, "idle");
  await tick();
  expect(item(id)).toMatchObject({ stage: "verifying", review: { verdict: "approve" } });
  return id;
}

const mergeChecks = async () => (await env.factory.status(env.project.id)).mergeChecks;
const gating = async () => (await mergeChecks()).map((c) => c.prNumber);

/** As if a person closed the PR on GitHub without merging it. */
function closePrOnGithub(prNumber: number) {
  const fake = env.gh.prs.get(prNumber);
  if (!fake) throw new Error(`no PR ${prNumber}`);
  fake.ref = { ...fake.ref, state: "closed" };
}

describe("factory status: merge checks follow the PR's GitHub state", () => {
  it("a PR closed on GitHub without being merged stops gating", async () => {
    const id = await approved();
    const prNumber = item(id).pr?.number as number;
    const starts = env.starts.length;

    // While the PR is open and unmerged, its checks gate.
    expect(await gating()).toEqual([prNumber]);

    closePrOnGithub(prNumber);

    // It stops gating as soon as the sync says so, without waiting for the loop to read it again.
    expect(await mergeChecks()).toEqual([]);

    // The loop then settles the item; the checks column stays out of it either way.
    await tick();
    expect(item(id)).toMatchObject({
      stage: "rejected",
      reason: "The pull request was closed on GitHub",
    });
    const status = await env.factory.status(env.project.id);
    expect(status.mergeChecks).toEqual([]);
    expect(status.pullRequests).toEqual([]);

    // Nothing reopened, retried or rebuilt.
    expect(env.starts).toHaveLength(starts);

    // The evidence survives: the item keeps the closed PR, its checks and the review.
    const shown = env.factory.item(env.project.id, id);
    expect(shown.pr).toMatchObject({ number: prNumber, state: "closed" });
    expect(shown.review?.verdict).toBe("approve");
    expect(shown.checks.map((c) => c.name)).toContain("ci");
  });

  it("a merged PR is not a pending merge check, and its PR card keeps it", async () => {
    enable(undefined, { autoMerge: true });
    const { id, pr } = await verifying("success");
    await review(id);
    await env.setStatus(item(id).reviewerSessionId as string, "idle");
    await tick();

    // The factory merged it and is watching CI on the default branch.
    expect(item(id)).toMatchObject({ stage: "watching", pr: { state: "merged" } });
    expect(pr.ref.state).toBe("merged");
    expect(await mergeChecks()).toEqual([]);

    // The evidence survives: the item keeps the merged PR and the checks it recorded.
    const shown = env.factory.item(env.project.id, id);
    expect(shown.pr).toMatchObject({ number: pr.ref.number, state: "merged" });
    expect(shown.checks.map((c) => c.name)).toContain("ci");
  });

  it("an open PR keeps gating while the factory still owns it", async () => {
    const id = await approved();
    const prNumber = item(id).pr?.number as number;
    const [entry] = await mergeChecks();
    if (!entry) throw new Error("the open PR should gate");
    expect(entry).toMatchObject({ itemId: id, prNumber, verdict: "approve" });
    expect(entry.checks.map((c) => c.name)).toContain("ci");
    expect(await prEntry(prNumber)).toMatchObject({
      pr: { number: prNumber, state: "open" },
      state: "waiting_for_you",
    });
  });
});

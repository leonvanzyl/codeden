import { afterEach, describe, expect, it } from "vitest";
import { reReviewPrompt, reviewerPrompt } from "../src/services/factory/prompts";
import { recheckPrompt } from "../src/services/factory/prompts-integration";
import { createFactoryEnv, type FactoryEnv } from "./support/factory-env";
import { APPROVE, factorySteps } from "./support/factory-steps";

/**
 * Issue #206: a reviewer whose own checkout can't run the tests (a half-finished install, a
 * corrupted dependency) must not cost the pull request a revise round or fail its item. Green
 * CI on the PR's head is the authority for the full suite; only a cause in the PR may request
 * changes.
 */

let env: FactoryEnv;
afterEach(() => env?.close());
const { item, tick, enable, verifying, review, lastMessageTo } = factorySteps(() => env);

/** What the reviewer of #180 sent: the code is right, but it couldn't run the suite locally. */
const ENVIRONMENT_ONLY = {
  ...APPROVE,
  verdict: "request_changes" as const,
  summary:
    "No outstanding application-source defect. I couldn't run `pnpm test` locally: the installed zod is missing v4/classic/coerce.js and lru-cache failed to load.",
  criteria: [
    { criterion: "Counter increments", met: true },
    {
      criterion: "`pnpm test` passes",
      met: false,
      note: "Couldn't run locally: node_modules is broken (zod, lru-cache)",
    },
  ],
  blockers: "environment" as const,
};

describe("a request for changes that cites only the reviewer's environment, with green CI", () => {
  it("doesn't use up a revise round, and the reviewer gets the CI result", async () => {
    env = createFactoryEnv();
    await enable();
    const { id, builder } = await verifying("success");
    const sentToAuthor = env.messages.filter((m) => m.sessionId === builder).length;
    const res = review(id, ENVIRONMENT_ONLY);
    expect(res.recorded).toBe(false);
    expect(res.message).toMatch(/CI on the pull request's head passed/);
    expect(res.message).toMatch(/submit a fresh verdict/);
    await tick();
    expect(item(id)).toMatchObject({ stage: "verifying", attempts: 0, review: null });
    expect(env.messages.filter((m) => m.sessionId === builder)).toHaveLength(sentToAuthor);

    // Told CI is the authority, the reviewer approves on the merits, and the PR merges.
    review(id, { ...APPROVE, summary: "Approve: CI is green; local tests couldn't run" });
    await tick();
    expect(item(id).stage).toBe("watching");
    expect(env.gh.merges).toHaveLength(1);
  });

  it("doesn't fail the item when no revise round is left", async () => {
    env = createFactoryEnv();
    await enable("software_factory", { tuning: { maxFixAttempts: 0 } });
    const { id } = await verifying("success");
    review(id, ENVIRONMENT_ONLY);
    await tick();
    expect(item(id).stage).not.toBe("failed");
    expect(item(id).attempts).toBe(0);
  });

  it("when it happens again, recovers as an infrastructure failure with a reviewer in a clean worktree", async () => {
    env = createFactoryEnv();
    await enable();
    const { id } = await verifying("success");
    const prNumber = item(id).pr?.number;
    const first = item(id).reviewerSessionId as string;
    review(id, ENVIRONMENT_ONLY);
    const res = review(id, ENVIRONMENT_ONLY);
    expect(res.message).toMatch(/a fresh reviewer reviews it in a clean worktree/);
    expect(item(id)).toMatchObject({
      stage: "failed",
      failureKind: "infrastructure",
      attempts: 0,
      reviewerSessionId: null,
    });
    expect(item(id).earlierSessionIds).toContain(first);
    // An infrastructure failure never counts towards pausing the loop.
    expect(env.factory.data.loopOrNew(env.project.id).consecutiveFailures).toBe(0);

    await tick();
    await tick();
    expect(item(id)).toMatchObject({ stage: "verifying", attempts: 0 });
    const fresh = item(id).reviewerSessionId;
    expect(fresh).not.toBeNull();
    expect(fresh).not.toBe(first);
    // Not the author's worktree this time: a new one on the PR's head.
    expect(env.starts.at(-1)?.workspace).toMatchObject({
      mode: "worktree",
      baseRef: `origin/codeden/pr-${prNumber}`,
    });
  });

  it("is never passed to the author during a revise round", async () => {
    env = createFactoryEnv();
    await enable();
    const { id, builder } = await verifying("success");
    env.factory.data.updateItem(id, (i) => ({ ...i, stage: "building" }));
    const res = review(id, ENVIRONMENT_ONLY);
    expect(res.recorded).toBe(false);
    expect(res.message).toMatch(/not passed to the author/);
    expect(lastMessageTo(builder)).not.toMatch(/Also address/);
  });
});

describe("reviewer briefs", () => {
  const pr = {
    id: "i1",
    type: "bug",
    title: "Crash on save",
    acceptanceCriteria: ["`pnpm test` passes"],
    investigation: null,
    review: null,
    pr: { number: 9, url: "https://github.com/acme/app/pull/9", state: "open" },
  } as never;

  it("make CI on the PR head the authority for the full suite", () => {
    const text = reviewerPrompt(pr, "v", null, "main", false);
    expect(text).toMatch(/CI on the pull request's head is the authority for the full test suite/);
    expect(text).toMatch(/never request changes only because local verification couldn't run/i);
    expect(text).toMatch(
      /CI=true pnpm install --frozen-lockfile --config\.confirm-modules-purge=false/,
    );
    expect(reReviewPrompt(pr)).toMatch(/authority for the full test suite/);
    expect(recheckPrompt(pr, "aaa", "bbb", "main")).toMatch(/CI on the new head is the authority/);
  });
});

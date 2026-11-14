import { afterEach, describe, expect, it } from "vitest";
import { assertMayRetry } from "../src/mcp/tools/pm/issue-trust";
import { createFactoryEnv, type FactoryEnv } from "./support/factory-env";
import { APPROVE, factorySteps } from "./support/factory-steps";

/**
 * Stopped items with an open PR (#259): a failed item whose PR is still open gets one bounded
 * re-review on its own once its head moved past its last verdict, and Retry resumes the PR
 * instead of starting the pipeline over.
 */

let env: FactoryEnv;
afterEach(() => env?.close());
const { item, tick, lastMessageTo, enable, verifying, review, failed, readAgainSoon } =
  factorySteps(() => env);

const CHANGES = {
  ...APPROVE,
  verdict: "request_changes" as const,
  summary: "The counter never resets",
};

describe("failed items with an open PR", () => {
  it("re-reviews a failed item once its PR has a head newer than its last verdict, then merges it on approve", async () => {
    env = createFactoryEnv();
    await enable("dark_factory");
    const { id, pr } = await verifying();
    review(id, CHANGES);
    // Its revise rounds ran out on that verdict; the item failed.
    failed(id);
    const reviewer = item(id).reviewerSessionId as string;
    await env.setStatus(reviewer, "idle");
    await tick();
    expect(item(id).stage).toBe("failed");

    // The builder's fix lands after the last review: a new head, mergeable, CI green.
    env.gh.rebase(pr, "fixed-after-review");
    readAgainSoon(id);
    await tick();
    // One re-review of the existing PR, no new build.
    expect(item(id)).toMatchObject({ stage: "verifying", pr: { number: pr.ref.number } });
    expect(item(id).review).toBeNull();
    await tick();
    review(id);
    await tick();
    await tick();
    expect(env.gh.merges.map((m) => m.number)).toContain(pr.ref.number);
  });

  it("isn't re-reviewed again without a new head", async () => {
    env = createFactoryEnv();
    await enable("dark_factory");
    const { id, pr } = await verifying();
    review(id, CHANGES);
    failed(id);
    await env.setStatus(item(id).reviewerSessionId as string, "idle");
    env.gh.rebase(pr, "fixed-after-review");
    readAgainSoon(id);
    await tick();
    expect(item(id).stage).toBe("verifying");
    // The re-review asks for changes on that same head and the item stops again.
    await tick();
    review(id, CHANGES);
    failed(id);
    const starts = env.starts.length;
    readAgainSoon(id);
    await tick();
    readAgainSoon(id);
    await tick();
    expect(item(id).stage).toBe("failed");
    expect(env.starts.length).toBe(starts);
  });

  it("gives the builder one more revise round when the re-review asks for changes", async () => {
    env = createFactoryEnv();
    await enable("dark_factory");
    const { id, pr, builder } = await verifying();
    review(id, CHANGES);
    // Both revise rounds used, then it stopped.
    env.factory.data.updateItem(id, (i) => ({ ...i, attempts: 2 }));
    failed(id);
    await env.setStatus(item(id).reviewerSessionId as string, "idle");
    env.gh.rebase(pr, "fixed-after-review");
    readAgainSoon(id);
    await tick();
    await tick();
    review(id, CHANGES);
    await tick();
    expect(item(id)).toMatchObject({ stage: "building", attempts: 3 });
    expect(lastMessageTo(builder)).toMatch(/\*\*Revise\*\*/);
  });

  it("waits for CI on the new head before it re-reviews", async () => {
    env = createFactoryEnv();
    await enable("dark_factory");
    const { id, pr } = await verifying();
    review(id, CHANGES);
    failed(id);
    await env.setStatus(item(id).reviewerSessionId as string, "idle");
    env.gh.rebase(pr, "fixed-after-review", "pending");
    readAgainSoon(id);
    await tick();
    expect(item(id).stage).toBe("failed");
    expect(item(id).note).toMatch(/needs a re-review \(Retry\)\. .*once CI passes/);
    pr.checks = "success";
    readAgainSoon(id);
    await tick();
    expect(item(id).stage).toBe("verifying");
  });

  it("says a failed item's PR needs a re-review, not a person to merge it", async () => {
    env = createFactoryEnv();
    await enable("dark_factory");
    const { id, pr, builder } = await verifying("pending");
    failed(id);
    await env.setStatus(item(id).reviewerSessionId as string, "idle");
    await tick();
    pr.mergeable = "conflicting";
    readAgainSoon(id);
    await tick();
    env.gh.rebase(pr, "rebased-f1", "failure");
    await env.setStatus(builder, "idle");
    await tick();
    expect(item(id).note ?? "").not.toMatch(/waiting for a person to merge/);
  });
});

describe("Retry with an open PR", () => {
  it("skips the first step and keeps the same PR", async () => {
    env = createFactoryEnv();
    await enable("dark_factory");
    const { id, pr } = await verifying();
    review(id, CHANGES);
    failed(id);
    await env.setStatus(item(id).reviewerSessionId as string, "idle");

    const retried = env.factory.retry(env.project.id, id);
    // Straight back to the PR: no reproduce or analyze, no second PR.
    expect(retried).toMatchObject({ stage: "verifying", pr: { number: pr.ref.number } });
    expect(Object.keys(retried.nudges).filter((k) => k.startsWith("supersede_"))).toEqual([]);
    const starts = env.starts.length;
    await tick();
    expect(item(id).pr?.number).toBe(pr.ref.number);
    const brief = env.starts
      .slice(starts)
      .map((s) => s.input?.text ?? "")
      .join("\n");
    expect(brief).not.toMatch(/\*\*(Reproduce|Analyze)\*\*/);
    expect(env.gh.closed).toEqual([]);
  });

  it("won't re-review without an open PR, and rebuilds by default then", async () => {
    env = createFactoryEnv();
    await enable("dark_factory");
    const { id, pr } = await verifying();
    failed(id);
    pr.ref = { ...pr.ref, state: "closed" };
    env.factory.data.updateItem(id, (i) => ({ ...i, pr: pr.ref }));
    expect(() => env.factory.retry(env.project.id, id, "rereview")).toThrow(/no open pull request/);
    expect(env.factory.retry(env.project.id, id)).toMatchObject({ stage: "backlog", pr: null });
  });
});

describe("factory_retry_item and trust", () => {
  const services = (humanLed: boolean) =>
    ({
      orchestration: { loops: { humanLed: () => humanLed } },
      factory: { isUnattended: () => true },
    }) as unknown as Parameters<typeof assertMayRetry>[0];
  const caller = { caller: "mcp" as const, sessionId: "pm" };

  it("lets the PM retry trusted work on its own, and work from an untrusted author only at the user's request", () => {
    expect(() => assertMayRetry(services(false), caller, { trust: "trusted" })).not.toThrow();
    expect(() => assertMayRetry(services(false), caller, { trust: "admitted" })).toThrow(
      /Not retried: .*author isn't trusted/,
    );
    expect(() => assertMayRetry(services(true), caller, { trust: "admitted" })).not.toThrow();
  });
});

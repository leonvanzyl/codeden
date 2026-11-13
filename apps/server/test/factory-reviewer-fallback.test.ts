import { agentEventToNewEvent, type FactoryTuningPatch } from "@codeden/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { createFactoryEnv, type FactoryEnv } from "./support/factory-env";
import { APPROVE, factorySteps } from "./support/factory-steps";

// Issues #200 and #201: reviews ran on a provider at its usage limit (or not signed in) and
// failed the work; the reviewer's provider and model weren't configurable.

let env: FactoryEnv;
afterEach(() => env?.close());
const { item, tick, later, enable, backlogItem, openPr, review } = factorySteps(() => env);

const HOUR = 60 * 60_000;
const inHours = (h: number) => new Date(env.now().getTime() + h * HOUR).toISOString();
/** A provider at its weekly limit until `resetsAt`. */
const limited = (provider: string, resetsAt: string) => ({
  provider,
  status: "limited" as const,
  resetsAt,
  observedAt: env.now().toISOString(),
});

/** A feature whose builder started; `before` runs before its PR is opened and verified. */
async function build(tuning: FactoryTuningPatch = {}, before: () => void = () => {}) {
  enable("software_factory", { tuning });
  const created = backlogItem();
  await tick();
  expect(item(created.id).stage).toBe("building");
  before();
  await openPr(created.id);
  await tick();
  expect(item(created.id).stage).toBe("verifying");
  return created.id;
}

const reviewerSession = (id: string) => env.repo.get(item(id).reviewerSessionId as string);

describe("factory reviewer availability and fallback", () => {
  it("reviews Claude's work on Claude, with a note, while Codex is at its usage limit", async () => {
    env = createFactoryEnv();
    const id = await build({}, () => env.rateLimits.push(limited("codex", inHours(30))));
    expect(item(id).builderProvider).toBe("claude");
    expect(item(id).reviewerProvider).toBe("claude");
    expect(item(id).reviewerNote).toMatch(
      /^codex is at its usage limit until \w{3} \d{2}:\d{2}; the review ran on the builder's provider/,
    );
    expect(reviewerSession(id).provider).toBe("claude");
  });

  it("skips a Codex that isn't signed in", async () => {
    env = createFactoryEnv();
    env.detected.codex = { loggedIn: false };
    const id = await build();
    expect(env.detections).toBeGreaterThan(0);
    expect(item(id).reviewerProvider).toBe("claude");
    expect(item(id).reviewerNote).toMatch(/^codex is not signed in; /);
  });

  it("restarts a reviewer that hit its usage limit on Claude, without failing the item", async () => {
    env = createFactoryEnv();
    const id = await build();
    const first = item(id).reviewerSessionId as string;
    expect(item(id).reviewerProvider).toBe("codex");
    // The Codex reviewer's turn fails on the weekly limit.
    const T = "t-review";
    env.store.append(
      [
        { type: "thread.started", thread: { id: T } } as const,
        { type: "turn.started", threadId: T, turnId: "u1" } as const,
        {
          type: "turn.failed",
          threadId: T,
          turnId: "u1",
          error: { message: "Usage limit", kind: "usage_limit", retryAt: inHours(30) },
        } as const,
      ].map((e) => agentEventToNewEvent(first, e)),
    );
    await tick();
    expect(env.stopped).toContain(first);
    expect(item(id).note).toMatch(/codex is at its usage limit/);
    await tick();
    const current = item(id);
    expect(current.stage).toBe("verifying");
    expect(current.reviewerSessionId).not.toBe(first);
    expect(current.reviewerProvider).toBe("claude");
    expect(current.reviewerNote).toMatch(/codex is (at its usage limit|failing to run reviews)/);
    // Neither a revise round nor the reviewer's restarts were used.
    expect(current.attempts).toBe(0);
    expect(current.nudges.reviewer_failed_1).toBeUndefined();
    expect(current.nudges.reviewer_restarted).toBeUndefined();
    // Its verdict counts like any other.
    await review(id, APPROVE);
    await tick();
    expect(item(id).review?.verdict).toBe("approve");
    expect(item(id).stage).not.toBe("failed");
  });

  it("uses the configured reviewer provider and model, and the builder's model", async () => {
    env = createFactoryEnv();
    const id = await build({
      builderProvider: "codex",
      builderModel: "gpt-5.5",
      reviewerProvider: "codex",
      reviewerModel: "gpt-5.5-mini",
    });
    const builderStart = env.starts.find((s) => s.workKey === "issue:3");
    expect(builderStart).toMatchObject({ provider: "codex", model: "gpt-5.5" });
    const reviewer = env.starts.at(-1);
    expect(reviewer?.workKey).toMatch(/^factory:review:/);
    expect(reviewer).toMatchObject({ provider: "codex", model: "gpt-5.5-mini" });
    expect(item(id).reviewerNote).toBeNull();
  });

  it("waits while no review provider is available, then reviews after the reset", async () => {
    env = createFactoryEnv();
    const resets = inHours(5);
    const id = await build({ reviewerFallback: "wait" }, () => {
      env.rateLimits.push(limited("codex", resets), limited("claude", inHours(8)));
    });
    expect(item(id).reviewerSessionId).toBeNull();
    expect(item(id).note).toMatch(
      /^Waiting: no review provider available until \w{3} \d{2}:\d{2}$/,
    );
    later(6 * HOUR);
    await tick();
    expect(item(id).reviewerProvider).toBe("codex");
    expect(item(id).stage).toBe("verifying");
  });
});

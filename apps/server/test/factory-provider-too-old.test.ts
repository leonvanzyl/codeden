import type { ProviderStatus, RunnerEventMessage } from "@codeden/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { ingestRunnerEvent } from "../src/events/ingest";
import { ProviderAvailability } from "../src/services/factory/availability";
import type { RunnerPort } from "../src/services/runner-port";
import { createFactoryEnv, type FactoryEnv } from "./support/factory-env";
import { factorySteps } from "./support/factory-steps";

// Issue #269: a provider whose CLI is older than the oldest CodeDen supports (Gemini CLI 0.36.0,
// needs 0.68.0) counted as available, so builders and the reviewer fallback picked it, and its
// start failure was a generic death that the next review tried again.

let env: FactoryEnv;
afterEach(() => env?.close());
const { item, tick, enable, backlogItem, openPr } = factorySteps(() => env);

const TOO_OLD_MESSAGE =
  "Gemini CLI 0.36.0 is too old (needs 0.68.0+). Update it with `npm install -g @google/gemini-cli@latest`.";

/**
 * What `detectGemini` reports for a copy older than `GEMINI_MIN_VERSION` (it stops before the
 * login). `minVersion` says sessions can't open on it at all.
 */
const TOO_OLD: Partial<ProviderStatus> = {
  installed: true,
  version: "0.36.0",
  loggedIn: null,
  supported: false,
  issues: [
    {
      code: "version_unsupported",
      message: "Gemini CLI 0.36.0 is too old (needs 0.68.0+). Update it.",
      fix: { kind: "upgrade", command: "npm install -g @google/gemini-cli@latest" },
      minVersion: "0.68.0",
    },
  ],
};

/** Let the background detection the first tick started finish. */
const settle = () => new Promise((r) => setImmediate(r));

/**
 * The runner's `session.process` crash for a session the adapter refused to open, with the
 * adapter's classification (`setup`: its CLI is too old).
 */
let seq = 0;
function openFailed(sessionId: string) {
  const msg: RunnerEventMessage = {
    type: "event",
    seq: ++seq,
    ts: new Date().toISOString(),
    event: {
      kind: "session.process",
      sessionId,
      state: "crashed",
      error: { code: "open_failed", message: TOO_OLD_MESSAGE, kind: "setup" },
    },
  };
  ingestRunnerEvent(env.db.db, env.store, "home", msg);
}

describe("ProviderAvailability", () => {
  it("marks a provider whose CLI is too old unavailable", async () => {
    const runner = {
      isConnected: () => true,
      request: async () => ({
        statuses: [
          { providerId: "claude", installed: true, loggedIn: true, supported: true, issues: [] },
          { providerId: "gemini", ...TOO_OLD },
        ],
      }),
    } as unknown as RunnerPort;
    const availability = new ProviderAvailability({ runner, now: () => new Date() });
    availability.refresh();
    await settle();
    expect(availability.unavailable("claude")).toBeNull();
    expect(availability.unavailable("gemini")).toMatchObject({
      reason: expect.stringMatching(/too old/),
    });
  });
});

describe("factory with a provider whose CLI is too old", () => {
  it("doesn't fall back to it for a review", async () => {
    // The issue's run: the chosen reviewer (OpenCode) is signed out, fallback "any provider".
    env = createFactoryEnv({ providers: ["claude", "opencode", "gemini"] });
    env.detected.opencode = { loggedIn: false };
    env.detected.gemini = TOO_OLD;
    enable("software_factory", {
      tuning: { builderProvider: "claude", reviewerProvider: "opencode", reviewerFallback: "any" },
    });
    await tick();
    await settle();
    const created = backlogItem();
    await tick();
    await openPr(created.id);
    await tick();
    expect(item(created.id).stage).toBe("verifying");
    expect(item(created.id).reviewerProvider).not.toBe("gemini");
    expect(env.starts.map((s) => s.provider)).not.toContain("gemini");
  });

  it("doesn't start a builder on it", async () => {
    env = createFactoryEnv({ providers: ["claude", "gemini"] });
    env.detected.gemini = TOO_OLD;
    enable("software_factory", { tuning: { builderProvider: "gemini" } });
    await tick();
    await settle();
    const created = backlogItem();
    await tick();
    expect(item(created.id).stage).toBe("building");
    expect(env.repo.get(item(created.id).builderSessionId as string).provider).not.toBe("gemini");
  });

  it("backs the provider off after a too-old start failure, with no second attempt", async () => {
    // Detection hasn't caught it (it ran before the CLI was downgraded): the adapter refuses at open.
    env = createFactoryEnv({ providers: ["claude", "codex", "gemini"] });
    enable("software_factory", {
      tuning: { builderProvider: "claude", reviewerProvider: "gemini", reviewerFallback: "any" },
    });
    await tick();
    await settle();
    const first = backlogItem("Add a counter", 3);
    await tick();
    await openPr(first.id);
    await tick();
    const failed = item(first.id).reviewerSessionId as string;
    expect(env.repo.get(failed).provider).toBe("gemini");

    // The runner reports the crash; the next tick comes before the launcher's own inbox item.
    openFailed(failed);
    await tick();
    const after = item(first.id);
    expect(after.stage).toBe("verifying");
    expect(after.attempts).toBe(0);
    // A setup failure of the provider, not a dead reviewer.
    expect(after.nudges.reviewer_failed_1).toBeUndefined();
    await tick();
    const replaced = item(first.id);
    expect(replaced.reviewerSessionId).not.toBe(failed);
    expect(replaced.reviewerProvider).not.toBe("gemini");
    expect(replaced.reviewerNote).toMatch(/too old/);

    // Other work skips the provider too: no further attempt (and inbox item) per review.
    const second = backlogItem("Add a timer", 4);
    await tick();
    await openPr(second.id);
    await tick();
    expect(item(second.id).stage).toBe("verifying");
    expect(item(second.id).reviewerProvider).not.toBe("gemini");
    expect(env.starts.filter((s) => s.provider === "gemini")).toHaveLength(1);
  });

  it("keeps new builders off the provider after a too-old start failure", async () => {
    env = createFactoryEnv({ providers: ["claude", "gemini"] });
    enable("software_factory", { tuning: { builderProvider: "gemini" } });
    await tick();
    await settle();
    const first = backlogItem("Add a counter", 3);
    await tick();
    const failed = item(first.id).builderSessionId as string;
    expect(env.repo.get(failed).provider).toBe("gemini");

    openFailed(failed);
    await tick();
    const second = backlogItem("Add a timer", 4);
    await tick();
    const next = item(second.id).builderSessionId as string;
    expect(env.repo.get(next).provider).toBe("claude");
    expect(env.starts.filter((s) => s.provider === "gemini")).toHaveLength(1);
  });
});

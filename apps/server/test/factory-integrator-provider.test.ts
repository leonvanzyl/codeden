import type { FactoryTuningPatch, RunnerEventMessage } from "@codeden/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { ingestRunnerEvent } from "../src/events/ingest";
import { createFactoryEnv, type FactoryEnv } from "./support/factory-env";
import { factorySteps } from "./support/factory-steps";

/**
 * The integrator that takes a factory PR over when its author's session is gone (#540). It was
 * the last factory start that ignored the provider back-offs: it always started on the default
 * provider, so while that one was signed out (or at its usage limit, or too old) a conflicted or
 * CI-less PR sat or its integrator failed while another provider was free. And one whose start
 * never reached its provider stayed the PR's agent after the recovery, so the next conflict or CI
 * kick sent it only a rebase or CI request, never its brief, on the provider that refused it.
 */

let env: FactoryEnv;
afterEach(() => env?.close());
const { item, tick, later, enable, verifying, lastMessageTo } = factorySteps(() => env);

const integratorStarts = () =>
  env.starts.filter((s) => s.workKey?.startsWith("factory:integrate:"));
const providerOf = (sessionId: string | null) => env.repo.get(sessionId as string).provider;

/** Let the background provider detection finish. */
const settle = () => new Promise((r) => setImmediate(r));

/** Detection reports these providers signed out (`false`: signed in again), and is run now. */
async function signedOut(providers: Record<string, boolean>) {
  for (const [id, out] of Object.entries(providers))
    env.detected[id] = out ? { loggedIn: false } : {};
  env.factory.ctx.sessions.recheckProviders();
  await settle();
}

/** The runner's crash for a session the provider refused to open because it is signed out. */
let seq = 0;
function refusedSignedOut(sessionId: string) {
  const msg: RunnerEventMessage = {
    type: "event",
    seq: ++seq,
    ts: new Date().toISOString(),
    event: {
      kind: "session.process",
      sessionId,
      state: "crashed",
      error: { code: "open_failed", message: "Not logged in. Run `claude login`.", kind: "auth" },
    },
  };
  ingestRunnerEvent(env.db.db, env.store, "home", msg);
}

/** A PR in verification whose author's session is gone. */
async function authorGone(checks: "pending" | "none", tuning: FactoryTuningPatch = {}) {
  env = createFactoryEnv({ providers: ["claude", "codex"] });
  await enable("software_factory", { tuning });
  const { id, pr } = await verifying(checks);
  env.factory.data.updateItem(id, (i) => ({ ...i, builderSessionId: "deleted-session" }));
  return { id, pr };
}

/** CI never started on the PR's head and its author is gone: the item fails outside its code. */
async function ciNeverStarted() {
  const { id, pr } = await authorGone("none");
  later(2 * 60_000);
  await tick();
  expect(item(id)).toMatchObject({ stage: "failed", failureKind: "infrastructure" });
  return { id, pr };
}

/**
 * CI never started and an integrator took the PR over (on the default provider, everything
 * available); then the item failed outside its code again with the integrator `fails` first:
 * CI's clock ran out, or (`failedFirst`) the item failed before a verify step saw the integrator
 * again. A refusal the verify step sees first is handled there (#551,
 * `factory-integrator-refused.test.ts`).
 */
async function integratorThenFailure(
  fails: (integrator: string) => Promise<void> | void,
  failedFirst = false,
) {
  const { id, pr } = await ciNeverStarted();
  const reason = item(id).reason;
  await tick();
  const first = item(id).builderSessionId as string;
  expect(integratorStarts()).toHaveLength(1);
  // Every provider is available and the builder's is `auto`: started as it always was.
  expect(integratorStarts()[0]?.provider).toBe("auto");
  expect(providerOf(first)).toBe("claude");
  await fails(first);
  later(2 * 60_000);
  if (failedFirst) {
    env.factory.data.updateItem(id, (i) => ({
      ...i,
      stage: "failed",
      failureKind: "infrastructure",
      reason,
      finishedAt: new Date().toISOString(),
    }));
  } else {
    await tick();
  }
  expect(item(id)).toMatchObject({ stage: "failed", failureKind: "infrastructure" });
  return { id, pr, first };
}

describe("the integrator's provider (#540)", () => {
  it("resolves merge conflicts on an available provider when the default one is signed out", async () => {
    const { id, pr } = await authorGone("pending");
    await signedOut({ claude: true });
    expect(env.factory.providerRunnable("claude").runnable).toBe(false);
    pr.mergeable = "conflicting";
    await tick();

    expect(integratorStarts()).toHaveLength(1);
    const integrator = item(id).builderSessionId as string;
    expect(providerOf(integrator)).toBe("codex");
    expect(item(id).builderProvider).toBe("codex");
    expect(item(id).nudges.rebase_1).toBeDefined();
  });

  it("starts CI again on an available provider when the default one is signed out", async () => {
    const { id } = await ciNeverStarted();
    await signedOut({ claude: true });
    await tick();

    expect(integratorStarts()).toHaveLength(1);
    expect(integratorStarts()[0]?.input?.text).toMatch(/No CI ever started/);
    const integrator = item(id).builderSessionId as string;
    expect(providerOf(integrator)).toBe("codex");
    expect(item(id).builderProvider).toBe("codex");
  });

  it("starts on the builder's provider and model from the factory settings", async () => {
    const tuning = { builderProvider: "codex", builderModel: "gpt-5-codex" } as const;
    const { id, pr } = await authorGone("pending", tuning);
    pr.mergeable = "conflicting";
    await tick();

    expect(integratorStarts()).toHaveLength(1);
    expect(integratorStarts()[0]).toMatchObject({ provider: "codex", model: "gpt-5-codex" });
    expect(item(id).builderProvider).toBe("codex");
  });

  it("waits with the waiting note, starting nothing, while no provider is available", async () => {
    const { id, pr } = await authorGone("pending");
    await signedOut({ claude: true, codex: true });
    pr.mergeable = "conflicting";
    await tick();
    await tick();

    expect(integratorStarts()).toHaveLength(0);
    expect(item(id)).toMatchObject({ stage: "verifying", builderSessionId: "deleted-session" });
    expect(item(id).note).toMatch(/^Waiting: no integration provider available/);
    // Nothing was asked of anyone yet: the conflict's first request is still to come.
    expect(item(id).nudges.rebase_1).toBeUndefined();
    // No repair slot was claimed: nothing waits ahead of new builds.
    expect(env.factory.ctx.slots.ahead(env.project.id, "build")).toBe(0);

    // Codex is signed in again: the integrator starts on it on the next tick.
    await signedOut({ codex: false });
    await tick();
    expect(integratorStarts()).toHaveLength(1);
    expect(providerOf(item(id).builderSessionId)).toBe("codex");
  });
});

describe("an integrator whose start never reached its provider (#540)", () => {
  for (const next of ["ci", "conflicts"] as const) {
    it(`counts as gone: a fresh integrator with its brief takes over the next ${next === "ci" ? "CI kick" : "conflict"} on another provider`, async () => {
      // Claude is signed out: it refuses to open the integrator's session, which never ran a turn.
      const { id, pr, first } = await integratorThenFailure((s) => {
        refusedSignedOut(s);
        expect(env.repo.get(s).status).toBe("failed");
        expect(env.repo.turnCount(s)).toBe(0);
      }, true);
      if (next === "conflicts") pr.mergeable = "conflicting";

      // The recovery lets it go, and the follow-up goes to a fresh integrator with its brief.
      await tick();
      await tick();
      expect(env.messages.filter((m) => m.sessionId === first)).toEqual([]);
      const fresh = item(id).builderSessionId as string;
      expect(fresh).toBeTruthy();
      expect(fresh).not.toBe(first);
      expect(integratorStarts()).toHaveLength(2);
      const brief = integratorStarts()[1]?.input?.text ?? "";
      expect(brief).toMatch(/^\*\*Integrate\*\*/);
      expect(brief).toContain("Counter increments");
      expect(brief).toMatch(next === "ci" ? /No CI ever started/ : /merge conflicts with `main`/);
      expect(providerOf(fresh)).toBe("codex");
      expect(item(id).builderProvider).toBe("codex");

      // The one that never started was an earlier session: cleanup archived it.
      await env.factory.archiver.idle();
      expect(env.archived).toContain(first);
      expect(item(id).earlierSessionIds).not.toContain(first);
    });
  }

  it("keeps an integrator that ran a turn as the PR's agent, and asks it to start CI again", async () => {
    const { id, first } = await integratorThenFailure(async (s) => {
      env.ranTurn(s);
      await env.setStatus(s, "failed");
    });
    await tick();
    await tick();

    expect(item(id)).toMatchObject({ stage: "verifying", builderSessionId: first });
    expect(integratorStarts()).toHaveLength(1);
    expect(lastMessageTo(first)).toMatch(/^\*\*Re-run CI\*\*/);
    expect(item(id).earlierSessionIds).not.toContain(first);
  });
});

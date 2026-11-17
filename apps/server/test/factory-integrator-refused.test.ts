import type { RunnerEventMessage } from "@codeden/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { ingestRunnerEvent } from "../src/events/ingest";
import { CI_KICK_NUDGE, kickCi } from "../src/services/factory/ci-kick";
import { START_ANSWER_GRACE_MS } from "../src/services/factory/late-start";
import { setUnanswered } from "../src/services/sessions/unanswered-start";
import { createFactoryEnv, type FactoryEnv } from "./support/factory-env";
import { factorySteps } from "./support/factory-steps";
import type { FakePr } from "./support/fake-factory-github";

/**
 * An integrator whose start its provider refused while its PR is in verification (#551). Nothing
 * fails the item then, so it stayed the PR's agent: the next conflict tick sent it a bare rebase
 * request (no brief) on the provider that refused it, each counted toward `MAX_REBASE_ASKS`, and
 * the item was rebuilt from the default branch, throwing the PR away. A CI-kick request went out
 * without the `prGone` re-check rebase requests make, and a recovery backed a provider off from
 * an integrator refusal older than a person's sign-in.
 */

let env: FactoryEnv;
afterEach(() => env?.close());
const { item, tick, later, enable, verifying } = factorySteps(() => env);

const integratorStarts = () =>
  env.starts.filter((s) => s.workKey?.startsWith("factory:integrate:"));
const providerOf = (sessionId: string | null) => env.repo.get(sessionId as string).provider;
const messagesTo = (sessionId: string) => env.messages.filter((m) => m.sessionId === sessionId);
const runnable = (provider: string) => env.factory.providerRunnable(provider).runnable;

/** Let the background provider detection finish. */
const settle = () => new Promise((r) => setImmediate(r));
/** A few ms, so a session's `updatedAt` moves past the factory's last request. */
const pause = () => new Promise((r) => setTimeout(r, 5));

/** Detection reports these providers signed out (`false`: signed in again), and is run now. */
async function signedOut(providers: Record<string, boolean>) {
  for (const [id, out] of Object.entries(providers))
    env.detected[id] = out ? { loggedIn: false } : {};
  env.factory.ctx.sessions.recheckProviders();
  await settle();
}

/** The runner's crash for a session the provider refused to open because it is signed out. */
let seq = 0;
async function refusedSignedOut(sessionId: string) {
  await pause();
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
  expect(env.repo.get(sessionId).status).toBe("failed");
  expect(env.repo.turnCount(sessionId)).toBe(0);
}

/** The runner left the session's start unanswered (busy), as the launcher records it. */
async function startUnanswered(sessionId: string) {
  await pause();
  setUnanswered(env.repo, sessionId, { code: "timeout", at: env.now().toISOString() });
  env.repo.update(sessionId, (s) => ({ ...s, status: "failed" }));
}

/** A PR in verification whose author's session is gone. */
async function authorGone(checks: FakePr["checks"], providers = ["claude", "codex"]) {
  env = createFactoryEnv({ providers });
  await enable("software_factory");
  const { id, pr } = await verifying(checks);
  env.factory.data.updateItem(id, (i) => ({ ...i, builderSessionId: "deleted-session" }));
  return { id, pr };
}

/** The item failed outside its code before a verify step saw its integrator again. */
function failedOutsideItsCode(id: string) {
  env.factory.data.updateItem(id, (i) => ({
    ...i,
    stage: "failed",
    failureKind: "infrastructure",
    reason: "The reviewer session failed",
    finishedAt: new Date().toISOString(),
  }));
}

describe("an integrator refused while its PR is in verification (#551)", () => {
  it("gets no bare rebase request: a fresh integrator with its brief takes the conflict over on another provider", async () => {
    const { id, pr } = await authorGone("pending");
    pr.mergeable = "conflicting";
    await tick();
    const first = item(id).builderSessionId as string;
    expect(integratorStarts()).toHaveLength(1);
    expect(providerOf(first)).toBe("claude");

    // Claude is signed out: it refuses to open the integrator, and the item stays in verification.
    await refusedSignedOut(first);
    await tick();
    expect(item(id).stage).toBe("verifying");

    // Not a rebase request on the provider that refused it: a fresh integrator, with its brief.
    expect(messagesTo(first)).toEqual([]);
    expect(integratorStarts()).toHaveLength(2);
    const fresh = item(id).builderSessionId as string;
    expect(fresh).not.toBe(first);
    expect(integratorStarts()[1]?.input?.text).toMatch(/^\*\*Integrate\*\*/);
    expect(providerOf(fresh)).toBe("codex");
    expect(runnable("claude")).toBe(false);
    // The refused start's request didn't count: the fresh one's is still the first.
    expect(item(id).nudges.rebase_1).toBeDefined();
    expect(item(id).nudges.rebase_2).toBeUndefined();
    // The refused one was let go as an earlier session: cleanup archived it.
    await env.factory.archiver.idle();
    expect(env.archived).toContain(first);
    expect(item(id).earlierSessionIds).not.toContain(first);
  });

  it("gets no bare CI-kick request: a fresh integrator with its brief pushes the commit on another provider", async () => {
    // CI never started and its author is gone: it fails, recovers, and an integrator kicks CI.
    const { id } = await authorGone("none");
    later(2 * 60_000);
    await tick();
    expect(item(id)).toMatchObject({ stage: "failed", failureKind: "infrastructure" });
    await tick();
    const first = item(id).builderSessionId as string;
    expect(integratorStarts()).toHaveLength(1);
    expect(providerOf(first)).toBe("claude");

    // Claude refuses it: the kick is owed again, at once, without waiting for CI to time out.
    await refusedSignedOut(first);
    await tick();
    expect(item(id).stage).toBe("verifying");
    expect(messagesTo(first)).toEqual([]);
    expect(integratorStarts()).toHaveLength(2);
    expect(integratorStarts()[1]?.input?.text).toMatch(/No CI ever started/);
    expect(providerOf(item(id).builderSessionId)).toBe("codex");
    expect(runnable("claude")).toBe(false);
  });

  it("isn't rebuilt from the default branch after three refused integrators in a row", async () => {
    const { id, pr } = await authorGone("pending", ["claude", "codex", "gemini"]);
    pr.mergeable = "conflicting";
    // Every provider refuses every session the factory opens or reopens for the PR.
    for (let n = 0; n < 6 && item(id).stage === "verifying"; n++) {
      await tick();
      const agent = item(id).builderSessionId;
      if (agent && agent !== "deleted-session" && env.repo.get(agent).status !== "failed") {
        await refusedSignedOut(agent);
      }
    }

    // Three refused starts, each on the next provider, and none counted as a request to rebase.
    expect(integratorStarts()).toHaveLength(3);
    expect(item(id)).toMatchObject({ stage: "verifying", rebuiltFrom: null });
    expect(item(id).pr?.number).toBe(pr.ref.number);
    expect(item(id).nudges.rebase_1).toBeUndefined();
    // With every provider backed off it waits, starting nothing, until one can take work.
    expect(item(id).note).toMatch(/^Waiting: no integration provider available/);
    // No refused integrator was sent a bare rebase request.
    for (const s of integratorStarts()) expect(s.input?.text).toMatch(/^\*\*Integrate\*\*/);
    const integrators = env.repo
      .list({ projectId: env.project.id, role: "agent" })
      .filter((s) => s.workKey.startsWith("factory:integrate:"));
    for (const s of integrators) expect(messagesTo(s.id)).toEqual([]);
  });

  it("is waited for while the runner may still answer its start, then let go", async () => {
    const { id, pr } = await authorGone("pending");
    pr.mergeable = "conflicting";
    await tick();
    const first = item(id).builderSessionId as string;
    await startUnanswered(first);

    // The runner was busy: it may still open the session, so nothing is sent or started yet.
    await tick();
    expect(item(id).builderSessionId).toBe(first);
    expect(messagesTo(first)).toEqual([]);
    expect(integratorStarts()).toHaveLength(1);
    expect(item(id).note).toMatch(/answer the integrator's start: waiting/);

    // It didn't start within the grace: let go, and a fresh integrator takes over. A busy runner
    // is no failure of the provider: nothing is backed off.
    later(START_ANSWER_GRACE_MS + 1_000);
    await tick();
    expect(messagesTo(first)).toEqual([]);
    expect(integratorStarts()).toHaveLength(2);
    expect(item(id).builderSessionId).not.toBe(first);
    expect(runnable("claude")).toBe(true);
  });
});

describe("a CI-kick request for a PR that merged meanwhile (#551)", () => {
  it("isn't sent", async () => {
    env = createFactoryEnv();
    await enable("software_factory");
    const { id, pr, builder } = await verifying("none");
    env.ranTurn(builder);
    env.factory.data.updateItem(id, (i) => ({
      ...i,
      nudges: { ...i.nudges, [CI_KICK_NUDGE]: new Date().toISOString() },
    }));
    const before = messagesTo(builder).length;
    // The step read the PR open with no CI; then a person merged it on GitHub.
    const read = await env.gh.prDetails(env.project.id, pr.ref.number);
    pr.ref = { ...pr.ref, state: "merged" };
    const ctx = env.factory.ctx;
    const project = ctx.projects.get(env.project.id);
    const loop = ctx.store.loopOrNew(project.id, ctx.now());
    await kickCi(ctx, project, loop, item(id), read);

    expect(messagesTo(builder)).toHaveLength(before);
    expect(item(id).stage).toBe("merged");
  });
});

describe("backing a provider off after an integrator's refused start (#551)", () => {
  it("doesn't, when a person signed in after the refusal", async () => {
    // CI never started on the PR's head and its author is gone: the item fails outside its code.
    const { id } = await authorGone("none");
    later(2 * 60_000);
    await tick();
    expect(item(id)).toMatchObject({ stage: "failed", failureKind: "infrastructure" });
    // The recovery puts it back and an integrator takes the PR over on Claude.
    await tick();
    const first = item(id).builderSessionId as string;
    expect(integratorStarts()).toHaveLength(1);
    expect(providerOf(first)).toBe("claude");

    // Claude refuses to open it (signed out); then a person signs in and asks to check now.
    await refusedSignedOut(first);
    await pause();
    await signedOut({ claude: false });
    expect(runnable("claude")).toBe(true);

    // The factory carries on: that refusal is older than the sign-in, so it holds nothing off.
    later(2 * 60_000);
    await tick();
    await tick();
    expect(runnable("claude")).toBe(true);
  });

  it("doesn't on a recovery from a refusal older than a person's recheck", async () => {
    const { id, pr } = await authorGone("pending");
    pr.mergeable = "conflicting";
    await tick();
    const first = item(id).builderSessionId as string;
    await refusedSignedOut(first);
    await pause();
    await signedOut({ claude: false });
    // The item failed outside its code before a verify step saw the refusal.
    failedOutsideItsCode(id);

    await tick();
    expect(item(id).stage).toBe("verifying");
    expect(runnable("claude")).toBe(true);
    expect(messagesTo(first)).toEqual([]);
    // The recovery let it go, and its refused start's request didn't count.
    const fresh = item(id).builderSessionId as string;
    expect(fresh).not.toBe(first);
    expect(providerOf(fresh)).toBe("claude");
    expect(item(id).nudges.rebase_1).toBeDefined();
    expect(item(id).nudges.rebase_2).toBeUndefined();
  });

  it("backs it off once: the same old refusal doesn't extend the back-off", () => {
    env = createFactoryEnv();
    const sessions = env.factory.ctx.sessions;
    const tooOld = { reason: "too old to run (update it)", until: null };
    const failedAt = env.now().toISOString();
    sessions.providerFailed("claude", tooOld, failedAt);
    const until = env.factory.providerRunnable("claude").until;
    expect(until).toBeTruthy();

    later(10 * 60_000);
    sessions.providerFailed("claude", tooOld, failedAt);
    expect(env.factory.providerRunnable("claude").until).toBe(until);
    // A newer refusal backs it off again from now.
    sessions.providerFailed("claude", tooOld, env.now().toISOString());
    expect(env.factory.providerRunnable("claude").until).not.toBe(until);
  });
});

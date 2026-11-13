import { afterEach, describe, expect, it } from "vitest";
import { MAX_RECOVERIES } from "../src/services/factory/recover";
import { READY_RECHECK_MS } from "../src/services/factory/verify";
import { createFactoryEnv, type FactoryEnv } from "./support/factory-env";
import { APPROVE, factorySteps } from "./support/factory-steps";
import type { FakePr } from "./support/fake-factory-github";

/**
 * Ownership (§10.1): the loop owns every PR the factory opened until it merges or closes,
 * whatever its item's stage. It keeps them free of conflicts (the author rebases, or an
 * integrator when the author's session is gone), rebuilds work whose PR keeps conflicting,
 * puts work that failed for a reason outside its code back by itself, and sends only what is
 * truly stuck to a person.
 */

let env: FactoryEnv;
afterEach(() => env?.close());
const {
  item,
  tick,
  later,
  lastMessageTo,
  enable,
  backlogItem,
  openPr,
  verifying,
  review,
  keepConflicting,
  failed,
  readAgainSoon,
} = factorySteps(() => env);

describe("PRs of failed and escalated items", () => {
  it("rebases a failed item's PR that became conflicting, restoring and re-archiving its builder (dark factory)", async () => {
    env = createFactoryEnv();
    await enable("dark_factory");
    const { id, pr, builder } = await verifying("pending");
    failed(id);
    await env.setStatus(item(id).reviewerSessionId as string, "idle");
    await tick();
    await env.factory.archiver.idle();
    expect(env.repo.get(builder).archivedAt).not.toBeNull();

    // Main moves on; the loop reads the PR again within a few minutes.
    pr.mergeable = "conflicting";
    readAgainSoon(id);
    await tick();
    expect(item(id)).toMatchObject({ stage: "failed", attempts: 0, sessionsArchivedAt: null });
    expect(item(id).nudges.rebase_1).toBeDefined();
    expect(lastMessageTo(builder)).toMatch(/\*\*Rebase\*\*.*merge conflicts with `main`/);
    // The message brought the archived builder back.
    expect(env.repo.get(builder).archivedAt).toBeNull();

    env.gh.rebase(pr, "rebased-f1", "failure");
    await env.setStatus(builder, "idle");
    await tick();
    await env.factory.archiver.idle();
    expect(item(id).nudges.rebase_1).toBeUndefined();
    expect(item(id).note).toMatch(/resolved; waiting for a person/);
    // Done: cleanup archives it again, and the factory never merges it.
    expect(env.repo.get(builder).archivedAt).not.toBeNull();
    expect(env.archived.filter((s) => s === builder)).toHaveLength(2);
    expect(env.gh.merges).toEqual([]);
  });

  it("with auto-merge off, keeps a ready PR free of conflicts and never merges it", async () => {
    env = createFactoryEnv();
    await enable("software_factory", { autoMerge: false });
    const { id, pr, builder } = await verifying();
    review(id);
    await tick();
    expect(env.inbox.find(`inbox:factory-ready:${id}`)?.status).toBe("open");

    pr.mergeable = "conflicting";
    later(READY_RECHECK_MS + 1);
    await tick();
    expect(lastMessageTo(builder)).toMatch(/\*\*Rebase\*\*/);
    expect(item(id).attempts).toBe(0);
    env.gh.rebase(pr, "rebased-r1");
    await env.setStatus(builder, "idle");
    later(READY_RECHECK_MS + 1);
    await tick();
    expect(item(id).stage).toBe("verifying");
    expect(env.gh.merges).toEqual([]);
    expect(env.gh.updates).toEqual([]);

    // A person merges it on GitHub: the item is done and its inbox item closes.
    pr.ref = { ...pr.ref, state: "merged" };
    later(READY_RECHECK_MS + 1);
    await tick();
    expect(item(id)).toMatchObject({ stage: "merged", note: "Merged on GitHub" });
    expect(env.inbox.find(`inbox:factory-ready:${id}`)?.status).not.toBe("open");
  });

  it("finishes failed items whose PR a person closed", async () => {
    env = createFactoryEnv();
    await enable("software_factory", { autoMerge: false });
    const { id, pr } = await verifying("pending");
    failed(id);
    pr.ref = { ...pr.ref, state: "closed" };
    await tick();
    expect(item(id)).toMatchObject({
      stage: "rejected",
      reason: "The pull request was closed on GitHub",
    });
  });
});

describe("rebuilds and integrators", () => {
  it("rebuilds a PR that still conflicts after three requests, closes it once the new PR is open, and is stuck after a second time", async () => {
    env = createFactoryEnv();
    await enable("dark_factory");
    const { id, pr, builder } = await verifying("pending");
    pr.mergeable = "conflicting";
    await tick();
    await keepConflicting(id);
    expect(item(id).rebuiltFrom?.number).toBe(pr.ref.number);
    expect(item(id).investigation?.details).toBe("A counter");
    const rebuilder = item(id).builderSessionId as string;
    expect(rebuilder).not.toBe(builder);
    expect(env.starts.at(-1)?.input?.text).toMatch(
      new RegExp(`\\*\\*Rebuild\\*\\*.*#${pr.ref.number}`),
    );
    expect((await env.factory.status(env.project.id)).pullRequests[0]).toMatchObject({
      pr: { number: pr.ref.number },
      state: "rebuilding",
    });
    // The old PR stays open until the new one is.
    expect(env.gh.closed).toEqual([]);
    // The replaced PR's reviewer ends its turn, so its agent slot is free again: requests to
    // rebase wake an agent and wait for a free one like any other turn (§10.1, Slot priority).
    const oldReviewer = env.repo
      .list({ projectId: env.project.id, role: "agent" })
      .find((s) => s.workKey === `factory:review:${pr.ref.number}`);
    await env.setStatus(oldReviewer?.id as string, "idle");

    const { pr: next } = await openPr(id, "pending");
    await tick();
    expect(item(id)).toMatchObject({ stage: "verifying", pr: { number: next.ref.number } });
    expect(env.gh.closed).toEqual([
      {
        number: pr.ref.number,
        comment: expect.stringContaining(`Superseded by #${next.ref.number}`),
      },
    ]);

    // The rebuilt PR keeps conflicting too: no second rebuild, it goes to the user.
    next.mergeable = "conflicting";
    await tick();
    await keepConflicting(id);
    expect(item(id)).toMatchObject({ stage: "failed", failureKind: "stuck" });
    expect(item(id).reason).toMatch(/already rebuilt/);
    expect(env.inbox.find(`inbox:factory-decision:stuck:${id}`)).toMatchObject({
      status: "open",
      notify: "needs_you",
      priority: "high",
    });
    expect(env.notices.some((n) => n.id === `factory.stuck:${id}`)).toBe(true);
    expect(env.factory.data.loopOrNew(env.project.id).consecutiveFailures).toBe(0);
  });

  it("starts an integrator on the PR's branch when the session that wrote it is gone", async () => {
    env = createFactoryEnv();
    await enable();
    const { id, pr } = await verifying("pending");
    review(id, { ...APPROVE, verdict: "request_changes" });
    env.factory.data.updateItem(id, (i) => ({ ...i, builderSessionId: "deleted-session" }));
    pr.mergeable = "conflicting";
    await tick();
    const start = env.starts.at(-1);
    expect(start).toMatchObject({
      workKey: `factory:integrate:${pr.ref.number}`,
      workspace: {
        mode: "worktree",
        branch: pr.headBranch,
        baseRef: `origin/${pr.headBranch}`,
        fetch: true,
      },
    });
    const brief = start?.input?.text ?? "";
    expect(brief).toMatch(/\*\*Integrate\*\*/);
    expect(brief).toContain("## Test results");
    expect(brief).toContain("**request_changes**");
    expect(item(id).builderSessionId).not.toBe("deleted-session");
    expect(item(id).nudges.rebase_1).toBeDefined();
  });
});

describe("failures outside the work's code", () => {
  it("puts an item back on the next tick once its builder session can run again", async () => {
    env = createFactoryEnv();
    await enable();
    const { id } = backlogItem();
    await tick();
    // The builder dies before it opens a PR (a runner restart, a message racing its turn).
    const builder = item(id).builderSessionId as string;
    await env.setStatus(builder, "failed");
    env.providers = [];
    await tick();
    expect(item(id)).toMatchObject({ stage: "failed", failureKind: "infrastructure" });
    expect(env.factory.data.loopOrNew(env.project.id).consecutiveFailures).toBe(0);
    // The runner offers no provider yet: it waits.
    await tick();
    expect(item(id).stage).toBe("failed");
    env.providers = ["claude", "codex"];
    await tick();
    expect(item(id)).toMatchObject({ stage: "building", reason: null, failureKind: null });
    expect(item(id).nudges.infra_1).toBeDefined();
    expect(lastMessageTo(builder)).toMatch(/\*\*Continue\*\*/);
  });

  it("recovers a legacy failure through the PR found on its builder's branch, at most three times", async () => {
    env = createFactoryEnv();
    await enable();
    const created = (await verifying("success")).id;
    const builder = item(created).builderSessionId as string;
    env.gh.prs.clear();
    // Failed before `failureKind` existed; its PR was opened later from the same branch.
    env.factory.data.updateItem(created, (i) => ({
      ...i,
      stage: "failed",
      pr: null,
      reason: "The builder session failed without a pull request",
      failureKind: null,
    }));
    const pr = env.gh.openPr({ sessionId: null, title: "Add a counter", files: ["src/a.ts"] });
    pr.headBranch = env.repo.get(builder).branch as string;
    await env.setStatus(builder, "idle");
    await tick();
    expect(item(created)).toMatchObject({ stage: "verifying", pr: { number: pr.ref.number } });

    // A fourth infrastructure failure stays failed.
    const at = new Date().toISOString();
    env.factory.data.updateItem(created, (i) => ({
      ...i,
      stage: "failed",
      failureKind: "infrastructure",
      nudges: Object.fromEntries(
        Array.from({ length: MAX_RECOVERIES }, (_, n) => [`infra_${n + 1}`, at]),
      ),
    }));
    await tick();
    expect(item(created).stage).toBe("failed");
  });

  it("CI that never started: stuck when Actions are off, otherwise recovered with a CI kick", async () => {
    env = createFactoryEnv();
    await enable();
    env.gh.actions = false;
    const off = await verifying("none", "Add a counter", 3);
    later(2 * 60_000);
    await tick();
    expect(item(off.id)).toMatchObject({ stage: "failed", failureKind: "stuck", attempts: 0 });
    expect(item(off.id).reason).toMatch(/CI can never run/);
    expect(env.inbox.find(`inbox:factory-stuck:${off.id}`)?.status).toBe("open");
    await tick();
    expect(item(off.id).stage).toBe("failed");
    // Its reviewer is done, which frees the agent slot the CI kick below needs.
    await env.setStatus(item(off.id).reviewerSessionId as string, "idle");

    env.gh.actions = true;
    const on = await verifying("none", "Add a timer", 4);
    later(2 * 60_000);
    await tick();
    expect(item(on.id)).toMatchObject({ stage: "failed", failureKind: "infrastructure" });
    await tick();
    expect(item(on.id).stage).toBe("verifying");
    // Up to date with main: the author pushes an empty commit to start CI.
    expect(lastMessageTo(on.builder)).toMatch(/\*\*Re-run CI\*\*/);
  });

  it("updates a behind PR on GitHub to start CI that never started", async () => {
    env = createFactoryEnv();
    await enable();
    const { id, pr } = await verifying("none");
    env.gh.main.sha = "main-moved";
    later(2 * 60_000);
    await tick();
    await tick();
    expect(item(id).stage).toBe("verifying");
    expect(env.gh.updates).toEqual([
      {
        number: pr.ref.number,
        expectedHeadSha: expect.stringMatching(/^head/) as unknown as string,
      },
    ]);
    expect((pr as FakePr).checks).toBe("pending");
  });
});

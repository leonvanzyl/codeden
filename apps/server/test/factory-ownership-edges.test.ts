import type { ReviewVerdictInit } from "@codeden/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { createFactoryEnv, type FactoryEnv } from "./support/factory-env";
import { APPROVE, factorySteps } from "./support/factory-steps";

/**
 * The edges of PR ownership (§10.1): a replaced PR is closed even when GitHub refuses at first
 * and its replacement already merged; an integrator's new PR is adopted whatever the item's
 * stage; CI is started again when the author's session is gone; a re-check survives a reviewer
 * that is replaced; and a dark factory's stuck decision is resolved once the PR is decided.
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
  prEntry,
} = factorySteps(() => env);

const CHANGES: ReviewVerdictInit = {
  ...APPROVE,
  verdict: "request_changes",
  summary: "The rebase dropped the counter's reset",
};

describe("closing the PRs a newer one replaced", () => {
  it("keeps closing a rebuilt item's old PR after its replacement merged, until GitHub accepts", async () => {
    env = createFactoryEnv();
    await enable();
    const { id, pr } = await verifying("pending");
    pr.mergeable = "conflicting";
    await tick();
    await keepConflicting(id);
    expect(item(id).rebuiltFrom?.number).toBe(pr.ref.number);

    env.gh.closeFailures = 2;
    const { pr: next } = await openPr(id, "success");
    await tick();
    review(id);
    await tick();
    // The replacement merged while GitHub refused to close the old PR, twice.
    expect(item(id).stage).toBe("watching");
    expect(env.gh.prs.get(pr.ref.number)?.ref.state).toBe("open");
    expect(env.gh.closeAttempts).toBe(2);
    expect(await prEntry(pr.ref.number)).toMatchObject({
      itemId: id,
      state: "superseded",
      note: `Superseded by #${next.ref.number}: closing it`,
    });

    await tick();
    expect(env.gh.closed).toEqual([
      {
        number: pr.ref.number,
        comment: expect.stringContaining(`Superseded by #${next.ref.number}`),
      },
    ]);
    expect(await prEntry(pr.ref.number)).toBeUndefined();
    await tick();
    expect(env.gh.closeAttempts).toBe(3);
  });

  it.each(["failed", "escalated"] as const)(
    "adopts the PR an integrator opened for a %s item and closes the old one",
    async (stage) => {
      env = createFactoryEnv();
      await enable();
      const created = backlogItem();
      await tick();
      const builder = item(created.id).builderSessionId as string;
      const files =
        stage === "escalated" ? ["src/auth/login.ts", "test/login.test.ts"] : ["src/a.ts"];
      const pr = env.gh.openPr({
        sessionId: builder,
        title: "Add a counter",
        files,
        checks: "pending",
      });
      await env.setStatus(builder, "idle");
      await tick();
      if (stage === "failed") failed(created.id);
      const id = created.id;
      expect(item(id).stage).toBe(stage);

      // The author's session is gone; main moves on and the PR conflicts (read within minutes).
      env.factory.data.updateItem(id, (i) => ({ ...i, builderSessionId: "deleted-session" }));
      pr.mergeable = "conflicting";
      readAgainSoon(id);
      await tick();
      const integrator = item(id).builderSessionId as string;
      expect(env.starts.at(-1)?.workKey).toBe(`factory:integrate:${pr.ref.number}`);
      expect(item(id).nudges.rebase_1).toBeDefined();

      // The integrator resolved it on a new PR.
      const next = env.gh.openPr({ sessionId: integrator, title: "Add a counter", files });
      await env.setStatus(integrator, "idle");
      await tick();
      expect(item(id)).toMatchObject({ stage, pr: { number: next.ref.number } });
      expect(item(id).nudges.rebase_1).toBeUndefined();
      expect(item(id).nudges.rebase_2).toBeUndefined();
      expect(env.gh.closed).toEqual([
        {
          number: pr.ref.number,
          comment: expect.stringContaining(`Superseded by #${next.ref.number}`),
        },
      ]);
      if (stage === "escalated") {
        expect(env.inbox.find(`inbox:factory-escalated:${id}`)?.pr?.number).toBe(next.ref.number);
      }
      // Still a person's to merge.
      expect(env.gh.merges).toEqual([]);
    },
  );
});

describe("work whose author's session is gone", () => {
  it("starts an integrator to restart CI that never started, waiting for a free agent", async () => {
    env = createFactoryEnv({ limits: { maxConcurrentSessions: 1 } });
    await enable();
    const { id, pr } = await verifying("none");
    const reviewer = item(id).reviewerSessionId as string;
    env.factory.data.updateItem(id, (i) => ({ ...i, builderSessionId: "deleted-session" }));
    later(2 * 60_000);
    await tick();
    expect(item(id)).toMatchObject({ stage: "failed", failureKind: "infrastructure" });

    // Back in verification; the only agent is the reviewer, so the integrator waits, and CI
    // isn't timed out on a head nobody could kick yet.
    await tick();
    expect(item(id)).toMatchObject({ stage: "verifying", builderSessionId: null });
    expect(item(id).note).toMatch(/waiting for a free agent/);
    later(2 * 60_000);
    await tick();
    expect(item(id).stage).toBe("verifying");
    expect(env.starts.some((s) => s.workKey?.startsWith("factory:integrate"))).toBe(false);

    await env.setStatus(reviewer, "idle");
    await tick();
    const start = env.starts.find((s) => s.workKey === `factory:integrate:${pr.ref.number}`);
    expect(start?.workspace).toMatchObject({
      mode: "worktree",
      branch: pr.headBranch,
      baseRef: `origin/${pr.headBranch}`,
      fetch: true,
    });
    expect(start?.input?.text).toMatch(/No CI ever started[\s\S]*empty commit/);
    expect(item(id).builderSessionId).not.toBeNull();
    // While the integrator works on it, CI isn't timed out; then CI runs on its new head.
    later(2 * 60_000);
    await tick();
    expect(item(id).stage).toBe("verifying");
    Object.assign(pr, { headSha: "kicked1", checks: "success" });
    await env.setStatus(item(id).builderSessionId as string, "idle");
    await tick();
    expect(item(id).checks.find((c) => c.name === "ci")?.state).toBe("pass");
    expect(item(id).nudges.infra_2).toBeUndefined();
  });

  it("reviews a PR whose author's session is gone in a fresh worktree of its head", async () => {
    env = createFactoryEnv();
    await enable();
    const { id, pr } = await verifying("pending");
    env.factory.data.updateItem(id, (i) => ({
      ...i,
      builderSessionId: "deleted-session",
      reviewerSessionId: null,
    }));
    await tick();
    expect(env.starts.at(-1)).toMatchObject({
      workKey: `factory:review:${pr.ref.number}`,
      workspace: { mode: "worktree", baseRef: `origin/${pr.headBranch}`, fetch: true },
    });
  });
});

describe("a re-check whose reviewer is replaced", () => {
  it.each([
    ["approve", APPROVE],
    ["request_changes", CHANGES],
  ] as const)("keeps the earlier verdict and the scoped re-check (%s)", async (verdict, sent) => {
    env = createFactoryEnv();
    await enable();
    const { id, pr, builder } = await verifying("pending");
    review(id);
    await tick();
    const first = item(id).reviewerSessionId as string;
    env.repo.update(first, (s) => ({
      ...s,
      status: "stopped",
      archivedAt: new Date().toISOString(),
    }));
    const oldHead = pr.headSha as string;
    pr.mergeable = "conflicting";
    await tick();
    expect(lastMessageTo(builder)).toMatch(/\*\*Rebase\*\*/);
    env.gh.rebase(pr, "rebased1", "success");
    await env.setStatus(builder, "idle");
    await tick();

    // A fresh reviewer re-checks only the resolution, told what was approved.
    const fresh = item(id).reviewerSessionId as string;
    expect(fresh).not.toBe(first);
    const brief = env.starts.at(-1)?.input?.text ?? "";
    expect(brief).toContain(`git range-diff ${oldHead}...rebased1`);
    expect(brief).toContain(APPROVE.summary);
    expect(item(id).review?.summary).toBe(APPROVE.summary);
    expect(item(id).checks.find((c) => c.name === "review")?.state).toBe("pending");
    expect(env.gh.merges).toEqual([]);

    review(id, verdict === "approve" ? { ...APPROVE, summary: "Resolution is right" } : sent);
    await tick();
    if (verdict === "approve") {
      expect(item(id).review?.summary).toBe(APPROVE.summary);
      expect(env.gh.merges.map((m) => m.number)).toEqual([pr.ref.number]);
    } else {
      expect(item(id)).toMatchObject({ stage: "building", attempts: 1 });
      expect(lastMessageTo(builder)).toContain(CHANGES.summary);
    }
  });
});

describe("a dark factory's stuck decisions", () => {
  it.each(["closed", "merged"] as const)(
    "are resolved, and kept on record, once the PR is %s",
    async (state) => {
      env = createFactoryEnv();
      await enable("dark_factory");
      env.gh.actions = false;
      const { id, pr } = await verifying("none");
      later(2 * 60_000);
      await tick();
      expect(item(id).failureKind).toBe("stuck");
      const decision = `inbox:factory-decision:stuck:${id}`;
      expect(env.inbox.find(decision)).toMatchObject({ status: "open", notify: "needs_you" });

      pr.ref = { ...pr.ref, state };
      await tick();
      expect(item(id).stage).toBe(state === "merged" ? "merged" : "rejected");
      const after = env.inbox.find(decision);
      expect(after).toBeDefined();
      expect(after?.status).not.toBe("open");
    },
  );
});

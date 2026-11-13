import { existsSync } from "node:fs";
import type { FactoryItem, ReviewVerdictInit } from "@codeden/contracts";
import { ReviewVerdict } from "@codeden/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { trackHead } from "../src/services/factory/rebase";
import { createFactoryEnv, type FactoryEnv } from "./support/factory-env";
import type { FakePr } from "./support/fake-factory-github";

/**
 * A factory PR that stops getting CI: GitHub runs no `pull_request` workflows on a PR with
 * merge conflicts, and a new head needs a moment before its checks register. Neither may fail
 * the item; a conflict is the builder's to resolve.
 */

const APPROVE: ReviewVerdictInit = {
  verdict: "approve",
  summary: "Meets the criteria",
  criteria: [{ criterion: "Counter increments", met: true }],
  vision: { aligned: true },
  tests: { adequate: true },
  security: { concerns: [] },
};

const CHANGES: ReviewVerdictInit = {
  ...APPROVE,
  verdict: "request_changes",
  summary: "Windows sort.exe /O can still write in plan mode",
  security: { concerns: ["sort.exe /O writes files"] },
};

let env: FactoryEnv;
afterEach(() => env?.close());

const enable = () =>
  env.factory.setMode(env.project.id, {
    mode: "software_factory",
    limits: { ...env.project.factoryLimits, autoMerge: true },
  } as Parameters<FactoryEnv["factory"]["setMode"]>[1]);

/** An audit command, required before a merge (run in the builder's worktree). */
const requireAudit = () =>
  env.factory.setMode(env.project.id, {
    mode: "software_factory",
    tuning: { auditCommand: "node --version" },
  });

/** How items failed for missing CI before the factory rebased conflicting PRs. */
const LEGACY_NO_CI = "ci: No CI reported on the head commit; CI is required for automatic merges";

const tick = () => env.factory.tick(env.project.id);
const item = (id: string) => env.factory.data.item(id) as FactoryItem;
const later = (ms: number) => {
  env.clock.offsetMs += ms;
};
const conflicting = (pr: FakePr) => {
  pr.mergeable = "conflicting";
};
const lastMessageTo = (sessionId: string) =>
  env.messages.filter((m) => m.sessionId === sessionId).at(-1)?.text ?? "";

function review(id: string, verdict: ReviewVerdictInit = APPROVE) {
  const session = env.repo.get(item(id).reviewerSessionId as string);
  return env.factory.submitReview(session, ReviewVerdict.parse(verdict));
}

/** A feature built until its PR is in verification. */
async function verifying(checks: FakePr["checks"] = "none") {
  const created = env.factory.data.createItem({
    projectId: env.project.id,
    workKey: "issue:3",
    title: "Add a counter",
    summary: "Users want to count things",
    source: "discovery",
    stage: "backlog",
    type: "feature",
    investigation: {
      kind: "analysis",
      outcome: "implement",
      summary: "Missing",
      details: "A counter",
      testPath: null,
      at: new Date().toISOString(),
    },
    score: 0.5,
    acceptanceCriteria: ["Counter increments"],
    issue: { number: 3, url: "https://github.com/acme/app/issues/3", title: "Add a counter" },
  });
  await tick();
  const builder = item(created.id).builderSessionId as string;
  const pr = env.gh.openPr({
    sessionId: builder,
    title: created.title,
    files: ["src/counter.ts", "test/counter.test.ts"],
    checks,
  });
  await env.setStatus(builder, "idle");
  await tick();
  expect(item(created.id).stage).toBe("verifying");
  return { id: created.id, pr, builder };
}

describe("the CI clock and rebase requests", () => {
  it("times CI from when a head first appeared and ends rebase requests once mergeable", () => {
    const t1 = "2026-11-11T10:00:00.000Z";
    const t2 = "2026-11-11T10:05:00.000Z";
    const first = trackHead({ verifying: t1 }, { headSha: "aaa", mergeable: "unknown" }, t1);
    expect(first).toEqual({ since: t1, nudges: { verifying: t1, head_aaa: t1 } });
    // Same head later: the clock keeps its start, and nothing changes.
    expect(trackHead(first.nudges, { headSha: "aaa", mergeable: "unknown" }, t2)).toEqual(first);
    // A new head restarts it; the conflict's rebase requests stay until it is mergeable.
    const asked = { ...first.nudges, rebase_1: t1 };
    const pushed = trackHead(asked, { headSha: "bbb", mergeable: "unknown" }, t2);
    expect(pushed).toEqual({ since: t2, nudges: { verifying: t1, rebase_1: t1, head_bbb: t2 } });
    expect(trackHead(asked, { headSha: "bbb", mergeable: "conflicting" }, t2).nudges.rebase_1).toBe(
      t1,
    );
    expect(trackHead(pushed.nudges, { headSha: "bbb", mergeable: "mergeable" }, t2).nudges).toEqual(
      { verifying: t1, head_bbb: t2 },
    );
  });
});

describe("factory PRs without CI (merge conflicts, a new head)", () => {
  it("sends a conflicting PR back to its builder to rebase, without spending a revise round", async () => {
    env = createFactoryEnv();
    enable();
    const { id, pr, builder } = await verifying();
    conflicting(pr);
    later(2 * 60_000);
    await tick();
    expect(item(id)).toMatchObject({ stage: "verifying", attempts: 0 });
    expect(item(id).note).toMatch(/rebasing/);
    expect(lastMessageTo(builder)).toMatch(/rebase/i);

    // The builder rebases: a new head without conflicts, CI passes, the review approves.
    Object.assign(pr, { headSha: "rebased1", mergeable: "mergeable", checks: "success" });
    await env.setStatus(builder, "idle");
    await tick();
    review(id);
    await tick();
    expect(item(id).stage).toBe("watching");
    expect(env.gh.merges.map((m) => m.number)).toEqual([pr.ref.number]);
  });

  it("never fails a conflicting PR for missing CI, even with its revise rounds used up", async () => {
    env = createFactoryEnv();
    enable();
    const { id, pr, builder } = await verifying();
    env.factory.data.updateItem(id, (i) => ({ ...i, attempts: 2 }));
    conflicting(pr);
    later(2 * 60_000);
    await tick();
    expect(item(id).reason ?? "").not.toMatch(/No CI reported/);
    expect(item(id).stage).not.toBe("failed");
    expect(lastMessageTo(builder)).toMatch(/rebase/i);
  });

  it("waits for CI on a new head instead of failing at once, then fails with a clear reason", async () => {
    env = createFactoryEnv();
    enable();
    const { id, pr } = await verifying("pending");
    later(2 * 60_000);
    await tick();
    expect(item(id).stage).toBe("verifying");
    // The builder pushes again; GitHub hasn't registered CI on the new head yet.
    Object.assign(pr, { headSha: "pushed22", checks: "none" });
    await tick();
    expect(item(id).stage).toBe("verifying");
    expect(item(id).checks.find((c) => c.name === "ci")?.state).toBe("pending");
    // CI never starts.
    later(60 * 60_000);
    await tick();
    expect(item(id).stage).toBe("failed");
    expect(item(id).reason).toMatch(/CI never started on pushed2/);
    expect(item(id).reason).toMatch(/Actions/);
    // No revise round: an agent can't turn CI on.
    expect(item(id).attempts).toBe(0);
    // The reviewer's verdict, arriving after that, is still kept on the item.
    expect(review(id, CHANGES).recorded).toBe(true);
    expect(item(id).review?.summary).toBe(CHANGES.summary);
  });

  it("asks again while the conflicts remain, and rebuilds the work after three asks", async () => {
    env = createFactoryEnv();
    enable();
    const { id, pr, builder } = await verifying();
    conflicting(pr);
    await tick();
    expect(item(id).nudges.rebase_1).toBeDefined();
    // Still the builder's turn: no second request.
    await tick();
    expect(item(id).nudges.rebase_2).toBeUndefined();
    for (const n of [2, 3]) {
      await env.setStatus(builder, "idle");
      await tick();
      expect(item(id).nudges[`rebase_${n}`]).toBeDefined();
      expect(lastMessageTo(builder)).toMatch(new RegExp(`request ${n}`));
    }
    await env.setStatus(builder, "idle");
    await tick();
    // Not failed: the same item is redone from main by a fresh builder.
    expect(item(id).stage).not.toBe("failed");
    expect(item(id).rebuiltFrom?.number).toBe(pr.ref.number);
    expect(item(id).builderSessionId).not.toBe(builder);
    expect(env.gh.comments.at(-1)?.body).toMatch(/still had merge conflicts with main after 3/);
  });

  it("keeps a review verdict that arrives while the item is being revised", async () => {
    env = createFactoryEnv();
    enable();
    const { id, pr, builder } = await verifying("pending");
    expect(item(id).reviewerSessionId).not.toBeNull();
    // CI fails while the reviewer is still looking: a revise round starts.
    Object.assign(pr, { checks: "failure", failedChecks: ["test"] });
    await tick();
    expect(item(id)).toMatchObject({ stage: "building", attempts: 1 });
    const res = review(id, CHANGES);
    expect(res.recorded).toBe(true);
    await tick();
    expect(lastMessageTo(builder)).toMatch(/sort\.exe \/O/);
  });

  it("recovers an item that failed with 'No CI reported' while its PR was conflicting", async () => {
    env = createFactoryEnv();
    enable();
    const { id, pr, builder } = await verifying();
    conflicting(pr);
    env.factory.data.updateItem(id, (i) => ({
      ...i,
      stage: "failed",
      reason: LEGACY_NO_CI,
      finishedAt: new Date().toISOString(),
    }));
    await tick();
    expect(item(id).stage).not.toBe("failed");
    expect(item(id).reason).toBeNull();
    expect(lastMessageTo(builder)).toMatch(/rebase/i);
  });

  it("recovers an item whose builder was archived: the rebase request restores it before the audit runs", async () => {
    env = createFactoryEnv();
    enable();
    const { id, pr, builder } = await verifying();
    // It failed for missing CI with its revise rounds used up, and cleanup archived its builder
    // (removing the worktree). The audit is required, and none has run on this head yet (as
    // after a restart).
    const at = new Date().toISOString();
    env.factory.data.updateItem(id, (i) => ({
      ...i,
      stage: "failed",
      attempts: 2,
      reason: LEGACY_NO_CI,
      finishedAt: at,
      sessionsArchivedAt: at,
    }));
    env.factory.archiver.push([builder]);
    await env.factory.archiver.idle();
    const worktree = env.repo.get(builder).worktreePath as string;
    expect(existsSync(worktree)).toBe(false);
    requireAudit();
    conflicting(pr);

    await tick();
    expect(item(id)).toMatchObject({ stage: "verifying", reason: null });
    expect(env.messages.filter((m) => m.sessionId === builder)).toHaveLength(1);
    expect(lastMessageTo(builder)).toMatch(/\*\*Rebase\*\*.*has merge conflicts with `main`/);
    // The request brought the builder and its worktree back; nothing ran in a missing directory.
    expect(env.repo.get(builder)).toMatchObject({ archivedAt: null, worktreeRemovedAt: null });
    expect(existsSync(worktree)).toBe(true);
    expect(env.execs).toEqual([]);
    expect(item(id).checks.find((c) => c.name === "security")?.state).toBe("pending");

    // The builder rebases and pushes: the audit runs in its restored worktree, then the merge.
    Object.assign(pr, { headSha: "rebased3", mergeable: "mergeable", checks: "success" });
    await env.setStatus(builder, "idle");
    await tick();
    expect(env.execs).toEqual([{ command: "node", args: ["--version"], cwd: worktree }]);
    review(id);
    await tick();
    expect(item(id).checks.find((c) => c.name === "security")?.detail).toMatch(/Audit clean/);
    expect(item(id).stage).toBe("watching");
  });

  it("brings a cleaned-up builder worktree back for the audit instead of running it where it was", async () => {
    env = createFactoryEnv();
    enable();
    const { id, builder } = await verifying("success");
    env.factory.archiver.push([builder]);
    await env.factory.archiver.idle();
    const worktree = env.repo.get(builder).worktreePath as string;
    requireAudit();

    await tick();
    expect(env.execs).toEqual([]);
    expect(item(id).stage).toBe("verifying");
    expect(lastMessageTo(builder)).toMatch(/worktree had been cleaned up/);
    expect(existsSync(worktree)).toBe(true);
    // Once the builder's turn is over, the audit runs in the restored worktree.
    await env.setStatus(builder, "idle");
    await tick();
    expect(env.execs).toEqual([{ command: "node", args: ["--version"], cwd: worktree }]);
    expect(item(id).stage).toBe("verifying");
  });
});

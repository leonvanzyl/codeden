import { rmSync } from "node:fs";
import { join } from "node:path";
import type { FactoryItem, ReviewVerdictInit } from "@codeden/contracts";
import { ReviewVerdict } from "@codeden/contracts";
import { afterEach, describe, expect, it } from "vitest";
import type { ServiceError } from "../src/services/errors";
import { createFactoryEnv, type FactoryEnv } from "./support/factory-env";

const APPROVE: ReviewVerdictInit = {
  verdict: "approve",
  summary: "Meets the criteria",
  criteria: [{ criterion: "Counter increments", met: true }],
  vision: { aligned: true },
  tests: { adequate: true },
  security: { concerns: [] },
};

let env: FactoryEnv;
afterEach(() => env?.close());

/** The software factory (auto-merge on unless said otherwise), or the dark factory. */
const enable = (
  mode: "software_factory" | "dark_factory" = "software_factory",
  limits: object = {},
) =>
  env.factory.setMode(env.project.id, {
    mode,
    limits: { ...env.project.factoryLimits, autoMerge: true, ...limits },
  } as Parameters<FactoryEnv["factory"]["setMode"]>[1]);

const tick = () => env.factory.tick(env.project.id);
const items = (stage?: FactoryItem["stage"]) =>
  env.factory.data.items(env.project.id, stage ? [stage] : undefined);
const item = (id: string) => env.factory.data.item(id) as FactoryItem;

/** A classified feature, already analyzed, waiting for an agent. */
function backlogItem(title = "Add a counter", score = 0.5): FactoryItem {
  return env.factory.data.createItem({
    projectId: env.project.id,
    workKey: `issue:${Math.floor(Math.random() * 1000) + 1}`,
    title,
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
    score,
    acceptanceCriteria: ["Counter increments"],
    issue: { number: 3, url: "https://github.com/acme/app/issues/3", title },
  });
}

/** Build an item until its PR is in verification. */
async function toVerifying(it: FactoryItem, files = ["src/counter.ts", "test/counter.test.ts"]) {
  await tick();
  const building = item(it.id);
  expect(building.stage).toBe("building");
  const sessionId = building.builderSessionId as string;
  env.gh.openPr({ sessionId, title: it.title, files });
  await env.setStatus(sessionId, "idle");
  await tick();
  return item(it.id);
}

function review(it: FactoryItem, verdict: ReviewVerdictInit = APPROVE) {
  const current = item(it.id);
  const session = env.repo.get(current.reviewerSessionId as string);
  return env.factory.submitReview(session, ReviewVerdict.parse(verdict));
}

describe("factory modes and vision", () => {
  it("needs a vision, limits with a budget and a GitHub project for the software factory", async () => {
    env = createFactoryEnv();
    const fail = (fn: () => unknown) => {
      try {
        fn();
      } catch (error) {
        return (error as ServiceError).code;
      }
      return "ok";
    };
    expect(fail(() => env.factory.setMode(env.project.id, { mode: "software_factory" }))).toBe(
      "limits_required",
    );
    expect(
      fail(() =>
        env.factory.setMode(env.project.id, {
          mode: "software_factory",
          limits: { ...env.project.factoryLimits, dailyBudget: {} },
        }),
      ),
    ).toBe("budget_required");
    rmSync(join(env.project.path, ".codeden", "VISION.md"));
    expect(fail(() => enable())).toBe("vision_required");
    expect(env.factory.vision(env.project.id)).toMatchObject({ exists: false });
    const text = "# Vision\n\n## Goals\n- Count things\n";
    const saved = await env.factory.putVision(env.project.id, text);
    // Saved locally and committed through the vision PR; saving it unchanged adds no commit.
    expect(saved).toMatchObject({ exists: true, pr: { number: 900 }, shareError: null });
    expect(env.gh.visionCommits).toEqual([{ path: ".codeden/VISION.md", contents: text }]);
    await env.factory.putVision(env.project.id, text);
    expect(env.gh.visionCommits).toHaveLength(1);
    const res = enable("dark_factory");
    expect(res).toMatchObject({ mode: "dark_factory", experimental: true });
    expect(await env.factory.status(env.project.id)).toMatchObject({
      mode: "dark_factory",
      experimental: true,
      visionExists: true,
    });
    env.gh.githubProjects.clear();
    expect(fail(() => enable("software_factory"))).toBe("not_a_github_project");
    expect(env.factory.setMode(env.project.id, { mode: "assisted" }).experimental).toBe(false);
  });
});

describe("factory loop state machine (§10.1)", () => {
  it("respects maxMergesPerDay and maxConcurrentSessions when starting builders", async () => {
    env = createFactoryEnv();
    enable("software_factory", { maxMergesPerDay: 1 });
    const a = backlogItem("First", 0.9);
    const b = backlogItem("Second", 0.1);
    await tick();
    expect(item(a.id).stage).toBe("building");
    expect(item(b.id).stage).toBe("backlog");
    expect(env.starts).toHaveLength(1);
    env.updateProject({
      factoryLimits: { ...env.project.factoryLimits, maxMergesPerDay: 5, maxConcurrentSessions: 1 },
    });
    await tick();
    expect(item(b.id).stage).toBe("backlog");
    await env.setStatus(item(a.id).builderSessionId as string, "waiting");
    await tick();
    expect(env.starts).toHaveLength(1);
  });

  it("pauses on the daily budget and resumes the next day", async () => {
    env = createFactoryEnv();
    enable();
    env.spend = { usd: 10, tokens: 0 };
    backlogItem();
    await tick();
    expect(env.starts).toHaveLength(0);
    const loop = env.factory.data.loopOrNew(env.project.id);
    expect(loop.state).toBe("paused");
    expect(loop.pausedReason).toMatch(/daily budget/);
    env.spend = { usd: 0, tokens: 0 };
    env.clock.offsetMs = 24 * 3_600_000;
    await tick();
    expect(env.factory.data.loopOrNew(env.project.id).state).toBe("building");
    // The day that ended got its digest.
    expect(env.factory.data.digests(env.project.id)).toHaveLength(1);
  });

  it("counts factory sessions against the budget by default, or the whole project", async () => {
    env = createFactoryEnv();
    enable();
    const it1 = backlogItem();
    await tick();
    const builder = item(it1.id).builderSessionId as string;
    env.spendFilters = [];
    await tick();
    expect(env.spendFilters.at(-1)).toContain(builder);
    env.factory.setMode(env.project.id, {
      mode: "software_factory",
      limits: { ...(await env.factory.status(env.project.id)).limits, budgetScope: "project" },
    });
    env.spendFilters = [];
    await tick();
    expect(env.spendFilters.at(-1)).toBeNull();
  });

  it("pauses after consecutive failed merge checks", async () => {
    env = createFactoryEnv({ limits: { pauseAfterConsecutiveFailures: 1 } });
    enable();
    env.factory.setMode(env.project.id, {
      mode: "software_factory",
      tuning: { maxFixAttempts: 0 },
    });
    const it1 = backlogItem();
    await tick();
    const sessionId = item(it1.id).builderSessionId as string;
    env.gh.openPr({
      sessionId,
      title: it1.title,
      files: ["src/a.ts", "test/a.test.ts"],
      checks: "failure",
    });
    await env.setStatus(sessionId, "idle");
    await tick();
    await tick();
    expect(item(it1.id).stage).toBe("failed");
    expect(item(it1.id).reason).toMatch(/ci: CI failed/);
    const loop = env.factory.data.loopOrNew(env.project.id);
    expect(loop.state).toBe("paused");
    expect(env.inbox.find(`inbox:factory-paused:${env.project.id}`)?.status).toBe("open");
    backlogItem("Another");
    await tick();
    expect(env.starts).toHaveLength(1);
    env.factory.resume(env.project.id);
    await tick();
    expect(env.starts).toHaveLength(2);
  });

  it("asks the builder for one fix round before failing", async () => {
    env = createFactoryEnv();
    enable();
    const it1 = backlogItem();
    await tick();
    const sessionId = item(it1.id).builderSessionId as string;
    const pr = env.gh.openPr({
      sessionId,
      title: it1.title,
      files: ["src/a.ts", "test/a.test.ts"],
      checks: "failure",
    });
    await env.setStatus(sessionId, "idle");
    await tick();
    await tick();
    expect(item(it1.id)).toMatchObject({ stage: "building", attempts: 1 });
    expect(env.messages.at(-1)?.text).toMatch(/checks for your pull request/);
    pr.checks = "success";
    pr.failedChecks = [];
    await env.setStatus(sessionId, "idle");
    await tick();
    expect(item(it1.id).stage).toBe("verifying");
    review(item(it1.id));
    await tick();
    expect(item(it1.id).stage).toBe("watching");
  });

  it("escalates protected paths to the inbox and never merges them", async () => {
    env = createFactoryEnv();
    enable();
    const it1 = backlogItem();
    const verifying = await toVerifying(it1, ["src/auth/login.ts", "test/login.test.ts"]);
    expect(verifying.stage).toBe("escalated");
    expect(verifying.reason).toMatch(/protected areas/);
    expect(verifying.reviewerSessionId).toBeNull();
    expect(env.gh.merges).toHaveLength(0);
    const inboxItem = env.inbox.find(`inbox:factory-escalated:${it1.id}`);
    expect(inboxItem).toMatchObject({ kind: "pr_review", status: "open" });
    // Escalation is not a failure.
    expect(env.factory.data.loopOrNew(env.project.id).consecutiveFailures).toBe(0);
    // Once a person merges it on GitHub, it is done.
    const pr = env.gh.prs.get(verifying.pr?.number ?? 0);
    if (pr) pr.ref = { ...pr.ref, state: "merged" };
    await tick();
    expect(item(it1.id)).toMatchObject({ stage: "merged", note: "Merged on GitHub" });
  });

  it("falls back to the author's provider for the review when it is the only one", async () => {
    env = createFactoryEnv({ providers: ["claude"] });
    enable();
    const verifying = await toVerifying(backlogItem());
    expect(verifying.reviewerProvider).toBe("claude");
    expect(verifying.reviewerNote).toMatch(/same provider/);
  });

  it("stops the loop and every factory session with the project and global kill switches", async () => {
    env = createFactoryEnv();
    enable();
    const it1 = backlogItem();
    await tick();
    const builder = item(it1.id).builderSessionId as string;
    const res = await env.factory.setKillSwitch(env.project.id, true);
    expect(res.stoppedSessions).toEqual([builder]);
    expect(env.repo.get(builder).status).toBe("stopped");
    expect(item(it1.id)).toMatchObject({ stage: "backlog", builderSessionId: null });
    await tick();
    expect(env.starts).toHaveLength(1);
    expect(await env.factory.status(env.project.id)).toMatchObject({
      loopState: "stopped",
      killSwitch: true,
    });
    await env.factory.setKillSwitch(env.project.id, false);
    await tick();
    expect(env.starts).toHaveLength(2);
    const global = await env.factory.setGlobalKillSwitch(true);
    expect(global.stoppedSessions).toHaveLength(1);
    expect(env.settings.get().factory.killSwitch).toBe(true);
    await tick();
    expect(env.starts).toHaveLength(2);
    expect(await env.factory.status(env.project.id)).toMatchObject({
      loopState: "stopped",
      globalKillSwitch: true,
    });
  });

  it("opens a revert PR and pauses when main CI fails after a merge", async () => {
    env = createFactoryEnv();
    enable();
    const it1 = backlogItem();
    const verifying = await toVerifying(it1);
    review(verifying);
    await tick();
    const merged = item(it1.id);
    expect(merged.stage).toBe("watching");
    env.gh.commitState.set(merged.mergeSha as string, "failure");
    await tick();
    expect(item(it1.id).stage).toBe("reverted");
    expect(env.gh.reverts).toHaveLength(1);
    const revert = items().find((i) => i.source === "revert") as FactoryItem;
    expect(revert).toMatchObject({ stage: "verifying", revertOf: it1.id });
    const loop = env.factory.data.loopOrNew(env.project.id);
    expect(loop.state).toBe("paused");
    expect(env.inbox.find(`inbox:factory-regression:${it1.id}`)?.priority).toBe("high");
    // The revert goes through the same checks and may merge while the loop is paused.
    await tick();
    // No builder worktree: the reviewer gets one on the revert PR's head, fetched by CodeDen,
    // so the review itself is offline.
    const reviewStart = env.starts.find((s) => s.workKey === `factory:review:${revert.pr?.number}`);
    const revertHead = (await env.gh.prDetails(env.project.id, revert.pr?.number ?? 0)).headBranch;
    expect(reviewStart?.workspace).toMatchObject({
      mode: "worktree",
      baseRef: `origin/${revertHead}`,
      fetch: true,
    });
    expect(reviewStart?.input?.text).toContain("Do not use the network");
    review(item(revert.id));
    await tick();
    expect(item(revert.id).stage).toBe("watching");
    expect(env.gh.merges).toHaveLength(2);
  });

  it("resumes an item in verification after a restart", async () => {
    env = createFactoryEnv();
    enable();
    const it1 = backlogItem();
    const verifying = await toVerifying(it1);
    review(verifying);
    env.restart();
    await tick();
    expect(item(it1.id).stage).toBe("watching");
  });
});

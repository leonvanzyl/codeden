import {
  DRAIN_PER_PROJECT,
  FACTORY_DRAINING,
  FactoryFileIssueRequest,
  type FactoryItem,
  ReviewVerdict,
  type ReviewVerdictInit,
} from "@codeden/contracts";
import { afterEach, describe, expect, it } from "vitest";
import type { ServiceError } from "../src/services/errors";
import { drainInboxId } from "../src/services/factory/drain";
import { DRAINING_TEXT } from "../src/services/factory/scout";
import { renderProjectDigest } from "../src/services/orchestration/digest";
import { createFactoryEnv, type FactoryEnv } from "./support/factory-env";

/**
 * The kill switch's "Finish current work, then stop" (#286, §10.1): a drain starts no new work,
 * lets the work in flight finish its pipeline, then stops the loop by itself.
 */

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

const tick = () => env.factory.tick(env.project.id);
const item = (id: string) => env.factory.data.item(id) as FactoryItem;
const loop = () => env.factory.data.loopOrNew(env.project.id);
const status = () => env.factory.status(env.project.id);
const project = () => env.factory.ctx.projects.get(env.project.id);
const drain = (drainLimitMin?: number | null) =>
  env.factory.setKillSwitch(env.project.id, true, { mode: "drain", drainLimitMin });
const failure = (run: () => Promise<unknown>) =>
  run().then(
    () => null,
    (error: ServiceError) => error.code,
  );
/** Inbox items saying the factory stopped by itself. */
const stoppedNotices = () =>
  env.inbox
    .list({ projectId: env.project.id })
    .filter((i) => i.title.startsWith("Factory stopped"));

/** The software factory with auto-merge on, or the dark factory. */
function enable(mode: "software_factory" | "dark_factory" = "software_factory", tuning = {}) {
  return env.factory.setMode(env.project.id, {
    mode,
    limits: { ...env.project.factoryLimits, autoMerge: true },
    tuning,
  });
}

let issueNumber = 10;
/** A classified feature, already analyzed, waiting for an agent. */
function backlogItem(title: string): FactoryItem {
  const number = issueNumber++;
  return env.factory.data.createItem({
    projectId: env.project.id,
    workKey: `issue:${number}`,
    title,
    summary: "Users want to count things",
    source: "issue",
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
    acceptanceCriteria: ["Counter increments"],
    issue: { number, url: `https://github.com/acme/app/issues/${number}`, title },
  });
}

/** Take a building item through its PR, review and merge until it is merged. */
async function toMerged(it: FactoryItem): Promise<void> {
  const builder = item(it.id).builderSessionId as string;
  const pr = env.gh.openPr({
    sessionId: builder,
    title: it.title,
    files: [`src/${it.id}.ts`, `test/${it.id}.test.ts`],
  });
  await env.setStatus(builder, "idle");
  await tick();
  expect(item(it.id).stage).toBe("verifying");
  const reviewer = env.repo.get(item(it.id).reviewerSessionId as string);
  env.factory.submitReview(reviewer, ReviewVerdict.parse(APPROVE));
  await env.setStatus(reviewer.id, "idle");
  env.gh.commitState.set(`merge${pr.ref.number}`, "success");
  for (let i = 0; i < 4 && item(it.id).stage !== "merged"; i++) await tick();
  expect(item(it.id).stage).toBe("merged");
}

describe("finish current work, then stop (#286)", () => {
  it("finishes the work in flight, leaves the queue alone and stops with one notice", async () => {
    env = createFactoryEnv();
    await enable();
    const a = backlogItem("Add a counter");
    const b = backlogItem("Add a reset button");
    await tick();
    expect(item(a.id).stage).toBe("building");
    expect(item(b.id).stage).toBe("building");
    const queued = backlogItem("Add a dark theme");

    const res = await drain();
    expect(res).toEqual({ on: false, stoppedSessions: [], draining: true, inFlight: 2 });
    expect(await status()).toMatchObject({
      loopState: "draining",
      killSwitch: false,
      drain: { inFlight: 2, total: 2, deadline: null },
    });
    // No intake while draining: a new trusted issue is left alone.
    env.gh.openIssue({ projectId: env.project.id, title: "Add export", author: "codeden" });
    const starts = env.starts.length;

    await toMerged(a);
    expect((await status()).drain).toMatchObject({ inFlight: 1, total: 2 });
    expect(stoppedNotices()).toHaveLength(0);
    await toMerged(b);
    await tick();

    // Only the reviewers of the two items started; the queued item never got a builder.
    expect(env.starts.slice(starts).map((s) => s.workKey)).toEqual([
      expect.stringMatching(/^factory:review:/),
      expect.stringMatching(/^factory:review:/),
    ]);
    expect(item(queued.id)).toMatchObject({ stage: "backlog", builderSessionId: null });
    expect(env.factory.data.items(env.project.id).map((i) => i.title)).not.toContain("Add export");
    expect(project().killSwitch).toBe(true);
    expect(loop()).toMatchObject({ state: "stopped", drain: null });
    expect(await status()).toMatchObject({ loopState: "stopped", drain: null });
    await tick();
    const notices = stoppedNotices();
    expect(notices).toHaveLength(1);
    expect(notices[0]).toMatchObject({
      id: drainInboxId(env.project.id),
      title: "Factory stopped after finishing 2 items",
      status: "open",
    });
    expect(notices[0]?.body).toContain("Add a counter (#");
    expect(env.notices.at(-1)).toMatchObject({ target: "pm", data: { event: "stopped" } });
    const told = env.notices.at(-1) as { data?: { itemIds?: string[] } };
    expect([...(told.data?.itemIds ?? [])].sort()).toEqual([a.id, b.id].sort());

    // Resume works as after Stop now: the queued item starts, and the notice is resolved.
    await env.factory.setKillSwitch(env.project.id, false);
    await tick();
    expect(item(queued.id).stage).toBe("building");
    expect(env.inbox.find(drainInboxId(env.project.id))?.status).toBe("resolved");
  });

  it("escalates to Stop now during a drain", async () => {
    env = createFactoryEnv();
    await enable();
    const a = backlogItem("Add a counter");
    await tick();
    const builder = item(a.id).builderSessionId as string;
    await drain();
    const res = await env.factory.setKillSwitch(env.project.id, true, { mode: "now" });
    expect(res).toMatchObject({ on: true, stoppedSessions: [builder], draining: false });
    expect(env.repo.get(builder).status).toBe("stopped");
    expect(item(a.id)).toMatchObject({ stage: "backlog", builderSessionId: null });
    expect(loop()).toMatchObject({ state: "stopped", drain: null });
    expect(await status()).toMatchObject({ loopState: "stopped", killSwitch: true, drain: null });
    // A drain asked for once the switch is on has nothing left to do.
    expect(await drain()).toMatchObject({ on: true, draining: false });
  });

  it("returns to normal on Resume, from the kill switch or the loop's Resume", async () => {
    env = createFactoryEnv({ limits: { maxConcurrentSessions: 3 } });
    await enable();
    const a = backlogItem("Add a counter");
    await tick();
    const queued = backlogItem("Add a dark theme");
    await drain();
    // An agent is free, but nothing new starts while draining.
    await tick();
    expect(item(queued.id).stage).toBe("backlog");

    await env.factory.setKillSwitch(env.project.id, false);
    expect(loop().drain).toBeNull();
    await tick();
    expect(item(queued.id).stage).toBe("building");
    expect(await status()).toMatchObject({ loopState: "building", drain: null, killSwitch: false });

    const next = backlogItem("Add an undo");
    expect(await drain()).toMatchObject({ draining: true, inFlight: 2 });
    await tick();
    expect(item(next.id).stage).toBe("backlog");
    await env.factory.resume(env.project.id);
    expect(loop()).toMatchObject({ state: "idle", drain: null });
    await tick();
    expect(item(next.id).stage).toBe("building");
    expect(item(a.id).stage).toBe("building");
  });

  it("keeps draining after a restart", async () => {
    env = createFactoryEnv();
    await enable();
    const a = backlogItem("Add a counter");
    await tick();
    const queued = backlogItem("Add a dark theme");
    await drain();
    env.restart();
    await tick();
    expect(item(queued.id).stage).toBe("backlog");
    expect(item(a.id).stage).toBe("building");
    expect(await status()).toMatchObject({ loopState: "draining", drain: { inFlight: 1 } });
    expect(project().killSwitch).toBe(false);
  });

  it("stops at once with nothing in flight, and falls back to Stop now past its time limit", async () => {
    env = createFactoryEnv();
    await enable();
    expect(await drain()).toEqual({ on: true, stoppedSessions: [], draining: false, inFlight: 0 });
    expect(project().killSwitch).toBe(true);
    expect(stoppedNotices().map((n) => n.title)).toEqual([
      "Factory stopped after finishing 0 items",
    ]);
    await env.factory.setKillSwitch(env.project.id, false);

    const a = backlogItem("Add a counter");
    await tick();
    const builder = item(a.id).builderSessionId as string;
    await drain(30);
    expect(loop().drain?.deadline).not.toBeNull();
    env.clock.offsetMs = 20 * 60_000;
    await tick();
    expect(loop().state).toBe("draining");
    env.clock.offsetMs = 31 * 60_000;
    await tick();
    expect(env.repo.get(builder).status).toBe("stopped");
    expect(item(a.id)).toMatchObject({ stage: "backlog", builderSessionId: null });
    expect(project().killSwitch).toBe(true);
    expect(loop()).toMatchObject({ state: "stopped", drain: null });
    const notice = env.inbox.find(drainInboxId(env.project.id));
    expect(notice).toMatchObject({ status: "open", notify: "failure", priority: "high" });
    expect(notice?.title).toBe(
      "Factory stopped: the drain's time limit ran out with 1 item in flight",
    );
  });

  it("closes the scout's round and files nothing while draining", async () => {
    env = createFactoryEnv();
    await enable("dark_factory", { minBacklog: 0, discoveryIntervalMin: 600 });
    const a = backlogItem("Add a counter");
    await tick();
    await env.factory.runScout(env.project.id);
    const scout = loop().scout.sessionId as string;
    expect(loop().scout.round).not.toBeNull();

    const res = await drain();
    expect(res.stoppedSessions).toEqual([scout]);
    expect(env.repo.get(scout).status).toBe("stopped");
    expect(item(a.id).stage).toBe("building");
    expect(loop().scout.round).toBeNull();
    const filed = await failure(() =>
      env.factory.fileIssue(
        env.repo.get(scout),
        FactoryFileIssueRequest.parse({
          title: "Add a search box",
          summary: "Users look things up",
          type: "feature",
          acceptanceCriteria: ["Search finds items"],
        }),
      ),
    );
    expect(filed).toBe(FACTORY_DRAINING);
    expect((await status()).scout?.runNowBlockedBy).toBe(DRAINING_TEXT);
    expect(await failure(() => env.factory.runScout(env.project.id))).toBe("scout_unavailable");
  });

  it("reports the drain to the PM and in the digests; the global switch only stops now", async () => {
    env = createFactoryEnv();
    await enable();
    backlogItem("Add a counter");
    await tick();
    await drain();
    expect(env.factory.loopSummary(env.project.id)).toEqual({
      loopState: "draining",
      drainInFlight: 1,
    });
    const digest = await env.factory.digestNow(env.project.id);
    expect(digest.text).toContain("Draining: 1 item in flight");
    const pm = renderProjectDigest({
      project: { id: "p1", name: "Shop", kind: "github", mode: "software_factory" },
      running: [],
      queued: [],
      scheduled: [],
      inbox: { open: 0, items: [] },
      recent: [],
      factory: { loopState: "draining", drainInFlight: 2 },
    });
    expect(pm).toContain("Factory: draining, 2 items in flight");
    expect(await failure(() => env.factory.setGlobalKillSwitch(true, "drain"))).toBe(
      DRAIN_PER_PROJECT,
    );
    expect(env.settings.get().factory.killSwitch).toBe(false);
  });
});

import {
  type FactoryDigest,
  type FactoryItem,
  FactoryStatus,
  type Role,
  SetAutonomyModeResponse,
} from "@codeden/contracts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { VISION_TEMPLATE } from "../src/services/factory/vision";
import { FakeFactoryGithub } from "./support/fake-factory-github";
import { type Harness, startHarness, waitUntil } from "./support/harness";

/**
 * The factory loop end to end on a real server and runner with the Fake provider: improvement
 * finder -> PM triage -> GitHub issue -> builder in a worktree -> PR -> merge checks with an
 * independent reviewer session -> squash merge -> watch -> digest; and a failing-check path.
 * GitHub is scripted (`FakeFactoryGithub`); agent judgement arrives through the factory tools.
 */
describe("factory loop with the Fake provider (§10.1)", () => {
  let h: Harness;
  const gh = new FakeFactoryGithub();

  const call = async (role: Role, name: string, args: unknown, sessionId: string) => {
    const res = await h.server.services.tools.call(name, args, {
      role,
      sessionId,
      projectId: h.projectId,
      caller: "mcp",
      signal: new AbortController().signal,
    });
    if (res.isError) throw new Error(res.text);
    return JSON.parse(res.text) as Record<string, unknown>;
  };
  const tick = async () =>
    FactoryStatus.parse((await h.api("POST", `/projects/${h.projectId}/factory/tick`)).body);
  const idle = (id: string) =>
    waitUntil(async () => ((await h.detail(id)).session.status === "idle" ? true : undefined));
  const item = (id: string) => h.server.services.factory.data.item(id) as FactoryItem;
  const report = async (finder: string, title: string) => {
    const res = await call(
      "agent",
      "factory_report_candidates",
      {
        candidates: [
          { title, summary: `${title} for users`, acceptanceCriteria: [`${title} works`] },
        ],
      },
      finder,
    );
    return (res.created as Array<{ itemId: string }>)[0]?.itemId as string;
  };
  const build = async (itemId: string, files: string[], checks: "success" | "failure") => {
    await tick();
    const builder = item(itemId).builderSessionId as string;
    expect(builder).toBeTruthy();
    await idle(builder);
    gh.openPr({ sessionId: builder, title: item(itemId).title, files, checks });
    return tick();
  };

  let finder = "";

  beforeAll(async () => {
    h = await startHarness(
      {
        factory: { github: gh, autoTick: false, ciGraceMs: 0 },
        orchestration: { wake: { debounceMs: 60_000, maxWaitMs: 120_000 } },
      },
      { ".codeden/VISION.md": VISION_TEMPLATE },
    );
    gh.githubProjects.add(h.projectId);
  }, 60_000);
  afterAll(async () => {
    await h?.close();
  });

  it("switches to dark factory with a vision and limits", async () => {
    const res = await h.api("PUT", `/projects/${h.projectId}/autonomy`, {
      mode: "dark_factory",
      limits: { maxConcurrentSessions: 2, maxMergesPerDay: 5, dailyBudget: { usd: 5 } },
      tuning: { discoveryPerRound: 1, maxFixAttempts: 0 },
    });
    expect(res.status).toBe(200);
    expect(SetAutonomyModeResponse.parse(res.body)).toMatchObject({
      mode: "dark_factory",
      experimental: true,
    });
    const vision = (await h.api("GET", `/projects/${h.projectId}/vision`)).body as {
      exists: boolean;
    };
    expect(vision.exists).toBe(true);
  });

  it("discovers, triages, builds, verifies, merges and reports one item", async () => {
    const status = await tick();
    expect(status.loopState).toBe("discovering");
    const sessions = h.server.services.sessionRepo.list({ projectId: h.projectId, role: "agent" });
    finder = sessions.find((s) => s.workKey === "factory:discover:features")?.id as string;
    expect(finder).toBeTruthy();
    await idle(finder);

    const itemId = await report(finder, "Add a counter");
    await tick();
    expect(
      h.server.services.orchestration.notices
        .list({ projectId: h.projectId, target: "pm" })
        .some((n) => n.type === "factory.update" && n.data.event === "triage_needed"),
    ).toBe(true);
    const triaged = await call(
      "pm",
      "factory_triage",
      { itemId, decision: "accept", score: 0.9 },
      "pm-session",
    );
    expect(triaged.stage).toBe("backlog");
    expect(gh.issues).toHaveLength(1);

    const verifying = await build(itemId, ["src/counter.ts", "test/counter.test.ts"], "success");
    expect(verifying.inProgress[0]).toMatchObject({ id: itemId, stage: "verifying" });
    const reviewer = item(itemId).reviewerSessionId as string;
    expect(reviewer).toBeTruthy();
    // Only the Fake provider is available: the review falls back to it, with a note.
    expect(item(itemId).reviewerNote).toMatch(/same provider/);
    await idle(reviewer);
    const verdict = await call(
      "agent",
      "factory_submit_review",
      {
        verdict: "approve",
        summary: "Meets the criterion",
        criteria: [{ criterion: "Add a counter works", met: true }],
        vision: { aligned: true },
        tests: { adequate: true },
        security: { concerns: [] },
      },
      reviewer,
    );
    expect(verdict.recorded).toBe(true);

    await tick();
    expect(gh.merges).toHaveLength(1);
    const done = await tick();
    expect(item(itemId).stage).toBe("merged");
    expect(done.mergesToday).toBe(1);
    expect(done.recent[0]).toMatchObject({ id: itemId, stage: "merged" });

    const digest = (await h.api("POST", `/projects/${h.projectId}/factory/digest`))
      .body as FactoryDigest;
    expect(digest.shipped.map((s) => s.title)).toEqual(["Add a counter"]);
    const inbox = h.server.services.inbox.list({ projectId: h.projectId });
    expect(inbox.some((i) => i.id.startsWith("inbox:factory-digest:"))).toBe(true);
  }, 60_000);

  it("fails an item whose CI is red and leaves the PR for a human", async () => {
    const itemId = await report(finder, "Add a reset button");
    await call("pm", "factory_triage", { itemId, decision: "accept", score: 0.5 }, "pm-session");
    await build(itemId, ["src/reset.ts", "test/reset.test.ts"], "failure");
    expect(item(itemId)).toMatchObject({ stage: "failed" });
    expect(item(itemId).reason).toMatch(/ci: CI failed/);
    expect(gh.merges).toHaveLength(1);
    expect(gh.comments.some((c) => c.body.includes("merge checks failed"))).toBe(true);
    const status = FactoryStatus.parse(
      (await h.api("GET", `/projects/${h.projectId}/factory`)).body,
    );
    expect(status.consecutiveFailures).toBe(1);
    expect(status.recent[0]).toMatchObject({ id: itemId, stage: "failed" });
  }, 60_000);

  it("never waits on the user: factory agents decide and record it", async () => {
    const started = Date.now();
    const asked = await h.server.services.tools.call(
      "ask_user",
      { question: "Polish index.html or migrate to the vision stack first?" },
      {
        role: "agent",
        sessionId: finder,
        projectId: h.projectId,
        caller: "mcp",
        signal: new AbortController().signal,
      },
    );
    expect(asked.isError).toBeFalsy();
    expect(asked.text).toContain("factory_record_decision");
    expect(Date.now() - started).toBeLessThan(5_000);
    // Nothing was put in front of the user to answer.
    const open = () => h.server.services.inbox.list({ projectId: h.projectId });
    expect(open().some((i) => i.kind === "question" && i.status === "open")).toBe(false);

    const recorded = await call(
      "agent",
      "factory_record_decision",
      {
        question: "Polish index.html or migrate first?",
        decision: "Migrate to the vision stack first",
        reasoning: "The vision names Next.js; polishing index.html would be thrown away",
      },
      finder,
    );
    const decision = open().find((i) => i.id === recorded.inboxItemId);
    expect(decision).toMatchObject({ kind: "message", priority: "low", status: "open" });
    expect(decision?.title).toMatch(/^Factory decided: Polish index\.html/);

    const digest = (await h.api("POST", `/projects/${h.projectId}/factory/digest`))
      .body as FactoryDigest;
    expect(digest.decisions).toEqual([
      expect.objectContaining({
        decision: "Migrate to the vision stack first",
        needsHuman: false,
        inboxItemId: recorded.inboxItemId,
      }),
    ]);
    expect(digest.waiting.some((w) => w.inboxItemId === recorded.inboxItemId)).toBe(false);

    // A session the user started still asks as usual.
    const mine = await h.startFakeSession();
    expect(h.server.services.factory.isUnattended(mine)).toBe(false);
    expect(h.server.services.factory.isUnattended(finder)).toBe(true);
  }, 60_000);
});

import type { FactoryItem, ReviewVerdictInit } from "@codeden/contracts";
import { pipelineStep, ReviewVerdict } from "@codeden/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { createFactoryEnv, type FactoryEnv } from "./support/factory-env";

const APPROVE: ReviewVerdictInit = {
  verdict: "approve",
  summary: "Meets the criteria",
  criteria: [{ criterion: "Works", met: true }],
  vision: { aligned: true },
  tests: { adequate: true },
  security: { concerns: [] },
};

let env: FactoryEnv;
afterEach(() => env?.close());

const enable = (limits: object = {}) =>
  env.factory.setMode(env.project.id, {
    mode: "software_factory",
    limits: { ...env.project.factoryLimits, ...limits },
  });
const tick = () => env.factory.tick(env.project.id);
const item = (id: string) => env.factory.data.item(id) as FactoryItem;
const byIssue = (number: number) =>
  env.factory.data.items(env.project.id).find((i) => i.issue?.number === number) as FactoryItem;
const issue = (title: string, author: string | null, labels: string[] = []) =>
  env.gh.openIssue({ projectId: env.project.id, title, author, labels });
const builderOf = (id: string) => env.repo.get(item(id).builderSessionId as string);

/** A builder's PR, then a tick: the item is in verification (or past it). */
async function openPr(id: string, files: string[], opts: { body?: string } = {}) {
  const sessionId = item(id).builderSessionId as string;
  const pr = env.gh.openPr({ sessionId, title: item(id).title, files, ...opts });
  await env.setStatus(sessionId, "idle");
  await tick();
  return pr;
}

function approve(id: string) {
  const session = env.repo.get(item(id).reviewerSessionId as string);
  return env.factory.submitReview(session, ReviewVerdict.parse(APPROVE));
}

describe("the trust gate (§10.1)", () => {
  it("takes on trusted authors' issues and ignores everyone else's, labels or not", async () => {
    env = createFactoryEnv({ limits: { trustedAuthors: ["Alice"] } });
    enable();
    const mine = issue("Add CSV export", "codeden");
    const alice = issue("Add JSON export", "alice");
    const mallory = issue("Add a webhook", "mallory", ["codeden-factory", "bug"]);
    await tick();
    expect(byIssue(mine.number)).toMatchObject({ trust: "trusted", type: "feature" });
    expect(byIssue(alice.number).trust).toBe("trusted");
    expect(byIssue(mallory.number)).toMatchObject({
      stage: "ignored",
      trust: "untrusted",
      author: "mallory",
      type: null,
    });
    expect(byIssue(mallory.number).reason).toMatch(/@mallory, who is not a trusted author/);
    // Nothing ran on it: no classification comment, no session.
    expect(env.gh.comments.some((c) => c.number === mallory.number)).toBe(false);
    expect(env.starts.every((s) => s.issue?.number !== mallory.number)).toBe(true);
    expect((await env.factory.status(env.project.id)).ignored).toHaveLength(1);
  });

  it("waits while the GitHub account is unknown instead of ignoring by mistake", async () => {
    env = createFactoryEnv();
    enable();
    env.gh.viewer = null;
    const mine = issue("Add CSV export", "codeden");
    await tick();
    expect(byIssue(mine.number)).toBeUndefined();
    env.gh.viewer = "codeden";
    await tick();
    expect(byIssue(mine.number).trust).toBe("trusted");
  });

  it("takes an ignored issue on once its author is trusted, and drops it once closed", async () => {
    env = createFactoryEnv();
    enable();
    const a = issue("Add a webhook", "mallory");
    const b = issue("Add a theme", "eve");
    await tick();
    env.updateProject({
      factoryLimits: { ...env.project.factoryLimits, trustedAuthors: ["mallory"] },
    });
    const closed = env.gh.issues.find((i) => i.number === b.number);
    if (closed) closed.state = "closed";
    await tick();
    expect(byIssue(a.number)).toMatchObject({ trust: "trusted" });
    expect(byIssue(a.number).stage).not.toBe("ignored");
    expect(byIssue(b.number)).toMatchObject({ stage: "rejected" });
  });

  it("never merges work let in from an untrusted author, even with auto-merge on", async () => {
    env = createFactoryEnv({ limits: { autoMerge: true } });
    enable({ autoMerge: true });
    const ext = issue("Add a theme toggle", "stranger");
    await tick();
    const id = byIssue(ext.number).id;
    await env.factory.admit(env.project.id, { itemId: id, type: "docs" }, "pm");
    expect(item(id)).toMatchObject({ stage: "backlog", trust: "admitted", admittedBy: "pm" });
    await tick();
    await openPr(id, ["docs/theme.md"]);
    await tick();
    expect(env.gh.merges).toHaveLength(0);
    expect(pipelineStep(item(id))).toBe("merge");
    expect(item(id).note).toMatch(/untrusted author, so a person merges it/);
  });
});

describe("the pipelines (§10.1)", () => {
  it("stops a bug at ready-to-merge by default and finishes when you merge it", async () => {
    env = createFactoryEnv();
    enable();
    const bug = issue("Save crashes on empty title", "codeden");
    await tick();
    const id = byIssue(bug.number).id;
    expect(item(id)).toMatchObject({ stage: "building", type: "bug" });
    expect(env.gh.comments.some((c) => c.body.includes("classified as a **bug**"))).toBe(true);
    expect(env.starts.at(-1)?.input?.text).toContain("factory_report_reproduction");
    expect(pipelineStep(item(id))).toBe("reproduce");
    const res = await env.factory.reportReproduction(builderOf(id), {
      reproduced: true,
      summary: "save('') throws",
      testPath: "test/save.test.ts",
    });
    expect(res.next).toMatch(/Create fix/);
    expect(pipelineStep(item(id))).toBe("implement");
    const pr = await openPr(id, ["src/save.ts", "test/save.test.ts"]);
    approve(id);
    await tick();
    expect(env.gh.merges).toHaveLength(0);
    expect(pipelineStep(item(id))).toBe("merge");
    expect(env.inbox.find(`inbox:factory-ready:${id}`)).toMatchObject({
      kind: "pr_review",
      status: "open",
    });
    expect(env.gh.comments.some((c) => c.body.includes("Ready for a maintainer"))).toBe(true);
    pr.ref = { ...pr.ref, state: "merged" };
    await tick();
    expect(item(id).stage).toBe("merged");
    expect(env.inbox.find(`inbox:factory-ready:${id}`)?.status).toBe("resolved");
  });

  it("stops a bug that doesn't reproduce, and runs it again on retry", async () => {
    env = createFactoryEnv();
    enable();
    const bug = issue("Login fails sometimes", "codeden", ["bug"]);
    await tick();
    const id = byIssue(bug.number).id;
    const res = await env.factory.reportReproduction(builderOf(id), {
      reproduced: false,
      summary: "Logs in every time",
      steps: "Tried 50 logins",
    });
    expect(res.next).toMatch(/finish/);
    expect(item(id)).toMatchObject({ stage: "rejected" });
    expect(item(id).reason).toMatch(/Could not reproduce/);
    expect(env.gh.comments.some((c) => c.body.includes("could not reproduce"))).toBe(true);
    expect(env.inbox.find(`inbox:factory-stopped:${id}`)?.status).toBe("open");
    env.factory.retry(env.project.id, id);
    expect(item(id)).toMatchObject({ stage: "backlog", investigation: null, attempts: 0 });
    await tick();
    expect(item(id).stage).toBe("building");
  });

  it("builds a feature to the spec from its analysis", async () => {
    env = createFactoryEnv();
    enable();
    const feat = issue("Add CSV export", "codeden", ["enhancement"]);
    await tick();
    const id = byIssue(feat.number).id;
    expect(pipelineStep(item(id))).toBe("analyze");
    const res = await env.factory.submitAnalysis(builderOf(id), {
      decision: "implement",
      summary: "Not there yet",
      spec: "An Export button that downloads CSV",
      acceptanceCriteria: ["Export downloads a CSV of all tasks"],
    });
    expect(res.next).toMatch(/Implement feature/);
    expect(res.next).toContain("An Export button that downloads CSV");
    expect(item(id).acceptanceCriteria).toEqual(["Export downloads a CSV of all tasks"]);
    // A request that already works stops with a comment instead.
    const done = issue("Add sorting", "codeden", ["enhancement"]);
    await tick();
    const did = byIssue(done.number).id;
    await env.factory.submitAnalysis(builderOf(did), {
      decision: "already_done",
      summary: "Sorting exists in the header",
    });
    expect(item(did)).toMatchObject({ stage: "rejected" });
    expect(item(did).reason).toMatch(/Already possible/);
  });

  it("runs a docs change without an agent review", async () => {
    env = createFactoryEnv();
    enable();
    const docs = issue("Fix typo in README", "codeden");
    await tick();
    const id = byIssue(docs.number).id;
    expect(item(id).type).toBe("docs");
    await openPr(id, ["README.md"]);
    await tick();
    expect(item(id).reviewerSessionId).toBeNull();
    expect(item(id).checks.find((c) => c.name === "review")?.state).toBe("skipped");
    expect(pipelineStep(item(id))).toBe("merge");
  });

  it("sends the builder back when the PR has no test results", async () => {
    env = createFactoryEnv();
    enable();
    const feat = issue("Add CSV export", "codeden", ["enhancement"]);
    await tick();
    const id = byIssue(feat.number).id;
    await env.factory.submitAnalysis(builderOf(id), {
      decision: "implement",
      summary: "Missing",
      spec: "Export",
      acceptanceCriteria: ["Exports"],
    });
    await openPr(id, ["src/export.ts", "test/export.test.ts"], { body: "Adds export" });
    // No reviewer is spent on it: the revise round starts straight away.
    expect(item(id)).toMatchObject({ stage: "building", attempts: 1, reviewerSessionId: null });
    expect(env.messages.at(-1)?.text).toMatch(/test_results: No test results/);
  });

  it("uses the utility model to classify when there is no label", async () => {
    env = createFactoryEnv();
    env.model = async () => '{"type":"docs","confidence":"high","rationale":"Docs only"}';
    enable();
    const it1 = issue("Explain the config options", "codeden");
    await tick();
    expect(byIssue(it1.number).classification).toMatchObject({ type: "docs", by: "model" });
    expect(env.gh.issues.find((i) => i.number === it1.number)?.labels).toContain("factory:docs");
  });
});

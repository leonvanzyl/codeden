import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CreateProjectResponse,
  GithubIssuesResponse,
  GithubPrDetails,
  GithubPrDiff,
  GithubPrsResponse,
} from "@codeden/contracts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type RunningServer, startServer } from "../src";
import { type Exec, runTool } from "../src/services/exec";
import { GithubFactoryPort } from "../src/services/factory/github-port";
import { changeSize } from "../src/services/factory/size";
import { FakeGithub, type FakePrFile } from "./support/fake-github";

const TOKEN = "e".repeat(64);
let home: string;
let server: RunningServer;
let gh: FakeGithub;
let projectId: string;
let localId: string;

const api = async (method: string, path: string, body?: unknown) => {
  const res = await fetch(`${server.url}/api${path}`, {
    method,
    headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
};

function repo(name: string, remote?: string): string {
  const dir = join(home, name);
  mkdirSync(dir);
  const git = (...args: string[]) => execFileSync("git", ["-C", dir, ...args], { stdio: "pipe" });
  git("init", "-q", "-b", "main");
  writeFileSync(join(dir, "README.md"), "# x\n");
  git("add", ".");
  git("-c", "user.email=t@example.com", "-c", "user.name=T", "commit", "-q", "-m", "init");
  if (remote) git("remote", "add", "origin", remote);
  return dir;
}

beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), "codeden-ghr-"));
  gh = new FakeGithub();
  // `gh auth token` is faked; every other tool (git) runs for real.
  const exec: Exec = (command, args, opts) =>
    command === "gh"
      ? Promise.resolve({
          code: 0,
          stdout: "tok-1\n",
          stderr: "",
          notFound: false,
          timedOut: false,
          path: "gh",
        })
      : runTool(command, args, opts);
  server = await startServer({
    port: 0,
    dataDir: join(home, "data"),
    token: TOKEN,
    runner: false,
    secrets: "memory",
    checkSetupOnStart: false,
    userHome: home,
    exec,
    github: { fetch: gh.fetch, baseUrl: "https://api.github.test", sync: false },
  });
  const created = CreateProjectResponse.parse(
    (
      await api("POST", "/projects", {
        source: { type: "local", path: repo("widgets", "https://github.com/acme/widgets.git") },
      })
    ).body,
  );
  projectId = created.project.id;
  expect(created.project.kind).toBe("github");
  localId = CreateProjectResponse.parse(
    (await api("POST", "/projects", { source: { type: "local", path: repo("notes") } })).body,
  ).project.id;
}, 60_000);

afterAll(async () => {
  await server?.close();
  rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

describe("github routes", () => {
  it("lists synced issues and PRs with the connection state", async () => {
    gh.addIssue({ title: "Bug", labels: ["bug"] });
    gh.addPr(
      "codeden/fix",
      { body: "Fixes #1" },
      { checks: [{ name: "ci", status: "COMPLETED", conclusion: "SUCCESS" }] },
    );
    const synced = await api("POST", `/projects/${projectId}/github/sync`);
    expect(synced.status).toBe(200);

    const issues = GithubIssuesResponse.parse(
      (await api("GET", `/projects/${projectId}/github/issues`)).body,
    );
    expect(issues.connection).toMatchObject({ connected: true, login: "octo", source: "gh" });
    expect(issues.issues.map((i) => i.number)).toEqual([1]);
    const prs = GithubPrsResponse.parse(
      (await api("GET", `/projects/${projectId}/github/prs?state=all`)).body,
    );
    expect(prs.prs[0]).toMatchObject({
      number: 2,
      checks: { state: "success" },
      linkedIssues: [1],
    });

    const details = GithubPrDetails.parse(
      (await api("GET", `/prs/${encodeURIComponent(`${projectId}:2`)}`)).body,
    );
    expect(details.files).toEqual([
      { path: "src/app.ts", status: "modified", additions: 3, deletions: 1 },
    ]);

    const local = GithubIssuesResponse.parse(
      (await api("GET", `/projects/${localId}/github/issues`)).body,
    );
    expect(local).toMatchObject({ connection: { connected: false }, issues: [] });
    expect((await api("POST", `/projects/${localId}/github/issues`, { title: "x" })).status).toBe(
      409,
    );
  });

  it("creates, comments on, labels and triages issues", async () => {
    const created = await api("POST", `/projects/${projectId}/github/issues`, {
      title: "Dark mode",
    });
    expect(created.status).toBe(201);
    const n = created.body.number as number;
    expect(
      (await api("POST", `/projects/${projectId}/github/issues/${n}/comments`, { body: "On it" }))
        .status,
    ).toBe(201);
    const labeled = await api("POST", `/projects/${projectId}/github/issues/${n}/labels`, {
      add: ["feature"],
    });
    expect(labeled.body.labels).toEqual(["feature"]);
    const triaged = await api("POST", `/projects/${projectId}/github/issues/${n}/triage`, {
      decision: "ready",
    });
    expect(triaged.body).toMatchObject({ decision: "ready", closed: false });
    const issue = await api("GET", `/projects/${projectId}/github/issues/${n}`);
    expect((issue.body.recentComments as unknown[]).length).toBe(1);
  });

  it("merges a PR with squash", async () => {
    const res = await api("POST", `/prs/${encodeURIComponent(`${projectId}:2`)}/merge`, {});
    expect(res.body).toEqual({ merged: true, sha: "merge-sha" });
    const prs = GithubPrsResponse.parse(
      (await api("GET", `/projects/${projectId}/github/prs?state=closed`)).body,
    );
    expect(prs.prs[0]?.state).toBe("merged");
    expect((await api("POST", "/prs/not-an-id/merge", {})).body).toMatchObject({
      error: { code: "invalid_pr_id" },
    });
  });

  it("exposes the agent tools through the registry", async () => {
    const tools = server.services.tools.list("agent").map((t) => t.name);
    expect(tools).toEqual(
      expect.arrayContaining([
        "create_pull_request",
        "attach_evidence",
        "comment_on_issue",
        "get_pr_status",
      ]),
    );
    expect(server.services.tools.list("pm").map((t) => t.name)).not.toContain(
      "create_pull_request",
    );
    const result = await server.services.tools.call(
      "get_pr_status",
      { number: 2 },
      {
        caller: "ui",
        role: "pm",
        sessionId: "pm-1",
        projectId,
        signal: new AbortController().signal,
      },
    );
    expect(result.isError).toBe(false);
    expect(JSON.parse(result.text)).toMatchObject({
      number: 2,
      state: "merged",
      checks: { state: "success" },
    });
    const local = await server.services.tools.call(
      "comment_on_issue",
      { number: 1, body: "hi" },
      {
        caller: "ui",
        role: "pm",
        sessionId: "pm-1",
        projectId: localId,
        signal: new AbortController().signal,
      },
    );
    expect(local).toMatchObject({ isError: true });
    // GitHub tools are not even listed for local-only projects.
    expect(local.text).toContain("Unknown tool");
    const pmLocal = server.services.tools
      .list("pm", { projectId: localId, sessionId: null })
      .map((t) => t.name);
    expect(pmLocal).not.toContain("get_pr_status");
    expect(pmLocal).not.toContain("list_issues");
    // One get_pr_status, shared by PMs and agents, next to the PM issue tools.
    const pmGithub = server.services.tools
      .list("pm", { projectId, sessionId: null })
      .map((t) => t.name);
    expect(pmGithub.filter((n) => n === "get_pr_status")).toHaveLength(1);
    expect(pmGithub).toEqual(expect.arrayContaining(["list_issues", "triage_issue"]));
  });

  it("reads every changed file of a large PR with its patch, once per head commit", async () => {
    const files: FakePrFile[] = Array.from({ length: 150 }, (_, i) => ({
      filename: `src/f${i}.ts`,
      status: "modified",
      additions: 1,
      deletions: 1,
      patch: `@@ -1 +1 @@\n-a${i}\n+b${i}`,
    }));
    // A pure rename: GitHub sends no patch.
    files.push({
      filename: "src/new.ts",
      previous_filename: "src/old.ts",
      status: "renamed",
      additions: 0,
      deletions: 0,
    });
    const pr = gh.addPr("codeden/big", { title: "Big change" }, { files });
    const id = encodeURIComponent(`${projectId}:${pr.number}`);
    const fileReads = () =>
      gh.requests.filter((r) => r.path.endsWith(`/pulls/${pr.number}/files`)).length;

    const details = GithubPrDetails.parse((await api("GET", `/prs/${id}`)).body);
    expect(details.files).toHaveLength(151);
    expect(details.changedFiles).toBe(151);
    expect(details.files[150]).toEqual({
      path: "src/new.ts",
      previousPath: "src/old.ts",
      status: "renamed",
      additions: 0,
      deletions: 0,
    });
    expect(details.files[0]).not.toHaveProperty("patch");
    expect(fileReads()).toBe(2); // 100 + 51

    // The factory's size check sees every file too.
    const factoryPr = await new GithubFactoryPort(server.services.github).prDetails(
      projectId,
      pr.number,
    );
    expect(changeSize(factoryPr)).toMatchObject({ files: 151, lines: 300 });

    const diff = GithubPrDiff.parse((await api("GET", `/prs/${id}/diff`)).body);
    expect(diff.headSha).toBe("sha-codeden/big-1");
    expect(diff.files).toHaveLength(151);
    expect(diff.files[120]?.patch).toBe(
      "diff --git a/src/f120.ts b/src/f120.ts\n--- a/src/f120.ts\n+++ b/src/f120.ts\n@@ -1 +1 @@\n-a120\n+b120\n",
    );
    expect(diff.files[150]?.patch).toBeNull();
    expect(fileReads()).toBe(2); // same head commit: read from memory

    gh.touch(pr.number, (i) => {
      if (i.pr) i.pr.headSha = "sha-codeden/big-2";
    });
    const moved = GithubPrDiff.parse((await api("GET", `/prs/${id}/diff`)).body);
    expect(moved.headSha).toBe("sha-codeden/big-2");
    expect(fileReads()).toBe(4); // a new head commit is read again

    expect((await api("GET", "/prs/not-an-id/diff")).status).toBe(400);
  });
});

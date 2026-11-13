import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { EVIDENCE_BRANCH } from "../src/services/github/evidence";
import { pullRequestBody } from "../src/services/github/pull-requests";
import { createGithubEnv, type GithubEnv } from "./support/github-env";

let env: GithubEnv;
const P = "p-gh";

beforeEach(() => {
  env = createGithubEnv();
});
afterEach(() => env.close());

describe("create pull request", () => {
  it("pushes through the runner, opens the PR and links it to the session", async () => {
    env.gh.addIssue({ title: "Bug" });
    const session = env.addSession({
      issue: { number: 1, url: "https://github.com/acme/widgets/issues/1" },
    });
    env.dirtyFiles = ["src/app.ts"];

    await expect(
      env.service.createPullRequest(session.id, { title: "fix: bug" }),
    ).rejects.toMatchObject({
      code: "uncommitted_changes",
    });

    const result = await env.service.createPullRequest(session.id, {
      title: "fix: bug",
      body: "Fixes the bug.",
      commitMessage: "fix: bug",
      draft: true,
    });
    expect(result).toMatchObject({
      number: 2,
      created: true,
      branch: session.branch,
      base: "main",
      commit: "c0ffee1234567",
    });
    const names = env.runnerCalls.map((c) => c.name);
    expect(names).toEqual(["git.status", "git.status", "git.commit", "git.push"]);
    const created = env.gh.requests.find((r) => r.method === "POST" && r.path.endsWith("/pulls"));
    const sent = created?.body as { body: string; draft: boolean } | undefined;
    expect(sent?.body).toContain("Fixes #1");
    expect(sent?.body).toContain(`codeden:session=${session.id}`);
    expect(sent?.draft).toBe(true);

    const linked = env.repo.get(session.id);
    expect(linked.pr).toMatchObject({ number: 2, state: "draft" });
    expect(env.events.some((e) => e.type === "pr.opened" && e.sessionId === session.id)).toBe(true);
    expect((await env.service.sessionGithub(session.id)).pr).toMatchObject({
      number: 2,
      sessionId: session.id,
    });

    // Again: updates the open PR instead of opening another.
    const again = await env.service.createPullRequest(session.id, {
      title: "fix: the bug",
      body: "v2",
    });
    expect(again).toMatchObject({ number: 2, created: false });
  });

  it("pushes the session's own branch again with a lease after a rebase", async () => {
    const rejected =
      "git push failed (1): ! [rejected] codeden/task-1 -> codeden/task-1 (non-fast-forward)";
    env.pushRejection = rejected;
    const session = env.addSession();
    const result = await env.service.createPullRequest(session.id, { title: "fix: bug" });
    expect(result).toMatchObject({ created: true, branch: session.branch });
    const pushes = env.runnerCalls.filter((c) => c.name === "git.push");
    expect(pushes).toHaveLength(2);
    expect(pushes[0]).not.toHaveProperty("forceWithLease");
    expect(pushes[1]).toMatchObject({ branch: session.branch, forceWithLease: true });
  });

  it("never force-pushes a branch the session doesn't own, or on other failures", async () => {
    env.pushRejection =
      "git push failed (1): ! [rejected] feature/shared -> feature/shared (fetch first)";
    // An existing folder on a branch the session didn't create.
    const shared = env.addSession({ worktreePath: null, branch: "feature/shared" });
    await expect(
      env.service.createPullRequest(shared.id, { title: "fix: bug" }),
    ).rejects.toMatchObject({ code: "git_failed" });
    env.pushRejection = "git push failed (128): fatal: could not read from remote repository";
    const own = env.addSession();
    await expect(
      env.service.createPullRequest(own.id, { title: "fix: bug" }),
    ).rejects.toMatchObject({ code: "git_failed" });
    const pushes = env.runnerCalls.filter((c) => c.name === "git.push");
    expect(pushes).toHaveLength(2);
    expect(pushes.some((c) => "forceWithLease" in c)).toBe(false);
  });

  it("does not repeat an issue link the body already has", () => {
    const body = pullRequestBody("Closes #4", 4, { id: "s1", title: null } as never);
    expect(body.match(/#4/g)).toHaveLength(1);
  });
});

describe("attach evidence", () => {
  it("commits files to the orphan evidence branch and comments with renderable URLs", async () => {
    const session = env.addSession({
      pr: { number: 7, url: "https://github.com/acme/widgets/pull/7", state: "open" },
    });
    env.gh.addIssue();
    env.gh.addIssue();
    env.gh.addIssue();
    env.gh.addIssue();
    env.gh.addIssue();
    env.gh.addIssue();
    env.gh.addPr("codeden/task-1");
    writeFileSync(join(env.dir, "shot.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    const artifact = env.artifacts.save({
      bytes: Buffer.from("all tests passed"),
      name: "report.txt",
      mediaType: "text/plain",
      kind: "file",
      projectId: P,
      sessionId: session.id,
    });

    const result = await env.service.attachEvidence(session.id, {
      files: [{ path: "shot.png", caption: "Home page" }, { artifactId: artifact.id }],
      summary: "Verified the home page.",
      testOutput: "42 passed",
    });
    const commitSha = env.gh.gitData.refs.get(`refs/heads/${EVIDENCE_BRANCH}`);
    expect(commitSha).toBeTruthy();
    expect(env.gh.gitData.commits.get(commitSha ?? "")?.parents).toEqual([]);
    expect(result.target).toEqual({ kind: "pr", number: 7 });
    expect(result.files[0]?.url).toBe(
      `https://github.com/acme/widgets/blob/${commitSha}/pr-7/${session.id}/shot.png?raw=true`,
    );
    const comment = env.gh.issues.get(7)?.comments.at(-1)?.body ?? "";
    expect(comment).toContain(`![Home page](${result.files[0]?.url})`);
    expect(comment).toContain(
      `[report.txt](https://github.com/acme/widgets/blob/${commitSha}/pr-7/${session.id}/report.txt?raw=true)`,
    );
    expect(comment).toContain("42 passed");

    // A second attachment builds on the branch.
    await env.service.attachEvidence(session.id, { files: [{ path: "shot.png" }] });
    const next = env.gh.gitData.refs.get(`refs/heads/${EVIDENCE_BRANCH}`) ?? "";
    expect(env.gh.gitData.commits.get(next)?.parents).toEqual([commitSha]);
  });

  it("refuses files outside the worktree and needs a target", async () => {
    const session = env.addSession();
    await expect(env.service.attachEvidence(session.id, { summary: "x" })).rejects.toMatchObject({
      code: "no_target",
    });
    await expect(
      env.service.attachEvidence(session.id, {
        target: { kind: "issue", number: 1 },
        files: [{ path: "../../etc/hosts" }],
      }),
    ).rejects.toMatchObject({ status: expect.any(Number) });
  });
});

describe("issues", () => {
  it("creates, labels, comments and triages", async () => {
    const issue = await env.service.createIssue(P, {
      title: "Add dark mode",
      body: "Please",
      labels: [],
    });
    expect(issue).toMatchObject({ number: 1, state: "open" });
    expect(env.events.some((e) => e.type === "issue.opened")).toBe(true);

    const labeled = await env.service.labelIssue(P, 1, { add: ["feature"], remove: ["absent"] });
    expect(labeled.labels).toEqual(["feature"]);

    const triaged = await env.service.triageIssue(P, 1, {
      decision: "out_of_scope",
      labels: ["wontfix"],
      removeLabels: ["feature"],
      comment: "Out of scope for now.",
      close: true,
    });
    expect(triaged).toMatchObject({
      decision: "out_of_scope",
      closed: true,
      issue: { labels: ["wontfix"] },
    });
    const details = await env.service.getIssue(P, 1);
    expect(details.recentComments.at(-1)?.body).toBe("Out of scope for now.");
    expect(env.gh.requests.find((r) => r.method === "PATCH")?.body).toMatchObject({
      state_reason: "not_planned",
    });
  });
});

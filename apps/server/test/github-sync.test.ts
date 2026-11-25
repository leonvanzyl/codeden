import type { Project } from "@codeden/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { GithubRateLimitError } from "../src/services/github/client";
import { createGithubEnv, type GithubEnv } from "./support/github-env";

let env: GithubEnv;
const P = "p-gh";

beforeEach(() => {
  env = createGithubEnv();
});
afterEach(() => env.close());

const types = (from = 0) => env.events.slice(from).map((e) => e.type);
const waitTick = () => new Promise((r) => setTimeout(r, 20));

describe("github auth", () => {
  it("reads the token from gh, reports the login and never exposes the token", async () => {
    const connection = await env.service.connection();
    expect(connection).toEqual({ connected: true, source: "gh", login: "octo", message: null });
    expect(JSON.stringify(connection)).not.toContain("tok-1");
  });

  it("falls back to the keychain token, then reports not connected", async () => {
    env.ghTokens = [""];
    await env.secrets.set("github.token", "tok-1");
    expect((await env.service.connection()).source).toBe("keychain");

    const other = createGithubEnv();
    other.ghTokens = [""];
    const state = await other.service.connection();
    expect(state.connected).toBe(false);
    expect(state.message).toContain("gh auth login");
    await expect(
      other.service.listIssues(P).then(() => other.service.getIssue(P, 1)),
    ).rejects.toMatchObject({
      code: "github_not_connected",
    });
    await other.close();
  });

  it("asks gh again after a 401 and retries with the new token", async () => {
    env.ghTokens = ["tok-old", "tok-1"];
    env.gh.addIssue({ title: "Bug" });
    const issue = await env.service.getIssue(P, 1);
    expect(issue.title).toBe("Bug");
    expect(env.gh.requests.filter((r) => r.status === 401)).toHaveLength(1);
  });
});

describe("github sync", () => {
  it("imports silently first, then uses ETags (304) and emits events for changes", async () => {
    const bug = env.gh.addIssue({ title: "Bug", labels: ["bug"] });
    env.gh.addPr("codeden/task-1", { body: "Fixes #1" });
    const session = env.addSession({ branch: "codeden/task-1" });

    await env.service.syncNow(P);
    expect(types()).toContain("github.synced");
    expect(types()).not.toContain("issue.opened");
    const prs = env.service.listPrs(P);
    expect(prs).toHaveLength(1);
    expect(prs[0]).toMatchObject({
      number: 2,
      sessionId: session.id,
      linkedIssues: [1],
      checks: { state: "none" },
    });
    expect((await env.service.listIssues(P))[0]).toMatchObject({ number: 1, labels: ["bug"] });

    // Nothing changed: the listing answers 304.
    const before = env.events.length;
    await env.service.syncNow(P);
    await env.service.syncNow(P);
    const listings = env.gh.requests.filter(
      (r) => r.path.endsWith("/issues") && r.method === "GET",
    );
    expect(listings.at(-1)?.status).toBe(304);
    expect(env.events.length).toBe(before);

    // A new issue, a label, and a check run on the session's PR.
    env.gh.addIssue({ title: "New" });
    env.gh.touch(bug.number, (i) => i.labels.push("ready"));
    env.gh.touch(2, (i) => {
      if (i.pr) i.pr.checks = [{ name: "ci", status: "IN_PROGRESS", conclusion: null }];
    });
    const mark = env.events.length;
    await env.service.syncNow(P);
    expect(types(mark)).toEqual(
      expect.arrayContaining(["issue.opened", "issue.labeled", "pr.updated"]),
    );
    const labeled = env.events.find((e) => e.type === "issue.labeled");
    expect(labeled?.payload).toMatchObject({ added: ["ready"] });

    // Checks finish green while the commit is unchanged (no updated_at bump): PR polled anyway.
    const pr = env.gh.issues.get(2);
    if (pr?.pr) pr.pr.checks = [{ name: "ci", status: "COMPLETED", conclusion: "SUCCESS" }];
    const mark2 = env.events.length;
    await env.service.syncNow(P);
    expect(types(mark2)).toEqual(["pr.checks_passed"]);
    expect(env.events.at(-1)?.sessionId).toBe(session.id);
  });

  it("emits review.submitted and pr.checks_failed", async () => {
    env.gh.addPr("feature/x");
    await env.service.syncNow(P);
    env.gh.touch(1, (i) => {
      if (!i.pr) return;
      i.pr.headSha = "sha-2";
      i.pr.checks = [{ name: "ci", status: "COMPLETED", conclusion: "FAILURE" }];
      i.pr.reviews = [
        {
          id: "r1",
          author: "lee",
          state: "CHANGES_REQUESTED",
          body: "Fix it",
          submittedAt: "2026-11-01T01:00:00Z",
        },
      ];
    });
    const mark = env.events.length;
    await env.service.syncNow(P);
    expect(types(mark)).toEqual(["review.submitted", "pr.checks_failed", "pr.updated"]);
    const pr = env.service.listPrs(P)[0];
    expect(pr).toMatchObject({
      reviewDecision: "changes_requested",
      checks: { state: "failure", failed: 1 },
    });
  });

  it("marks the session done and links back to the issue when its PR merges", async () => {
    env.gh.addIssue({ title: "Bug" });
    const session = env.addSession({
      branch: "codeden/fix",
      issue: { number: 1, url: "https://github.com/acme/widgets/issues/1" },
    });
    env.gh.addPr("codeden/fix", { body: "Fixes #1" });
    await env.service.syncNow(P);
    env.service.start({ sync: false });

    const merged = await env.service.mergePr(`${P}:2`, { method: "squash" });
    expect(merged).toEqual({ merged: true, sha: "merge-sha" });
    const mergeCall = env.gh.requests.find((r) => r.path.endsWith("/pulls/2/merge"));
    expect(mergeCall?.body).toMatchObject({ merge_method: "squash" });
    expect(types()).toContain("pr.merged");

    for (let i = 0; i < 50 && env.repo.get(session.id).status !== "completed"; i++)
      await waitTick();
    await waitTick();
    const after = env.repo.get(session.id);
    expect(after.status).toBe("completed");
    expect(after.pr).toMatchObject({ number: 2, state: "merged" });
    expect(env.runnerCalls.some((c) => c.name === "session.stop")).toBe(true);
    expect(env.gh.issues.get(1)?.comments.at(-1)?.body).toContain("Resolved by #2");
  });

  it("links a session started on a PR's branch before the first import", async () => {
    const session = env.addSession({ branch: "codeden/early" });
    env.gh.addPr("codeden/early");
    env.service.start({ sync: false });
    await env.service.syncNow(P);
    expect(types()).toEqual(expect.arrayContaining(["github.synced", "pr.updated"]));
    for (let i = 0; i < 50 && !env.repo.get(session.id).pr; i++) await waitTick();
    expect(env.repo.get(session.id).pr).toMatchObject({ number: 1, state: "open" });
    await waitTick();
    expect(env.inbox.find(`inbox:pr_review:${P}:1`)).toMatchObject({
      kind: "pr_review",
      sessionId: session.id,
      status: "open",
    });
  });

  it("links an open PR on the next poll once a session starts on its branch", async () => {
    env.gh.addPr("feature/late");
    await env.service.syncNow(P);
    expect(env.service.listPrs(P)[0]?.sessionId).toBeNull();
    env.service.start({ sync: false });
    const session = env.addSession({ branch: "feature/late" });
    const mark = env.events.length;
    await env.service.syncNow(P); // poll 1: not one of the every-4th full refreshes
    expect(env.service.listPrs(P)[0]?.sessionId).toBe(session.id);
    expect(types(mark)).toContain("pr.updated");
    for (let i = 0; i < 50 && !env.repo.get(session.id).pr; i++) await waitTick();
    expect(env.repo.get(session.id).pr).toMatchObject({ number: 1 });
  });

  it("emits issue.commented with the new comments and pr.review_requested", async () => {
    env.gh.addIssue({ title: "Bug" });
    env.gh.addPr("feature/r");
    await env.service.syncNow(P);
    env.gh.touch(1, (i) =>
      i.comments.push({ id: 7, body: "Still broken on Windows", author: "lee", createdAt: "x" }),
    );
    env.gh.touch(2, (i) => {
      if (i.pr) i.pr.requestedReviewers = ["lee"];
    });
    const mark = env.events.length;
    await env.service.syncNow(P);
    const commented = env.events.slice(mark).find((e) => e.type === "issue.commented");
    expect(commented?.payload).toMatchObject({
      issue: { number: 1, comments: 1 },
      comments: [{ id: 7, author: "lee", body: "Still broken on Windows", fromCodeden: false }],
    });
    const requested = env.events.slice(mark).find((e) => e.type === "pr.review_requested");
    expect(requested?.payload).toMatchObject({ reviewers: ["lee"], pr: { number: 2 } });
    expect(env.service.listPrs(P)[0]?.requestedReviewers).toEqual(["lee"]);

    // CodeDen's own comments carry a hidden marker and are flagged.
    await env.service.commentOnIssue(P, 1, "Triage: ready");
    const mark2 = env.events.length;
    await env.service.syncNow(P);
    const own = env.events.slice(mark2).find((e) => e.type === "issue.commented");
    expect(own?.payload).toMatchObject({ comments: [{ fromCodeden: true }] });
    expect(types(mark2)).not.toContain("pr.review_requested");
  });

  it("backs off on rate limits", async () => {
    env.gh.rateLimited = true;
    await expect(env.service.syncNow(P)).rejects.toBeInstanceOf(GithubRateLimitError);
    const status = env.service.sync.status(P);
    expect(status.lastError).toContain("rate limit");
    expect(Date.parse(status.nextSyncAt ?? "") - Date.now()).toBeGreaterThan(60_000);
  });
});

describe("local-only projects", () => {
  it("degrades cleanly", async () => {
    await expect(env.service.listIssues("p-local")).rejects.toMatchObject({
      code: "not_a_github_project",
    });
    const res = await env.service.issuesResponse("p-local", "open", 10);
    expect(res).toMatchObject({ connection: { connected: false }, sync: null, issues: [] });
    const session = env.addSession({ projectId: "p-local" });
    await expect(env.service.createPullRequest(session.id, { title: "x" })).rejects.toMatchObject({
      status: 409,
      code: "not_a_github_project",
    });
    expect((await env.service.sessionGithub(session.id)).connection.message).toContain(
      "Local-only",
    );
    expect(env.gh.requests).toHaveLength(0);
  });

  it("imports a project that became a GitHub project right away", async () => {
    env.gh.addIssue({ title: "Already there" });
    env.service.start();
    await waitFor(() => types().includes("github.synced"));
    const synced = () =>
      env.events.filter(
        (e) =>
          e.type === "github.synced" &&
          (e.payload as { projectId: string }).projectId === "p-local",
      );
    expect(synced()).toHaveLength(0);

    // Re-detection found the same GitHub origin in the local project's folder.
    const { github } = env.githubProject as Extract<Project, { kind: "github" }>;
    const project: Project = { ...env.localProject, kind: "github", github };
    env.store.append([{ type: "project.updated", sessionId: null, payload: { project } }]);
    env.service.sync.soon("p-local", { now: true });
    // Well before the next 5 s scheduler tick.
    await waitFor(() => synced().length === 1, 2_000);
    await expect(env.service.listIssues("p-local")).resolves.toHaveLength(1);
  });
});

describe("github issue labels", () => {
  // A PM reported `list_issues` answering with none of the labels GitHub had applied to an
  // issue, while `list_issues` with a label filter did show them. Both reads come out of one
  // projection table, so this pins them (and the live issue, and the table itself) agreeing as
  // labels arrive from GitHub, from CodeDen, and from a removal upstream.
  it("answers every read path with the same labels", async () => {
    const issue = env.gh.addIssue({ title: "Flaky test", labels: ["P0", "reliability"] });
    await env.service.syncNow(P);

    const sorted = (labels: string[] | undefined) => [...(labels ?? [])].sort();
    const read = async () => ({
      projection: sorted(
        env.service.data.issues(P, "all").find((i) => i.number === issue.number)?.labels,
      ),
      unfiltered: sorted(
        (await env.service.listIssues(P)).find((i) => i.number === issue.number)?.labels,
      ),
      filtered: sorted(
        (await env.service.listIssues(P, { labels: ["reliability"] })).find(
          (i) => i.number === issue.number,
        )?.labels,
      ),
      live: sorted((await env.service.getIssue(P, issue.number)).labels),
    });

    const all = (...labels: string[]) => ({
      projection: sorted(labels),
      unfiltered: sorted(labels),
      filtered: sorted(labels),
      live: sorted(labels),
    });

    expect(await read()).toEqual(all("P0", "reliability"));

    // A label applied by hand on GitHub reaches every path on the next poll.
    env.gh.touch(issue.number, (i) => i.labels.push("factory:hold"));
    const mark = env.events.length;
    await env.service.syncNow(P);
    expect(types(mark)).toContain("issue.labeled");
    expect(await read()).toEqual(all("P0", "reliability", "factory:hold"));

    // CodeDen adding one label keeps the ones GitHub owns: `addLabels`/`removeLabel`, never a
    // replacement of the whole set.
    await env.service.labelIssue(P, issue.number, { add: ["codeden:in-progress"], remove: [] });
    expect(await read()).toEqual(all("P0", "reliability", "factory:hold", "codeden:in-progress"));

    // And a label removed on GitHub drops out everywhere - a label change is an
    // `issue.updated` carrying the full set, not an `issue.unlabeled`.
    env.gh.touch(issue.number, (i) => {
      i.labels = i.labels.filter((l) => l !== "P0");
    });
    const mark2 = env.events.length;
    await env.service.syncNow(P);
    expect(types(mark2)).toEqual(["issue.updated"]);
    expect(await read()).toEqual(all("reliability", "factory:hold", "codeden:in-progress"));
    expect(
      (await env.service.listIssues(P, { labels: ["P0"] })).find((i) => i.number === issue.number),
    ).toBeUndefined();
  });
});

async function waitFor(probe: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!probe()) {
    if (Date.now() > deadline) throw new Error("timed out");
    await waitTick();
  }
}

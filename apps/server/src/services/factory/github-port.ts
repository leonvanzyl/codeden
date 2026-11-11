import {
  type ChecksState,
  type GitHubIssueRef,
  type GitHubPrRef,
  type GithubIssue,
  githubPrId,
} from "@codeden/contracts";
import { errorMessage } from "../errors";
import { EVIDENCE_HEADING } from "../github/evidence";
import type { GithubService } from "../github/github-service";

/** A pull request as the merge checks read it. */
export interface FactoryPr {
  ref: GitHubPrRef;
  title: string;
  body: string;
  headSha: string | null;
  headBranch: string;
  /** Combined state of CI on the head commit. */
  checks: ChecksState;
  failedChecks: string[];
  additions: number;
  deletions: number;
  files: string[];
  /** Added + deleted lines per file, when GitHub reports them. */
  fileLines?: Array<{ path: string; lines: number }>;
}

/** Commit-level CI state, for watching main after a merge. */
export type CommitChecks = ChecksState;

/** Evidence attached to a PR (or its issue) through `attach_evidence`. */
export interface PrEvidence {
  /** Screenshots or other images. */
  screenshots: boolean;
  /** Raw test output (`attach_evidence` with `testOutput`). */
  testOutput: boolean;
}

/**
 * What the factory needs from GitHub (§9), as a port so tests can run the loop against a
 * scripted GitHub. `GithubFactoryPort` implements it over `GithubService`.
 */
export interface FactoryGithub {
  isGithubProject(projectId: string): boolean;
  /** The login of the account CodeDen uses on GitHub (always trusted); null when unknown. */
  viewerLogin(): Promise<string | null>;
  createIssue(
    projectId: string,
    req: { title: string; body: string; labels: string[] },
  ): Promise<GitHubIssueRef>;
  labelIssue(projectId: string, number: number, labels: string[]): Promise<void>;
  comment(projectId: string, number: number, body: string): Promise<void>;
  /** Open issues (projection), for intake. */
  openIssues(projectId: string): GithubIssue[];
  /** One issue from the projection (open or closed); null when it was never synced. */
  issue(projectId: string, number: number): GithubIssue | null;
  /** A PR as last synced (projection, no API call); null when unknown. */
  prRef(projectId: string, number: number): GitHubPrRef | null;
  /** The PR a session opened (or whose head is its branch), if known. */
  prForSession(projectId: string, sessionId: string, branch: string | null): GitHubPrRef | null;
  prDetails(projectId: string, number: number): Promise<FactoryPr>;
  /** Screenshots and test output attached to the PR (or its issue) with `attach_evidence`. */
  evidence(projectId: string, prNumber: number, issueNumber: number | null): Promise<PrEvidence>;
  merge(
    projectId: string,
    number: number,
    opts: { sha: string | null; title: string },
  ): Promise<{ merged: boolean; sha: string | null }>;
  commitChecks(projectId: string, sha: string): Promise<CommitChecks>;
  /** Head of the default branch and its CI state. */
  mainHead(projectId: string): Promise<{ sha: string; checks: CommitChecks; failed: string[] }>;
  /**
   * Open a PR reverting a squash merge when it is still the head of the default branch;
   * null when main moved on (the loop then asks an agent to write the revert).
   */
  revertMerge(
    projectId: string,
    merge: { sha: string; prNumber: number; title: string },
  ): Promise<GitHubPrRef | null>;
  /**
   * Commit the vision file to the `codeden/vision` branch (from the default branch, or on top
   * of its open PR) and open or update that PR. Null when the file already matches.
   */
  shareVision(projectId: string, path: string, contents: string): Promise<GitHubPrRef | null>;
}

/** Branch the vision editor commits to. */
export const VISION_BRANCH = "codeden/vision";

const IMAGE_LINK = /\.(png|jpe?g|gif|webp)\?raw=true/i;
const TEST_OUTPUT = /<summary>Test output<\/summary>/i;
const LOGIN_TTL_MS = 10 * 60_000;

/** `FactoryGithub` over the real `GithubService` (Octokit, the PR/issue projections). */
export class GithubFactoryPort implements FactoryGithub {
  private login: { value: string | null; at: number } | null = null;

  constructor(private readonly github: GithubService) {}

  async viewerLogin(): Promise<string | null> {
    if (this.login && Date.now() - this.login.at < LOGIN_TTL_MS) return this.login.value;
    const value = await this.github
      .connection()
      .then((c) => c.login)
      .catch(() => null);
    // Remember a failure only briefly, so trust comes back as soon as GitHub does.
    this.login = { value, at: value ? Date.now() : Date.now() - LOGIN_TTL_MS + 30_000 };
    return value;
  }

  isGithubProject(projectId: string): boolean {
    try {
      this.github.githubRepo(projectId);
      return true;
    } catch {
      return false;
    }
  }

  async createIssue(projectId: string, req: { title: string; body: string; labels: string[] }) {
    const issue = await this.github.createIssue(projectId, req);
    return { number: issue.number, url: issue.url, title: issue.title };
  }

  async labelIssue(projectId: string, number: number, labels: string[]): Promise<void> {
    await this.github.labelIssue(projectId, number, { add: labels, remove: [] });
  }

  async comment(projectId: string, number: number, body: string): Promise<void> {
    await this.github.commentOnIssue(projectId, number, body);
  }

  openIssues(projectId: string): GithubIssue[] {
    return this.github.data.issues(projectId, "open", 200);
  }

  issue(projectId: string, number: number): GithubIssue | null {
    return this.github.data.issue(projectId, number) ?? null;
  }

  prRef(projectId: string, number: number): GitHubPrRef | null {
    const pr = this.github.data.pr(projectId, number);
    return pr ? { number: pr.number, url: pr.url, state: pr.state, title: pr.title } : null;
  }

  prForSession(projectId: string, sessionId: string, branch: string | null): GitHubPrRef | null {
    const pr = this.github.data
      .prs(projectId, "all", 200)
      .find((p) => p.sessionId === sessionId || (branch !== null && p.headBranch === branch));
    return pr ? { number: pr.number, url: pr.url, state: pr.state, title: pr.title } : null;
  }

  async prDetails(projectId: string, number: number): Promise<FactoryPr> {
    const pr = await this.github.getPrDetails(githubPrId(projectId, number));
    return {
      ref: { number: pr.number, url: pr.url, state: pr.state, title: pr.title },
      title: pr.title,
      body: pr.body,
      headSha: pr.headSha,
      headBranch: pr.headBranch,
      checks: pr.checks.state,
      failedChecks: pr.checks.checks
        .filter((c) => c.conclusion && !["success", "neutral", "skipped"].includes(c.conclusion))
        .map((c) => c.name),
      additions: pr.additions,
      deletions: pr.deletions,
      files: pr.files.map((f) => f.path),
      fileLines: pr.files.map((f) => ({ path: f.path, lines: f.additions + f.deletions })),
    };
  }

  async evidence(
    projectId: string,
    prNumber: number,
    issueNumber: number | null,
  ): Promise<PrEvidence> {
    const repo = this.github.githubRepo(projectId);
    const found: PrEvidence = { screenshots: false, testOutput: false };
    const viewer = (await this.viewerLogin())?.toLowerCase() ?? null;
    for (const number of [prNumber, ...(issueNumber ? [issueNumber] : [])]) {
      const comments = await this.github.client.run(async (o) =>
        o.paginate(o.rest.issues.listComments, {
          owner: repo.owner,
          repo: repo.repo,
          issue_number: number,
          per_page: 100,
        }),
      );
      // Only CodeDen's own evidence comments count (anyone can comment on a public repo).
      for (const c of comments) {
        const body = c.body ?? "";
        if (!body.startsWith(EVIDENCE_HEADING)) continue;
        if (viewer && c.user?.login?.toLowerCase() !== viewer) continue;
        if (IMAGE_LINK.test(body)) found.screenshots = true;
        if (TEST_OUTPUT.test(body)) found.testOutput = true;
      }
      if (found.screenshots && found.testOutput) break;
    }
    return found;
  }

  async merge(projectId: string, number: number, opts: { sha: string | null; title: string }) {
    return this.github.mergePr(githubPrId(projectId, number), {
      method: "squash",
      ...(opts.sha ? { sha: opts.sha } : {}),
      commitTitle: opts.title,
    });
  }

  async commitChecks(projectId: string, sha: string): Promise<CommitChecks> {
    return (await this.checksFor(projectId, sha)).state;
  }

  async mainHead(projectId: string) {
    const repo = this.github.githubRepo(projectId);
    const branch = await this.github.client.run(
      async (o) =>
        (
          await o.rest.repos.getBranch({
            owner: repo.owner,
            repo: repo.repo,
            branch: repo.defaultBranch,
          })
        ).data,
    );
    const { state, failed } = await this.checksFor(projectId, branch.commit.sha);
    return { sha: branch.commit.sha, checks: state, failed };
  }

  async shareVision(projectId: string, path: string, contents: string) {
    const { owner, repo: name, defaultBranch } = this.github.githubRepo(projectId);
    const ref = (pr: { number: number; html_url: string; title: string }): GitHubPrRef => ({
      number: pr.number,
      url: pr.html_url,
      state: "open",
      title: pr.title,
    });
    const result = await this.github.client.run(async (o) => {
      const open = (
        await o.rest.pulls.list({
          owner,
          repo: name,
          head: `${owner}:${VISION_BRANCH}`,
          state: "open",
          per_page: 1,
        })
      ).data[0];
      const parentRef = open ? `heads/${VISION_BRANCH}` : `heads/${defaultBranch}`;
      const parent = (await o.rest.git.getRef({ owner, repo: name, ref: parentRef })).data.object
        .sha;
      const parentTree = (await o.rest.git.getCommit({ owner, repo: name, commit_sha: parent }))
        .data.tree.sha;
      const tree = await o.rest.git.createTree({
        owner,
        repo: name,
        base_tree: parentTree,
        tree: [{ path, mode: "100644", type: "blob", content: contents }],
      });
      if (tree.data.sha === parentTree) return open ? ref(open) : null;
      const commit = await o.rest.git.createCommit({
        owner,
        repo: name,
        message: "docs: update the project vision\n\nSaved from the CodeDen vision editor.",
        tree: tree.data.sha,
        parents: [parent],
      });
      if (open) {
        await o.rest.git.updateRef({
          owner,
          repo: name,
          ref: `heads/${VISION_BRANCH}`,
          sha: commit.data.sha,
        });
        return ref(open);
      }
      // A stale branch from a merged or closed vision PR is reset onto the new commit.
      await o.rest.git
        .createRef({ owner, repo: name, ref: `refs/heads/${VISION_BRANCH}`, sha: commit.data.sha })
        .catch(() =>
          o.rest.git.updateRef({
            owner,
            repo: name,
            ref: `heads/${VISION_BRANCH}`,
            sha: commit.data.sha,
            force: true,
          }),
        );
      const pr = await o.rest.pulls.create({
        owner,
        repo: name,
        head: VISION_BRANCH,
        base: defaultBranch,
        title: "Update the project vision",
        body: `Commits \`${path}\`, saved from the CodeDen vision editor. The factory reads the vision from the local checkout right away; merging this shares it with agent worktrees, which start from \`${defaultBranch}\`.`,
      });
      return ref(pr.data);
    });
    this.github.sync.soon(projectId);
    return result;
  }

  async revertMerge(projectId: string, merge: { sha: string; prNumber: number; title: string }) {
    const repo = this.github.githubRepo(projectId);
    const { owner, repo: name, defaultBranch } = repo;
    return this.github.client.run(async (o) => {
      const head = (await o.rest.git.getRef({ owner, repo: name, ref: `heads/${defaultBranch}` }))
        .data.object.sha;
      if (head !== merge.sha) return null;
      const commit = (await o.rest.git.getCommit({ owner, repo: name, commit_sha: merge.sha }))
        .data;
      const parent = commit.parents[0]?.sha;
      if (!parent || commit.parents.length !== 1) return null;
      const parentTree = (await o.rest.git.getCommit({ owner, repo: name, commit_sha: parent }))
        .data.tree.sha;
      const revert = await o.rest.git.createCommit({
        owner,
        repo: name,
        message: `Revert "${merge.title}" (#${merge.prNumber})\n\nAutomatic revert by the CodeDen factory: CI on ${defaultBranch} failed after the merge.`,
        tree: parentTree,
        parents: [merge.sha],
      });
      const branch = `codeden/revert-${merge.prNumber}-${merge.sha.slice(0, 7)}`;
      await o.rest.git.createRef({
        owner,
        repo: name,
        ref: `refs/heads/${branch}`,
        sha: revert.data.sha,
      });
      const pr = await o.rest.pulls.create({
        owner,
        repo: name,
        head: branch,
        base: defaultBranch,
        title: `Revert "${merge.title}"`,
        body: `Reverts #${merge.prNumber} (${merge.sha}).\n\nCI on \`${defaultBranch}\` failed after the merge, so the CodeDen factory opened this revert and paused its loop. It goes through the same merge checks.`,
      });
      this.github.sync.soon(projectId);
      return {
        number: pr.data.number,
        url: pr.data.html_url,
        state: "open" as const,
        title: pr.data.title,
      };
    });
  }

  private async checksFor(
    projectId: string,
    sha: string,
  ): Promise<{ state: CommitChecks; failed: string[] }> {
    const repo = this.github.githubRepo(projectId);
    try {
      return await this.github.client.run(async (o) => {
        const [combined, runs] = await Promise.all([
          o.rest.repos.getCombinedStatusForRef({ owner: repo.owner, repo: repo.repo, ref: sha }),
          o.rest.checks.listForRef({ owner: repo.owner, repo: repo.repo, ref: sha, per_page: 100 }),
        ]);
        const states: Array<{ name: string; state: "success" | "failure" | "pending" }> = [
          ...combined.data.statuses.map((s) => ({
            name: s.context,
            state:
              s.state === "success"
                ? ("success" as const)
                : s.state === "pending"
                  ? ("pending" as const)
                  : ("failure" as const),
          })),
          ...runs.data.check_runs.map((r) => ({
            name: r.name,
            state:
              r.status !== "completed"
                ? ("pending" as const)
                : ["success", "neutral", "skipped"].includes(r.conclusion ?? "")
                  ? ("success" as const)
                  : ("failure" as const),
          })),
        ];
        const failed = states.filter((s) => s.state === "failure").map((s) => s.name);
        if (states.length === 0) return { state: "none" as const, failed };
        if (failed.length > 0) return { state: "failure" as const, failed };
        if (states.some((s) => s.state === "pending")) return { state: "pending" as const, failed };
        return { state: "success" as const, failed };
      });
    } catch (error) {
      throw new Error(`checks for ${sha.slice(0, 7)}: ${errorMessage(error)}`);
    }
  }
}

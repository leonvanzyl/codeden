import type {
  ChecksState,
  GitHubIssueRef,
  GitHubPrRef,
  GithubAuthorAssociation,
  GithubIssue,
} from "@codeden/contracts";
import type {
  CommitChecks,
  FactoryGithub,
  FactoryPr,
  IssueAuthor,
  PrEvidence,
} from "../../src/services/factory/github-port";

/** A pull request in the scripted GitHub. */
export interface FakePr extends FactoryPr {
  sessionId: string | null;
  /** Screenshots attached with `attach_evidence`. */
  evidence: boolean;
  /** Test output attached with `attach_evidence`. */
  testOutput: boolean;
  /** The default branch's head the PR's branch is based on (behind once main moves). */
  baseSha: string;
}

/**
 * A scripted GitHub for the factory loop: issues, PRs (linked to sessions), CI states, merges,
 * comments and reverts, all in memory. Tests change `prs`/`commitState` to steer the loop.
 */
export class FakeFactoryGithub implements FactoryGithub {
  issues: GithubIssue[] = [];
  prs = new Map<number, FakePr>();
  comments: Array<{ number: number; body: string }> = [];
  merges: Array<{ number: number; sha: string | null; title: string }> = [];
  reverts: Array<{ sha: string; prNumber: number }> = [];
  /** CI state per commit sha (default success). */
  commitState = new Map<string, CommitChecks>();
  main = { sha: "main0000000", checks: "success" as ChecksState, failed: [] as string[] };
  githubProjects = new Set<string>();
  /** When false, `revertMerge` returns null (main moved on). */
  canRevertViaApi = true;
  /** The account CodeDen uses on GitHub (always trusted); null: unknown. */
  viewer: string | null = "codeden";
  /** `update-branch` calls, in order. */
  updates: Array<{ number: number; expectedHeadSha: string }> = [];
  /** PRs closed through `closePr`, with their comment. */
  closed: Array<{ number: number; comment: string }> = [];
  /** `closePr` calls, refused ones included. */
  closeAttempts = 0;
  /** How many more `closePr` calls GitHub refuses (a transient error). */
  closeFailures = 0;
  /** CI state of the new head an `update-branch` makes (it starts running). */
  ciAfterUpdate: ChecksState = "pending";
  /** What `actionsAvailable` answers. */
  actions: boolean | null = true;
  /** Issue authors' relation to the repository by issue number (default `none`). */
  associations = new Map<number, GithubAuthorAssociation>();
  private next = 100;

  async viewerLogin(): Promise<string | null> {
    return this.viewer;
  }

  async issueAuthor(projectId: string, number: number): Promise<IssueAuthor> {
    return {
      login: this.issue(projectId, number)?.author ?? null,
      association: this.associations.get(number) ?? "none",
    };
  }

  /** An issue opened on GitHub by `author` (what the sync would project). */
  openIssue(opts: {
    projectId: string;
    title: string;
    author: string | null;
    body?: string;
    labels?: string[];
  }): GithubIssue {
    const number = this.next++;
    const now = new Date().toISOString();
    const issue: GithubIssue = {
      projectId: opts.projectId,
      number,
      title: opts.title,
      state: "open",
      url: `https://github.com/acme/app/issues/${number}`,
      labels: opts.labels ?? [],
      author: opts.author,
      body: opts.body ?? null,
      comments: 0,
      createdAt: now,
      updatedAt: now,
      closedAt: null,
      sessionIds: [],
    };
    this.issues.push(issue);
    return issue;
  }

  issue(_projectId: string, number: number): GithubIssue | null {
    return this.issues.find((i) => i.number === number) ?? null;
  }

  prRef(_projectId: string, number: number): GitHubPrRef | null {
    return this.prs.get(number)?.ref ?? null;
  }

  isGithubProject(projectId: string): boolean {
    return this.githubProjects.has(projectId);
  }

  async createIssue(
    projectId: string,
    req: { title: string; body: string; labels: string[] },
  ): Promise<GitHubIssueRef> {
    const number = this.next++;
    const url = `https://github.com/acme/app/issues/${number}`;
    const now = new Date().toISOString();
    this.issues.push({
      projectId,
      number,
      title: req.title,
      state: "open",
      url,
      labels: req.labels,
      author: "codeden",
      body: req.body,
      comments: 0,
      createdAt: now,
      updatedAt: now,
      closedAt: null,
      sessionIds: [],
    });
    return { number, url, title: req.title };
  }

  async labelIssue(_projectId: string, number: number, labels: string[]): Promise<void> {
    const issue = this.issues.find((i) => i.number === number);
    if (issue) issue.labels = [...new Set([...issue.labels, ...labels])];
  }

  async comment(_projectId: string, number: number, body: string): Promise<void> {
    this.comments.push({ number, body });
  }

  openIssues(projectId: string): GithubIssue[] {
    return this.issues.filter((i) => i.projectId === projectId && i.state === "open");
  }

  /** Open a PR for a session (what `create_pull_request` would do). */
  openPr(opts: {
    sessionId: string | null;
    title: string;
    files: string[];
    additions?: number;
    deletions?: number;
    /** Lines per file; the size check counts these (minus lockfiles) when given. */
    fileLines?: Array<{ path: string; lines: number }>;
    checks?: ChecksState;
    /** Default: mergeable. */
    mergeable?: FactoryPr["mergeable"];
    evidence?: boolean;
    testOutput?: boolean;
    /** Default: a description with a `## Test results` section. */
    body?: string;
  }): FakePr {
    const number = this.next++;
    const ref: GitHubPrRef = {
      number,
      url: `https://github.com/acme/app/pull/${number}`,
      state: "open",
      title: opts.title,
    };
    const pr: FakePr = {
      ref,
      title: opts.title,
      body: opts.body ?? "Fixes the issue\n\n## Test results\n- `pnpm test`: passed",
      headSha: `head${number}`,
      headBranch: `codeden/pr-${number}`,
      checks: opts.checks ?? "success",
      failedChecks: opts.checks === "failure" ? ["test"] : [],
      mergeable: opts.mergeable ?? "mergeable",
      additions: opts.additions ?? 20,
      deletions: opts.deletions ?? 2,
      files: opts.files,
      ...(opts.fileLines ? { fileLines: opts.fileLines } : {}),
      sessionId: opts.sessionId,
      evidence: opts.evidence ?? false,
      testOutput: opts.testOutput ?? false,
      baseSha: this.main.sha,
    };
    this.prs.set(number, pr);
    return pr;
  }

  /** What a rebase by an agent does: a new head on the current main, without conflicts. */
  rebase(pr: FakePr, headSha: string, checks: ChecksState = "success"): void {
    Object.assign(pr, { headSha, baseSha: this.main.sha, mergeable: "mergeable", checks });
  }

  async behindBy(_projectId: string, number: number): Promise<number> {
    const pr = this.prs.get(number);
    if (!pr) throw new Error(`no PR ${number}`);
    return pr.baseSha === this.main.sha ? 0 : 1;
  }

  async updateBranch(_projectId: string, number: number, expectedHeadSha: string): Promise<void> {
    const pr = this.prs.get(number);
    if (!pr) throw new Error(`no PR ${number}`);
    if (pr.headSha !== expectedHeadSha)
      throw new Error("expected head sha didn't match current head");
    if (pr.mergeable === "conflicting") throw new Error("merge conflict between base and head");
    this.updates.push({ number, expectedHeadSha });
    Object.assign(pr, {
      headSha: `${pr.headSha}-up${this.updates.length}`,
      baseSha: this.main.sha,
      checks: this.ciAfterUpdate,
    });
  }

  async closePr(_projectId: string, number: number, comment: string): Promise<void> {
    const pr = this.prs.get(number);
    if (!pr) throw new Error(`no PR ${number}`);
    this.closeAttempts++;
    if (this.closeFailures > 0) {
      this.closeFailures--;
      throw new Error("GitHub is having a moment (502)");
    }
    this.comments.push({ number, body: comment });
    this.closed.push({ number, comment });
    pr.ref = { ...pr.ref, state: "closed" };
  }

  async actionsAvailable(): Promise<boolean | null> {
    return this.actions;
  }

  prForSession(_projectId: string, sessionId: string, branch: string | null): GitHubPrRef | null {
    return (
      [...this.prs.values()].find(
        (p) => p.sessionId === sessionId || (branch !== null && p.headBranch === branch),
      )?.ref ?? null
    );
  }

  async prDetails(_projectId: string, number: number): Promise<FactoryPr> {
    const pr = this.prs.get(number);
    if (!pr) throw new Error(`no PR ${number}`);
    return { ...pr, ref: { ...pr.ref }, files: [...pr.files] };
  }

  async evidence(_projectId: string, prNumber: number): Promise<PrEvidence> {
    const pr = this.prs.get(prNumber);
    return { screenshots: pr?.evidence ?? false, testOutput: pr?.testOutput ?? false };
  }

  async merge(_projectId: string, number: number, opts: { sha: string | null; title: string }) {
    const pr = this.prs.get(number);
    if (!pr) throw new Error(`no PR ${number}`);
    // Like GitHub: a merge pinned to a head that moved is refused.
    if (opts.sha && opts.sha !== pr.headSha) throw new Error("Head branch was modified");
    pr.ref = { ...pr.ref, state: "merged" };
    const sha = `merge${number}`;
    this.merges.push({ number, sha, title: opts.title });
    this.main.sha = sha;
    return { merged: true, sha };
  }

  async commitChecks(_projectId: string, sha: string): Promise<CommitChecks> {
    return this.commitState.get(sha) ?? "success";
  }

  async mainHead() {
    return { ...this.main };
  }

  visionCommits: Array<{ path: string; contents: string }> = [];
  visionPr: GitHubPrRef | null = null;
  async shareVision(_projectId: string, path: string, contents: string) {
    const last = this.visionCommits.at(-1);
    if (last?.contents === contents) return this.visionPr;
    this.visionCommits.push({ path, contents });
    this.visionPr ??= {
      number: 900,
      url: "https://github.com/acme/widgets/pull/900",
      state: "open",
      title: "Update the project vision",
    };
    return this.visionPr;
  }

  async revertMerge(_projectId: string, merge: { sha: string; prNumber: number; title: string }) {
    if (!this.canRevertViaApi) return null;
    this.reverts.push({ sha: merge.sha, prNumber: merge.prNumber });
    const pr = this.openPr({
      sessionId: null,
      title: `Revert "${merge.title}"`,
      files: ["src/app.ts", "test/app.test.ts"],
    });
    return pr.ref;
  }
}

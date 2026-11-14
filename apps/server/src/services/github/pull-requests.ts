import {
  type GitCredential,
  type GitHubRepo,
  GithubPr,
  githubPrId,
  type Session,
} from "@codeden/contracts";
import type { EventStore } from "../../events/store";
import { badRequest, conflict, notFound } from "../errors";
import { type GitBroker, githubCloneUrl } from "../git-broker";
import { type RunnerDeps, type RunnerPort, runnerForSession, toServiceError } from "../runner-port";
import { ownBranch } from "../sessions/own-branch";
import type { SessionRepo } from "../sessions/repo";
import { sessionWorkdir } from "../sessions/workdir";
import type { GithubClient } from "./client";
import { diffPr } from "./diff";
import { fetchPullRequests, toGithubPr } from "./graphql";
import type { GithubStore } from "./store";

/** What `create_pull_request` asks for. */
export interface CreatePullRequestInput {
  title: string;
  /** Markdown description; the issue link and session footer are added. */
  body?: string;
  /** Open as a draft (new PRs only). */
  draft?: boolean;
  /** Target branch; default the session's base branch, then the repository default. */
  base?: string;
  /** Issue the PR resolves (`Fixes #N`); default the session's issue. */
  issue?: number;
  /** Commit uncommitted changes with this message before pushing. */
  commitMessage?: string;
}

export interface CreatePullRequestResult {
  number: number;
  url: string;
  state: GithubPr["state"];
  created: boolean;
  branch: string;
  base: string;
  commit: string | null;
}

export interface PullRequestDeps extends RunnerDeps {
  client: GithubClient;
  store: GithubStore;
  events: EventStore;
  repo: SessionRepo;
  /** Brokers the push credential for a runner that doesn't share this disk (§9.2). */
  git?: GitBroker;
}

const SESSION_MARKER = "<!-- codeden:session=";

/** The PR body: the agent's text, `Fixes #N`, and a footer naming the CodeDen session. */
export function pullRequestBody(text: string, issue: number | null, session: Session): string {
  const parts = [text.trim()];
  if (
    issue &&
    !new RegExp(`\\b(?:fix(?:e[sd])?|close[sd]?|resolve[sd]?)\\s+#${issue}\\b`, "i").test(text)
  ) {
    parts.push(`Fixes #${issue}`);
  }
  const label = session.title ? `${session.title} (\`${session.id}\`)` : `\`${session.id}\``;
  parts.push(
    `---\n<sub>Opened by CodeDen session ${label}</sub>\n${SESSION_MARKER}${session.id} -->`,
  );
  return parts.filter(Boolean).join("\n\n");
}

/** git's answer when a push would rewrite the remote branch's history. */
const NOT_FAST_FORWARD = /\((non-fast-forward|fetch first)\)|updates were rejected/i;

/**
 * Push the session's branch. When the session owns it (its own worktree's branch) and the push
 * is rejected as not a fast-forward, as after a rebase, push again with a lease: that rewrites
 * only the session's own work, and refuses if someone else pushed there since.
 */
async function pushBranch(
  runner: RunnerPort,
  session: Session,
  cwd: string,
  branch: string,
  credential: GitCredential | undefined,
): Promise<void> {
  const push = {
    name: "git.push",
    cwd,
    branch,
    setUpstream: true,
    ...(credential ? { credential } : {}),
  } as const;
  try {
    await runner.request(push, 5 * 60_000);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (ownBranch(session) !== branch || !NOT_FAST_FORWARD.test(message)) throw error;
    await runner.request({ ...push, forceWithLease: true }, 5 * 60_000);
  }
}

/**
 * Push the session's branch through its runner and open (or update) its pull request (§8.2,
 * §9). The PR is projected right away (`pr.opened` / `pr.updated`) and linked to the session.
 */
export async function createPullRequest(
  deps: PullRequestDeps,
  session: Session,
  repo: GitHubRepo,
  input: CreatePullRequestInput,
): Promise<CreatePullRequestResult> {
  const cwd = sessionWorkdir(session);
  const branch = session.branch;
  if (!branch)
    throw conflict("This session has no branch to open a pull request from", "no_branch");
  const base = input.base ?? session.baseBranch ?? repo.defaultBranch;
  if (branch === base) {
    throw conflict(
      `The session works on ${base} itself; a pull request needs its own branch`,
      "same_branch",
    );
  }

  let commit: string | null = null;
  const runner = runnerForSession(deps, session.id);
  try {
    const status = await runner.request({ name: "git.status", cwd }, 30_000);
    if (status.files.length > 0) {
      if (!input.commitMessage) {
        throw badRequest(
          `There are ${status.files.length} uncommitted change(s). Commit them first or pass commitMessage.`,
          "uncommitted_changes",
        );
      }
      commit = (
        await runner.request({ name: "git.commit", cwd, message: input.commitMessage }, 5 * 60_000)
      ).commit;
    }
    // A runner in a sandbox gets the token for this push only (§9.2); others use their own git.
    const credential = await deps.git?.credentialFor(runner, githubCloneUrl(repo.owner, repo.repo));
    await pushBranch(runner, session, cwd, branch, credential);
  } catch (error) {
    throw toServiceError(error);
  }

  const issue = input.issue ?? session.issue?.number ?? null;
  const existing = await deps.client.run(async (octokit) => {
    const res = await octokit.rest.pulls.list({
      owner: repo.owner,
      repo: repo.repo,
      head: `${repo.owner}:${branch}`,
      state: "open",
      per_page: 1,
    });
    return res.data[0];
  });
  let number: number;
  if (existing) {
    number = existing.number;
    await deps.client.run((octokit) =>
      octokit.rest.pulls.update({
        owner: repo.owner,
        repo: repo.repo,
        pull_number: existing.number,
        title: input.title,
        ...(input.body !== undefined ? { body: pullRequestBody(input.body, issue, session) } : {}),
      }),
    );
  } else {
    const created = await deps.client.run((octokit) =>
      octokit.rest.pulls.create({
        owner: repo.owner,
        repo: repo.repo,
        title: input.title,
        body: pullRequestBody(input.body ?? "", issue, session),
        head: branch,
        base,
        draft: input.draft ?? false,
      }),
    );
    number = created.data.number;
  }

  const pr = await refreshPr(deps, session.projectId ?? "", repo, number, session.id);
  deps.repo.update(session.id, (s) => ({
    ...s,
    pr: { number: pr.number, url: pr.url, state: pr.state, title: pr.title },
    issue:
      s.issue ??
      (issue
        ? { number: issue, url: `https://github.com/${repo.owner}/${repo.repo}/issues/${issue}` }
        : null),
  }));
  return { number, url: pr.url, state: pr.state, created: !existing, branch, base, commit };
}

/** Re-read one PR with GraphQL and append the events for what changed. */
export async function refreshPr(
  deps: Pick<PullRequestDeps, "client" | "store" | "events">,
  projectId: string,
  repo: GitHubRepo,
  number: number,
  sessionId?: string | null,
): Promise<GithubPr> {
  const [fetched] = await fetchPullRequests(deps.client, repo.owner, repo.repo, [number]);
  if (!fetched)
    throw notFound(`No pull request #${number} in ${repo.owner}/${repo.repo}`, "pr_not_found");
  const prev = deps.store.pr(projectId, number);
  const next = GithubPr.parse(
    toGithubPr(projectId, fetched.node, sessionId ?? prev?.sessionId ?? null),
  );
  const events = diffPr(prev, next, { viewer: fetched.viewer });
  if (events.length > 0) deps.events.append(events);
  return deps.store.pr(projectId, number) ?? { ...next, id: githubPrId(projectId, number) };
}

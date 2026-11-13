import { errorMessage } from "../errors";
import type { GithubService } from "../github/github-service";

/**
 * The GitHub calls behind the factory's merge queue and PR ownership (§10.1): how far a PR is
 * behind the default branch, bringing it up to date without an agent, closing a PR a rebuild
 * replaced, and whether CI can run on the repository at all.
 */

/** Commits the default branch has that the PR's head doesn't (0: up to date). */
export async function behindBy(
  github: GithubService,
  projectId: string,
  headSha: string,
): Promise<number> {
  const { owner, repo, defaultBranch } = github.githubRepo(projectId);
  return github.client.run(
    async (o) =>
      (
        await o.rest.repos.compareCommitsWithBasehead({
          owner,
          repo,
          basehead: `${defaultBranch}...${headSha}`,
          per_page: 1,
        })
      ).data.behind_by,
  );
}

/**
 * Merge the default branch into the PR's branch on GitHub (`update-branch`). GitHub refuses
 * (422) when the head is no longer `expectedHeadSha` or the merge would conflict.
 */
export async function updateBranch(
  github: GithubService,
  projectId: string,
  number: number,
  expectedHeadSha: string,
): Promise<void> {
  const { owner, repo } = github.githubRepo(projectId);
  await github.client.run((o) =>
    o.rest.pulls.updateBranch({
      owner,
      repo,
      pull_number: number,
      expected_head_sha: expectedHeadSha,
    }),
  );
  github.sync.soon(projectId);
}

/** Comment on a pull request, then close it. */
export async function closePr(
  github: GithubService,
  projectId: string,
  number: number,
  comment: string,
): Promise<void> {
  const { owner, repo } = github.githubRepo(projectId);
  await github.commentOnIssue(projectId, number, comment);
  await github.client.run((o) =>
    o.rest.pulls.update({ owner, repo, pull_number: number, state: "closed" }),
  );
  github.sync.soon(projectId);
}

/**
 * Whether CI can run on the repository: GitHub Actions are enabled and at least one workflow is
 * active. Null when GitHub doesn't say (no permission to read the settings, a network error).
 */
export async function actionsAvailable(
  github: GithubService,
  projectId: string,
  log?: (message: string) => void,
): Promise<boolean | null> {
  const { owner, repo } = github.githubRepo(projectId);
  try {
    return await github.client.run(async (o) => {
      const permissions = await o.rest.actions.getGithubActionsPermissionsRepository({
        owner,
        repo,
      });
      if (!permissions.data.enabled) return false;
      const workflows = await o.rest.actions.listRepoWorkflows({ owner, repo, per_page: 100 });
      return workflows.data.workflows.some((w) => w.state === "active");
    });
  } catch (error) {
    log?.(`factory: reading the Actions settings: ${errorMessage(error)}`);
    return null;
  }
}

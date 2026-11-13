import type { GitHubPrRef, Project, Session } from "@codeden/contracts";

/**
 * What the **Open PR** buttons send. In a session the user started, the agent opens a pull
 * request only when asked, so the button asks: the agent writes the title and description and
 * commits what is left with `create_pull_request`.
 */
export const OPEN_PR_PROMPT =
  "Open a pull request for this work with `create_pull_request`. Commit anything uncommitted first, and write a title and description that say what changed, why, and how it was tested.";

/** A pull request that is still being worked on (open or draft), as opposed to merged or closed. */
export function isActivePr(pr: GitHubPrRef | null | undefined): pr is GitHubPrRef {
  return pr?.state === "open" || pr?.state === "draft";
}

/**
 * Whether the UI offers to ask this session's agent for a pull request: an agent session the user
 * started in a GitHub project, working on its own branch, that can still push (not read-only, not
 * archived) and has no open PR yet. Sessions CodeDen starts (PM, automation, factory) open their
 * own pull requests when their work is done. `pr` is the session's PR as GitHub reports it now,
 * when known; it defaults to the one recorded on the session.
 */
export function canAskForPullRequest(
  session: Session | null | undefined,
  project: Project | null | undefined,
  pr: GitHubPrRef | null | undefined = session?.pr,
): boolean {
  if (!session || project?.kind !== "github") return false;
  if (session.role !== "agent" || session.startedBy.kind !== "user") return false;
  if (session.autonomy === "read_only" || session.archivedAt) return false;
  if (!session.worktreePath || !session.branch || session.branch === session.baseBranch) {
    return false;
  }
  return !isActivePr(pr);
}

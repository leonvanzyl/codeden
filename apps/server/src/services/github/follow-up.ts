import type { GitHubRepo, GithubPr, RawEventEnvelope, Session } from "@codeden/contracts";
import { errorMessage } from "../errors";
import type { InboxService } from "../inbox-service";
import { type RunnerDeps, runnerErrorCode, runnerForSession } from "../runner-port";
import type { SessionRepo } from "../sessions/repo";
import type { GithubClient } from "./client";
import { commentOnIssue } from "./issues";

export interface FollowUpDeps extends RunnerDeps {
  client: GithubClient;
  repo: SessionRepo;
  inbox: InboxService;
  /** The GitHub coordinates of a project, or null for local projects. */
  repoOf: (projectId: string) => GitHubRepo | null;
  log?: (message: string) => void;
}

/** Statuses where no turn is in flight, so a merged session can be closed. */
const SETTLED = new Set(["idle", "interrupted", "created", "queued"]);

/**
 * Keeps sessions in step with their PRs (§9): every `pr.*` event updates the session's PR link,
 * and `pr.merged` marks the session done (stopping its idle provider process) and comments on
 * the linked issues. Runs after commit, never inside the store's notification.
 */
export class PrFollowUp {
  constructor(private readonly deps: FollowUpDeps) {}

  onEvents(events: RawEventEnvelope[]): void {
    for (const e of events) {
      if (!e.type.startsWith("pr.")) continue;
      const { pr } = e.payload as { pr: GithubPr };
      if (!pr.sessionId) continue;
      setImmediate(() => {
        this.handle(e.type, pr).catch((error: unknown) =>
          this.deps.log?.(`github follow-up for PR #${pr.number}: ${errorMessage(error)}`),
        );
      });
    }
  }

  /** Exposed for tests: apply one PR event to its session. */
  async handle(type: string, pr: GithubPr): Promise<void> {
    const sessionId = pr.sessionId;
    const found = sessionId ? this.deps.repo.find(sessionId) : undefined;
    if (!found) return;
    const ref = { number: pr.number, url: pr.url, state: pr.state, title: pr.title };
    const linkChanged = (s: Session) =>
      !s.pr || s.pr.number !== ref.number || s.pr.state !== ref.state || s.pr.title !== ref.title;
    if (type !== "pr.merged") {
      this.deps.repo.update(found.session.id, (s) => (linkChanged(s) ? { ...s, pr: ref } : s));
      return;
    }
    const session = found.session;
    const closeIt = SETTLED.has(session.status);
    if (closeIt) await this.stopProcess(session.id);
    const updated = this.deps.repo.update(session.id, (s) => {
      // The provider exit we just caused may already have marked it `stopped`; merged wins.
      if (closeIt && s.status !== "failed" && s.status !== "completed") {
        return { ...s, pr: ref, status: "completed", endedAt: new Date().toISOString() };
      }
      return linkChanged(s) ? { ...s, pr: ref } : s;
    });
    if (closeIt) this.deps.inbox.dismissRequestsForSession(session.id, "pull request merged");
    await this.linkBack(updated, pr);
  }

  private async stopProcess(sessionId: string): Promise<void> {
    try {
      await runnerForSession(this.deps, sessionId).request(
        { name: "session.stop", sessionId },
        15_000,
      );
    } catch (error) {
      const code = runnerErrorCode(error);
      if (code !== "unknown_session" && code !== "runner_unavailable") {
        this.deps.log?.(`github follow-up: stopping ${sessionId}: ${errorMessage(error)}`);
      }
    }
  }

  /** Comment on each linked issue that the merged PR resolved it. */
  private async linkBack(session: Session, pr: GithubPr): Promise<void> {
    const repo = this.deps.repoOf(pr.projectId);
    if (!repo) return;
    const issues = new Set(pr.linkedIssues);
    if (session.issue) issues.add(session.issue.number);
    const label = session.title ? `${session.title} (\`${session.id}\`)` : `\`${session.id}\``;
    for (const number of issues) {
      await commentOnIssue(
        { client: this.deps.client },
        repo,
        number,
        `Resolved by #${pr.number}, merged${pr.mergedAt ? ` at ${pr.mergedAt}` : ""}.\n\n<sub>CodeDen session ${label}</sub>`,
      );
    }
  }
}

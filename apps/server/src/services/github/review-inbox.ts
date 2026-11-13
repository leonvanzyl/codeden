import type { GithubPr, InboxItem, RawEventEnvelope } from "@codeden/contracts";
import { isFactorySession } from "../factory/starter";
import type { InboxService } from "../inbox-service";
import type { SessionRepo } from "../sessions/repo";

/** The `pr_review` inbox item id of a PR (one per PR). */
export function prReviewInboxId(projectId: string, number: number): string {
  return `inbox:pr_review:${projectId}:${number}`;
}

/** Open, out of draft, and its checks passed (or it has none). */
export function readyForReview(pr: GithubPr): boolean {
  return pr.state === "open" && (pr.checks.state === "success" || pr.checks.state === "none");
}

/**
 * The user's PR review queue (§11.1): when a PR owned by a CodeDen session is ready for review,
 * a `pr_review` inbox item asks the user to look at it. The item is raised once per PR and is
 * resolved on its own when the PR is merged or closed. A factory session's PR is the factory's
 * to review and merge (it raises its own item when a person has to), so it notifies as factory
 * activity.
 */
export class PrReviewInbox {
  constructor(private readonly deps: { inbox: InboxService; repo: SessionRepo }) {}

  onEvents(events: RawEventEnvelope[]): void {
    for (const e of events) {
      if (!e.type.startsWith("pr.")) continue;
      const { pr } = e.payload as { pr: GithubPr };
      if (!pr.sessionId) continue;
      this.apply(pr);
    }
  }

  /** Raise, keep or resolve the PR's review item for its latest state. */
  apply(pr: GithubPr): void {
    const id = prReviewInboxId(pr.projectId, pr.number);
    const existing = this.deps.inbox.find(id);
    if (pr.state === "merged" || pr.state === "closed") {
      if (existing?.status === "open") {
        this.deps.inbox.close(existing, "resolved", { reason: `pull request ${pr.state}` });
      }
      return;
    }
    if (existing || !readyForReview(pr)) return;
    const session = pr.sessionId ? this.deps.repo.find(pr.sessionId)?.session : undefined;
    const now = new Date().toISOString();
    const item: InboxItem = {
      id,
      kind: "pr_review",
      status: "open",
      priority: "normal",
      notify: session && isFactorySession(session) ? "factory" : "needs_you",
      title: `Ready for review: PR #${pr.number} ${pr.title}`,
      body: session ? (session.title ?? session.purpose) : null,
      projectId: pr.projectId,
      sessionId: pr.sessionId,
      threadId: session?.rootThreadId ?? null,
      itemId: null,
      requestId: null,
      issue: session?.issue ?? null,
      pr: { number: pr.number, url: pr.url, state: pr.state, title: pr.title },
      automationRunId: null,
      createdAt: now,
      updatedAt: now,
      resolvedAt: null,
      resolution: null,
    };
    this.deps.inbox.put(item);
  }
}

import type {
  GitHubPrRef,
  GithubIssue,
  GithubPr,
  GithubReview,
  RawEventEnvelope,
  Session,
} from "@codeden/contracts";
import { isTrustedReviewEvent, type TrustedAuthors } from "../github/review-trust";
import { type DerivedNotice, prOpenedNoticeId, wakesPm } from "./notices";

/** GitHub domain events that become PM notices (§8.2 step 4, §9). */
export const GITHUB_NOTICE_EVENTS = new Set([
  "pr.opened",
  "pr.checks_failed",
  "pr.checks_passed",
  "pr.merged",
  "issue.opened",
  "review.submitted",
]);

const clip = (text: string, max = 300) =>
  text.length > max ? `${text.slice(0, max - 3)}...` : text;

function prRef(pr: GithubPr): GitHubPrRef {
  return { number: pr.number, url: pr.url, state: pr.state, title: pr.title };
}

function failedChecks(pr: GithubPr): string[] {
  return pr.checks.checks
    .filter((c) => c.conclusion && !["success", "neutral", "skipped"].includes(c.conclusion))
    .map((c) => c.name);
}

/**
 * Typed PM notices for GitHub sync events. A PR owned by a CodeDen session wakes the PM the way
 * that session's own notices do (`wakesPm`); for other PRs, opened PRs and reviews wake the PM
 * while check results and merges only show up in its next digest. New issues always wake it,
 * so it can triage them. Ids derive from the event source, so a repeated sync adds nothing.
 * A review from someone without write access (neither the account it was read with nor one of
 * the project's `trustedAuthors`) carries no body and doesn't wake the PM: on a public
 * repository anyone can review.
 */
export function deriveGithubNotices(
  events: RawEventEnvelope[],
  session: (id: string) => Session | undefined,
  trustedAuthors?: TrustedAuthors,
): DerivedNotice[] {
  const out: DerivedNotice[] = [];
  for (const e of events) {
    if (!GITHUB_NOTICE_EVENTS.has(e.type)) continue;
    if (e.type === "issue.opened") {
      const { issue } = e.payload as { issue: GithubIssue };
      out.push({
        wake: true,
        notice: {
          id: `issue.opened:${issue.projectId}:${issue.number}`,
          type: "issue.opened",
          projectId: issue.projectId,
          target: "pm",
          sessionId: null,
          title: `Issue #${issue.number} opened: ${issue.title}`,
          data: {
            issue: { number: issue.number, url: issue.url, title: issue.title },
            author: issue.author,
            labels: issue.labels,
          },
        },
      });
      continue;
    }
    const { pr, review, viewer } = e.payload as {
      pr: GithubPr;
      review?: GithubReview;
      viewer?: string | null;
    };
    const owner = pr.sessionId ? session(pr.sessionId) : undefined;
    const ownerWakes = owner ? wakesPm(owner) : null;
    const common = { projectId: pr.projectId, target: "pm" as const, sessionId: pr.sessionId };
    const head = pr.headSha ?? pr.updatedAt;
    switch (e.type) {
      case "pr.opened":
        out.push({
          wake: ownerWakes ?? true,
          notice: {
            ...common,
            id: prOpenedNoticeId(pr.projectId, pr.number),
            type: "pr.opened",
            title: `PR #${pr.number} opened: ${pr.title}`,
            data: { sessionId: pr.sessionId, pr: prRef(pr) },
          },
        });
        break;
      case "pr.checks_failed":
        out.push({
          wake: ownerWakes ?? false,
          notice: {
            ...common,
            id: `pr.checks_failed:${pr.projectId}:${pr.number}:${head}`,
            type: "pr.checks_failed",
            title: `Checks failed on PR #${pr.number}: ${pr.title}`,
            data: { sessionId: pr.sessionId, pr: prRef(pr), failedChecks: failedChecks(pr) },
          },
        });
        break;
      case "pr.checks_passed":
        out.push({
          wake: ownerWakes ?? false,
          notice: {
            ...common,
            id: `pr.checks_passed:${pr.projectId}:${pr.number}:${head}`,
            type: "pr.checks_passed",
            title: `Checks passed on PR #${pr.number}: ${pr.title}`,
            data: { sessionId: pr.sessionId, pr: prRef(pr) },
          },
        });
        break;
      case "pr.merged":
        out.push({
          wake: ownerWakes ?? false,
          notice: {
            ...common,
            id: `pr.merged:${pr.projectId}:${pr.number}`,
            type: "pr.merged",
            title: `PR #${pr.number} merged: ${pr.title}`,
            data: { sessionId: pr.sessionId, pr: prRef(pr), linkedIssues: pr.linkedIssues },
          },
        });
        break;
      case "review.submitted": {
        if (!review) break;
        const trusted = isTrustedReviewEvent(
          { review, viewer },
          trustedAuthors?.(pr.projectId) ?? [],
        );
        out.push({
          // An outsider's review never wakes the PM; it shows up in the next digest.
          wake: trusted ? (ownerWakes ?? true) : false,
          notice: {
            ...common,
            id: `review.submitted:${pr.projectId}:${pr.number}:${review.id}`,
            type: "review.submitted",
            title: `Review on PR #${pr.number} (${review.state.replace("_", " ")}): ${pr.title}`,
            data: {
              sessionId: pr.sessionId,
              pr: prRef(pr),
              reviewer: review.author,
              state: review.state,
              body: trusted ? clip(review.body) : "",
              ...(trusted ? {} : { untrusted: true }),
            },
          },
        });
        break;
      }
    }
  }
  return out;
}

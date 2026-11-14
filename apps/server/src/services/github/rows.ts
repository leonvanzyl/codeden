import {
  type GithubChecksSummary,
  GithubIssue,
  GithubIssueStateReason,
  GithubPr,
  githubPrId,
} from "@codeden/contracts";
import type { githubIssues, githubPrs } from "../../db/schema";

/** Mapping between GitHub contract entities and their projection rows. */

export type GithubIssueRow = typeof githubIssues.$inferSelect;
export type GithubPrRow = typeof githubPrs.$inferSelect;

export const EMPTY_CHECKS: GithubChecksSummary = {
  state: "none",
  total: 0,
  passed: 0,
  failed: 0,
  pending: 0,
  checks: [],
};

export function issueToRow(issue: GithubIssue, syncedAt: string): GithubIssueRow {
  return {
    projectId: issue.projectId,
    number: issue.number,
    title: issue.title,
    state: issue.state,
    url: issue.url,
    labels: issue.labels,
    author: issue.author,
    etag: null,
    body: issue.body,
    comments: issue.comments,
    createdAt: issue.createdAt,
    updatedAt: issue.updatedAt,
    closedAt: issue.closedAt,
    stateReason: issue.stateReason ?? null,
    syncedAt,
  };
}

export function rowToIssue(row: GithubIssueRow, sessionIds: string[] = []): GithubIssue {
  return GithubIssue.parse({
    projectId: row.projectId,
    number: row.number,
    title: row.title,
    state: row.state,
    url: row.url,
    labels: row.labels,
    author: row.author,
    body: row.body,
    comments: row.comments,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    closedAt: row.closedAt,
    stateReason: GithubIssueStateReason.safeParse(row.stateReason).data ?? null,
    sessionIds,
  });
}

export function prToRow(pr: GithubPr, syncedAt: string): GithubPrRow {
  return {
    projectId: pr.projectId,
    number: pr.number,
    title: pr.title,
    state: pr.state,
    url: pr.url,
    headBranch: pr.headBranch,
    baseBranch: pr.baseBranch,
    checks: pr.checks,
    sessionId: pr.sessionId,
    etag: null,
    author: pr.author,
    headSha: pr.headSha,
    reviewDecision: pr.reviewDecision,
    reviews: pr.reviews,
    mergeable: pr.mergeable,
    linkedIssues: pr.linkedIssues,
    requestedReviewers: pr.requestedReviewers ?? null,
    commits: pr.commits,
    createdAt: pr.createdAt,
    updatedAt: pr.updatedAt,
    mergedAt: pr.mergedAt,
    closedAt: pr.closedAt,
    syncedAt,
  };
}

export function rowToPr(row: GithubPrRow): GithubPr {
  return GithubPr.parse({
    id: githubPrId(row.projectId, row.number),
    projectId: row.projectId,
    number: row.number,
    title: row.title,
    state: row.state,
    url: row.url,
    author: row.author,
    headBranch: row.headBranch,
    baseBranch: row.baseBranch,
    headSha: row.headSha,
    checks: row.checks ?? EMPTY_CHECKS,
    reviewDecision: row.reviewDecision,
    reviews: row.reviews,
    mergeable: row.mergeable,
    linkedIssues: row.linkedIssues,
    ...(row.requestedReviewers ? { requestedReviewers: row.requestedReviewers } : {}),
    commits: row.commits,
    sessionId: row.sessionId,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    mergedAt: row.mergedAt,
    closedAt: row.closedAt,
  });
}

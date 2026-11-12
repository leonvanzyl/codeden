import { z } from "zod";
import { GitHubIssueRef, GitHubPrRef, Id, Timestamp } from "./common";

/**
 * GitHub issue and pull request flow (§9): projections synced from GitHub, the events the
 * sync emits, and the HTTP shapes of `/api/projects/:id/github/*`, `/api/prs/:id` and
 * `/api/sessions/:id/github`. Local-only projects never have any of this.
 */

// ---------------------------------------------------------------- connection

/** Where the GitHub token came from: `gh auth token` at runtime, or the OS keychain. */
export const GithubTokenSource = z.enum(["gh", "keychain"]);
export type GithubTokenSource = z.infer<typeof GithubTokenSource>;

/** Whether CodeDen can reach GitHub. The token itself never leaves the server. */
export const GithubConnection = z.object({
  connected: z.boolean(),
  source: GithubTokenSource.nullable(),
  /** The authenticated user, once known. */
  login: z.string().nullable(),
  /** Why it is not connected, e.g. "Run `gh auth login`". */
  message: z.string().nullable(),
});
export type GithubConnection = z.infer<typeof GithubConnection>;

/** Sync state of one GitHub project. */
export const GithubSyncStatus = z.object({
  projectId: Id,
  lastSyncAt: Timestamp.nullable(),
  lastError: z.string().nullable(),
  /** Milliseconds between polls right now (faster while sessions have open PRs). */
  intervalMs: z.int().nonnegative(),
  nextSyncAt: Timestamp.nullable(),
});
export type GithubSyncStatus = z.infer<typeof GithubSyncStatus>;

// ---------------------------------------------------------------- entities

/** One issue (pull requests excluded), as projected into `github_issues`. */
export const GithubIssue = z.object({
  projectId: Id,
  number: z.int().positive(),
  title: z.string(),
  state: z.enum(["open", "closed"]),
  url: z.url(),
  labels: z.array(z.string()),
  author: z.string().nullable(),
  body: z.string().nullable(),
  comments: z.int().nonnegative(),
  createdAt: Timestamp.nullable(),
  updatedAt: Timestamp,
  closedAt: Timestamp.nullable(),
  /** CodeDen sessions working on this issue (from each session's `issue`). */
  sessionIds: z.array(Id).default([]),
});
export type GithubIssue = z.infer<typeof GithubIssue>;

/** Combined state of a PR's head commit checks and commit statuses. `none`: no checks. */
export const ChecksState = z.enum(["none", "pending", "success", "failure"]);
export type ChecksState = z.infer<typeof ChecksState>;

/** One check run or commit status on a PR's head commit. */
export const GithubCheck = z.object({
  name: z.string(),
  /** `queued`, `in_progress`, `completed` (check runs) or `pending`/`completed` (statuses). */
  status: z.string(),
  /** `success`, `failure`, `neutral`, `skipped`, `cancelled`, `timed_out`, ... once completed. */
  conclusion: z.string().nullable(),
  url: z.string().nullable(),
});
export type GithubCheck = z.infer<typeof GithubCheck>;

export const GithubChecksSummary = z.object({
  state: ChecksState,
  total: z.int().nonnegative(),
  passed: z.int().nonnegative(),
  failed: z.int().nonnegative(),
  pending: z.int().nonnegative(),
  checks: z.array(GithubCheck),
});
export type GithubChecksSummary = z.infer<typeof GithubChecksSummary>;

/** The PR's review decision (`none` when the repo needs no reviews and none was given). */
export const ReviewDecision = z.enum(["none", "review_required", "approved", "changes_requested"]);
export type ReviewDecision = z.infer<typeof ReviewDecision>;

/**
 * How the author of a review or comment relates to the repository: GitHub's
 * `CommentAuthorAssociation`, lower-cased. `owner`, `member` (of the owning organization) and
 * `collaborator` have write access; anyone else can still review a public repository's PRs.
 */
export const GithubAuthorAssociation = z.enum([
  "owner",
  "member",
  "collaborator",
  "contributor",
  "first_time_contributor",
  "first_timer",
  "mannequin",
  "none",
]);
export type GithubAuthorAssociation = z.infer<typeof GithubAuthorAssociation>;

export const GithubReview = z.object({
  id: z.string(),
  author: z.string().nullable(),
  /**
   * The author's relation to the repository. Absent on reviews synced before it was tracked,
   * which count as from someone without write access.
   */
  authorAssociation: GithubAuthorAssociation.optional(),
  state: z.enum(["approved", "changes_requested", "commented", "dismissed", "pending"]),
  body: z.string(),
  submittedAt: Timestamp.nullable(),
  url: z.string().nullable(),
});
export type GithubReview = z.infer<typeof GithubReview>;

export const Mergeable = z.enum(["mergeable", "conflicting", "unknown"]);
export type Mergeable = z.infer<typeof Mergeable>;

/** One pull request, as projected into `github_prs`. */
export const GithubPr = z.object({
  /** `<projectId>:<number>`, the id used by `/api/prs/:id`. */
  id: z.string().min(1),
  projectId: Id,
  number: z.int().positive(),
  title: z.string(),
  state: GitHubPrRef.shape.state,
  url: z.url(),
  author: z.string().nullable(),
  headBranch: z.string(),
  baseBranch: z.string(),
  headSha: z.string().nullable(),
  checks: GithubChecksSummary,
  reviewDecision: ReviewDecision,
  /** Latest reviews, oldest first (up to 20). */
  reviews: z.array(GithubReview),
  mergeable: Mergeable,
  /** Issues the PR closes (`Fixes #N` and linked issues). */
  linkedIssues: z.array(z.int().positive()),
  /**
   * Pending review requests: user logins and team slugs (`org/team`), sorted. Absent on rows
   * synced before it was tracked, which tells the sync not to treat every request as new.
   */
  requestedReviewers: z.array(z.string()).optional(),
  /** Latest commits on the PR (up to 50), oldest first. */
  commits: z.array(z.object({ sha: z.string(), message: z.string() })),
  /** The CodeDen session that owns the PR (created it, or works on its head branch). */
  sessionId: Id.nullable(),
  createdAt: Timestamp.nullable(),
  updatedAt: Timestamp,
  mergedAt: Timestamp.nullable(),
  closedAt: Timestamp.nullable(),
});
export type GithubPr = z.infer<typeof GithubPr>;

/** `/api/prs/:id`: the projection plus live details. */
export const GithubPrDetails = GithubPr.extend({
  body: z.string(),
  additions: z.int().nonnegative(),
  deletions: z.int().nonnegative(),
  files: z.array(
    z.object({
      path: z.string(),
      status: z.string(),
      additions: z.int().nonnegative(),
      deletions: z.int().nonnegative(),
    }),
  ),
});
export type GithubPrDetails = z.infer<typeof GithubPrDetails>;

/** Build the `/api/prs/:id` id of a PR. */
export function githubPrId(projectId: string, number: number): string {
  return `${projectId}:${number}`;
}

/** Parse a `/api/prs/:id` id; null when malformed. */
export function parseGithubPrId(id: string): { projectId: string; number: number } | null {
  const at = id.lastIndexOf(":");
  if (at <= 0) return null;
  const number = Number(id.slice(at + 1));
  if (!Number.isInteger(number) || number <= 0) return null;
  return { projectId: id.slice(0, at), number };
}

// ---------------------------------------------------------------- events

const issuePayload = { issue: GithubIssue };

/** A new comment on an issue, as carried by `issue.commented`. */
export const GithubNewComment = z.object({
  id: z.int(),
  author: z.string().nullable(),
  body: z.string(),
  createdAt: Timestamp,
  url: z.url(),
  /** Posted by CodeDen itself (carries its hidden marker); never triggers automations. */
  fromCodeden: z.boolean(),
});
export type GithubNewComment = z.infer<typeof GithubNewComment>;
const prPayload = { pr: GithubPr };

/**
 * Domain events from GitHub sync (§9, §10 triggers). Each carries the full projection row, so
 * `github_issues` / `github_prs` can be rebuilt from the log. `github.synced` is the silent
 * first import of a project (no notices or automations fire for it).
 */
export const GITHUB_EVENT_PAYLOADS = {
  "github.synced": z.object({
    projectId: Id,
    issues: z.array(GithubIssue),
    prs: z.array(GithubPr),
  }),
  "issue.opened": z.object(issuePayload),
  "issue.labeled": z.object({ ...issuePayload, added: z.array(z.string()) }),
  /** Title, body, state or label removal changed. `changes` names the fields. */
  "issue.updated": z.object({ ...issuePayload, changes: z.array(z.string()) }),
  /**
   * The issue's comment count went up. `comments` are the new comments, oldest first (up to 10;
   * empty when they could not be read).
   */
  "issue.commented": z.object({ ...issuePayload, comments: z.array(GithubNewComment) }),
  "pr.opened": z.object(prPayload),
  "pr.updated": z.object({ ...prPayload, changes: z.array(z.string()) }),
  /** Reviews were requested from `reviewers` (logins or `org/team`) that were not before. */
  "pr.review_requested": z.object({ ...prPayload, reviewers: z.array(z.string()) }),
  "pr.checks_passed": z.object(prPayload),
  "pr.checks_failed": z.object(prPayload),
  "pr.merged": z.object(prPayload),
  "pr.closed": z.object(prPayload),
  "review.submitted": z.object({ ...prPayload, review: GithubReview }),
} as const;
export type GithubEventType = keyof typeof GITHUB_EVENT_PAYLOADS;
export const GITHUB_EVENT_TYPES = Object.keys(GITHUB_EVENT_PAYLOADS) as GithubEventType[];

// ---------------------------------------------------------------- HTTP shapes

export const GithubListQuery = z.object({
  state: z.enum(["open", "closed", "all"]).default("open"),
  limit: z.coerce.number().int().min(1).max(500).default(100),
});
export type GithubListQuery = z.infer<typeof GithubListQuery>;

export const GithubIssuesResponse = z.object({
  connection: GithubConnection,
  sync: GithubSyncStatus.nullable(),
  issues: z.array(GithubIssue),
});
export type GithubIssuesResponse = z.infer<typeof GithubIssuesResponse>;

export const GithubPrsResponse = z.object({
  connection: GithubConnection,
  sync: GithubSyncStatus.nullable(),
  prs: z.array(GithubPr),
});
export type GithubPrsResponse = z.infer<typeof GithubPrsResponse>;

export const CreateGithubIssueRequest = z.object({
  title: z.string().min(1).max(256),
  body: z.string().max(65_000).default(""),
  labels: z.array(z.string().min(1)).max(20).default([]),
});
export type CreateGithubIssueRequest = z.infer<typeof CreateGithubIssueRequest>;

export const GithubCommentRequest = z.object({ body: z.string().min(1).max(65_000) });
export type GithubCommentRequest = z.infer<typeof GithubCommentRequest>;

export const GithubCommentResponse = z.object({ id: z.int(), url: z.url() });
export type GithubCommentResponse = z.infer<typeof GithubCommentResponse>;

export const GithubLabelRequest = z.object({
  add: z.array(z.string().min(1)).max(20).default([]),
  remove: z.array(z.string().min(1)).max(20).default([]),
});
export type GithubLabelRequest = z.infer<typeof GithubLabelRequest>;

export const MergePrRequest = z.object({
  method: z.enum(["squash", "merge", "rebase"]).default("squash"),
  /** Only merge when the head is still this commit. */
  sha: z.string().optional(),
  commitTitle: z.string().max(256).optional(),
  commitMessage: z.string().max(65_000).optional(),
});
export type MergePrRequest = z.infer<typeof MergePrRequest>;

export const MergePrResponse = z.object({ merged: z.boolean(), sha: z.string().nullable() });
export type MergePrResponse = z.infer<typeof MergePrResponse>;

/** A comment on an issue or PR conversation. */
export const GithubIssueComment = z.object({
  id: z.int(),
  author: z.string().nullable(),
  body: z.string(),
  createdAt: Timestamp,
  url: z.url(),
});
export type GithubIssueComment = z.infer<typeof GithubIssueComment>;

/** An issue with its latest comments (up to 20, oldest first), for triage and briefs. */
export const GithubIssueDetails = GithubIssue.extend({
  recentComments: z.array(GithubIssueComment),
});
export type GithubIssueDetails = z.infer<typeof GithubIssueDetails>;

/** Issue triage classes (§10): `ready` accepts the issue, the rest decline or defer it. */
export const TriageDecision = z.enum([
  "ready",
  "needs_info",
  "unsafe",
  "out_of_scope",
  "duplicate",
]);
export type TriageDecision = z.infer<typeof TriageDecision>;

/** Apply a triage decision: labels, an optional comment, optionally close the issue. */
export const TriageIssueRequest = z.object({
  decision: TriageDecision,
  labels: z.array(z.string().min(1)).max(20).default([]),
  removeLabels: z.array(z.string().min(1)).max(20).default([]),
  comment: z.string().min(1).max(65_000).optional(),
  /** Close the issue (as "not planned" unless the decision is `ready`). */
  close: z.boolean().default(false),
});
export type TriageIssueRequest = z.infer<typeof TriageIssueRequest>;

export const TriageIssueResult = z.object({
  issue: GithubIssue,
  decision: TriageDecision,
  commentUrl: z.url().nullable(),
  closed: z.boolean(),
});
export type TriageIssueResult = z.infer<typeof TriageIssueResult>;

/** `/api/sessions/:id/github`: the session's issue and PR with live status. */
export const SessionGithubResponse = z.object({
  connection: GithubConnection,
  issue: GitHubIssueRef.nullable(),
  pr: GithubPr.nullable(),
});
export type SessionGithubResponse = z.infer<typeof SessionGithubResponse>;

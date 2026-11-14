import type { GithubChecksSummary, GithubReview } from "@codeden/contracts";
import { index, integer, primaryKey, sqliteTable, text } from "drizzle-orm/sqlite-core";

/**
 * GitHub projections (§6, §9). `github_issues` and `github_prs` are written in the same
 * transaction as the GitHub domain events (`github.synced`, `issue.*`, `pr.*`, `review.*`), so
 * they can be rebuilt from the log. `github_sync_state` is operational (ETags, cursors), like
 * `runner_state`, and is not event-sourced.
 */

const json = <T>(name: string) => text(name, { mode: "json" }).$type<T>();

export const githubIssues = sqliteTable(
  "github_issues",
  {
    projectId: text("project_id").notNull(),
    number: integer("number").notNull(),
    title: text("title").notNull(),
    state: text("state").notNull(),
    url: text("url").notNull(),
    labels: json<string[]>("labels").notNull(),
    author: text("author"),
    /** Unused (ETags live in `github_sync_state`); kept for the existing column. */
    etag: text("etag"),
    body: text("body"),
    comments: integer("comments").notNull().default(0),
    createdAt: text("created_at"),
    updatedAt: text("updated_at").notNull(),
    closedAt: text("closed_at"),
    /** GitHub's `state_reason` on a closed issue (`completed`, `not_planned`, `duplicate`). */
    stateReason: text("state_reason"),
    syncedAt: text("synced_at").notNull(),
  },
  (t) => [primaryKey({ columns: [t.projectId, t.number] })],
);

export const githubPrs = sqliteTable(
  "github_prs",
  {
    projectId: text("project_id").notNull(),
    number: integer("number").notNull(),
    title: text("title").notNull(),
    /** `draft`, `open`, `closed` or `merged`. */
    state: text("state").notNull(),
    url: text("url").notNull(),
    headBranch: text("head_branch").notNull(),
    baseBranch: text("base_branch").notNull(),
    /** Checks summary of the head commit (JSON). */
    checks: json<GithubChecksSummary>("checks"),
    sessionId: text("session_id"),
    /** Unused (ETags live in `github_sync_state`); kept for the existing column. */
    etag: text("etag"),
    author: text("author"),
    headSha: text("head_sha"),
    reviewDecision: text("review_decision").notNull().default("none"),
    reviews: json<GithubReview[]>("reviews").notNull().default([]),
    mergeable: text("mergeable").notNull().default("unknown"),
    linkedIssues: json<number[]>("linked_issues").notNull().default([]),
    /** Pending review requests (logins, `org/team`); null on rows synced before they were tracked. */
    requestedReviewers: json<string[]>("requested_reviewers"),
    commits: json<Array<{ sha: string; message: string }>>("commits").notNull().default([]),
    createdAt: text("created_at"),
    updatedAt: text("updated_at").notNull(),
    mergedAt: text("merged_at"),
    closedAt: text("closed_at"),
    syncedAt: text("synced_at").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.projectId, t.number] }),
    index("github_prs_session").on(t.sessionId),
    index("github_prs_head").on(t.projectId, t.headBranch),
  ],
);

/** Per-project sync cursors and conditional-request ETags (not event-sourced). */
export const githubSyncState = sqliteTable("github_sync_state", {
  projectId: text("project_id").primaryKey(),
  /** Request key (method + URL) -> ETag of the last 200 response. */
  etags: json<Record<string, string>>("etags").notNull().default({}),
  /** `since` cursor for the issues listing (newest `updated_at` seen). */
  since: text("since"),
  /** When the silent first import (`github.synced`) finished. */
  baselineAt: text("baseline_at"),
  lastSyncAt: text("last_sync_at"),
  lastError: text("last_error"),
  updatedAt: text("updated_at").notNull(),
});

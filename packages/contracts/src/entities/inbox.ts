import { z } from "zod";
import { GitHubIssueRef, GitHubPrRef, Id, JsonValue, Timestamp } from "../common";

/** What an inbox item asks of the user (§11.1). */
export const InboxItemKind = z.enum([
  "question",
  "approval",
  "pr_review",
  "run_failed",
  "triage",
  "automation_result",
  "message",
  /** A start request that matched running work (§8.4); resolved with wait/skip/join/force. */
  "conflict",
  /**
   * A session's worktree could not be removed (§9), for example because a program outside
   * CodeDen still uses it. Resolved by CodeDen once a later attempt removes it.
   */
  "cleanup_failed",
]);
export type InboxItemKind = z.infer<typeof InboxItemKind>;

export const InboxItemStatus = z.enum(["open", "resolved", "dismissed"]);
export type InboxItemStatus = z.infer<typeof InboxItemStatus>;

/**
 * Who an inbox item is for, set by the server when it raises the item (§11.1). Settings →
 * Notifications chooses which categories raise a toast and a desktop notification; every item
 * lands in the inbox either way.
 * - `needs_you`: the user should act: approvals and questions, a PR only a person merges, a
 *   factory decision flagged `needsHuman`, a start conflict, a budget alert.
 * - `failure`: something broke and needs a person: a failed run of a session the factory doesn't
 *   look after, a paused factory loop, a regression, a worktree that couldn't be removed.
 * - `factory`: the factory's own activity, which it handles itself: its decisions, PRs it
 *   reviews and merges, its sessions' failures, stopped items, the daily digest.
 * - `automation`: automation results and triage decisions.
 */
export const InboxNotify = z.enum(["needs_you", "failure", "factory", "automation"]);
export type InboxNotify = z.infer<typeof InboxNotify>;

/** One thing waiting on the user. Links to its session, issue and PR and is answerable in place. */
export const InboxItem = z.object({
  id: Id,
  kind: InboxItemKind,
  status: InboxItemStatus,
  priority: z.enum(["low", "normal", "high"]).default("normal"),
  /** Which notification category it raises (items stored before it existed read as `needs_you`). */
  notify: InboxNotify.default("needs_you"),
  title: z.string(),
  body: z.string().nullable(),
  projectId: Id.nullable(),
  sessionId: Id.nullable(),
  threadId: Id.nullable(),
  /** The transcript item (approval_request / user_question) this mirrors. */
  itemId: Id.nullable(),
  /** Provider request id to answer, for approvals and questions. */
  requestId: Id.nullable(),
  issue: GitHubIssueRef.nullable(),
  pr: GitHubPrRef.nullable(),
  automationRunId: Id.nullable(),
  createdAt: Timestamp,
  updatedAt: Timestamp,
  resolvedAt: Timestamp.nullable(),
  /** How it was resolved (decision, answers, note). */
  resolution: JsonValue.nullable(),
});
export type InboxItem = z.infer<typeof InboxItem>;

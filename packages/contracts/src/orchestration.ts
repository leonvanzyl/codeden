import { z } from "zod";
import { GitHubIssueRef, GitHubPrRef, Id, JsonValue, Timestamp } from "./common";
import { InboxItemKind, InboxItemStatus } from "./entities/inbox";
import { AutonomyMode } from "./factory";
import { ConflictDecision, ScheduledRun, StartedBy, WorkKey, WorkSummary } from "./work";

/**
 * Orchestration (§8): typed notices that wake the PM and the orchestrator, the status digest
 * injected on every wake, the role sessions and persisted conflicts. Notices are structured
 * data all the way to the UI, which renders them as cards; they are never parsed from text.
 */

/** Who a notice is for: a project's PM or the orchestrator. */
export const NoticeTarget = z.enum(["pm", "orchestrator"]);
export type NoticeTarget = z.infer<typeof NoticeTarget>;

/** Kinds of notices (§8.2 step 4). */
export const NoticeType = z.enum([
  "session.finished",
  "session.needs_input",
  "session.failed",
  "pr.opened",
  "pr.checks_failed",
  "pr.checks_passed",
  "pr.merged",
  "review.submitted",
  "issue.opened",
  "automation.skipped",
  "conflict",
  "pm.message",
  "orchestrator.message",
  "factory.update",
  "reminder",
]);
export type NoticeType = z.infer<typeof NoticeType>;

const noticeBase = {
  id: Id,
  projectId: Id.nullable(),
  target: NoticeTarget,
  /** Session the notice is about, when there is one. */
  sessionId: Id.nullable(),
  /** One line for cards and the wake summary. */
  title: z.string(),
  createdAt: Timestamp,
  /** Set when a wake delivered it to its target (or it was shown in a digest). */
  deliveredAt: Timestamp.nullable(),
  /**
   * Whether it wakes its target (§8.2); a routine notice only rides along with the target's
   * next turn. Absent on notices stored before it was recorded.
   */
  wake: z.boolean().optional(),
  /**
   * Not delivered before this time: a wake-up the PM or the orchestrator scheduled for itself
   * (`schedule_wakeup`). Absent or null: deliverable at once.
   */
  notBefore: Timestamp.nullable().optional(),
};

/** The work a session notice is about. */
const workRef = {
  sessionId: Id,
  workKey: WorkKey,
  purpose: z.string(),
  startedBy: StartedBy,
};

/** A typed notice. `data` is specific to `type`. */
export const Notice = z.discriminatedUnion("type", [
  z.object({
    ...noticeBase,
    type: z.literal("session.finished"),
    data: z.object({
      ...workRef,
      /** The agent's `finish` summary, else its final message (start and last paragraph). */
      summary: z.string().nullable(),
      outcome: z.string().nullable(),
    }),
  }),
  z.object({
    ...noticeBase,
    type: z.literal("session.needs_input"),
    data: z.object({
      ...workRef,
      inboxItemId: Id,
      kind: InboxItemKind,
      question: z.string(),
      /**
       * The MCP server whose form this question is (an elicitation): it waits for the user,
       * like an approval, and the PM can't answer it.
       */
      mcpServer: z.string().min(1).optional(),
    }),
  }),
  z.object({
    ...noticeBase,
    type: z.literal("session.failed"),
    data: z.object({ ...workRef, error: z.string() }),
  }),
  z.object({
    ...noticeBase,
    type: z.literal("pr.opened"),
    data: z.object({ sessionId: Id.nullable(), pr: GitHubPrRef }),
  }),
  z.object({
    ...noticeBase,
    type: z.literal("pr.checks_failed"),
    data: z.object({
      sessionId: Id.nullable(),
      pr: GitHubPrRef,
      failedChecks: z.array(z.string()),
    }),
  }),
  z.object({
    ...noticeBase,
    type: z.literal("pr.checks_passed"),
    data: z.object({ sessionId: Id.nullable(), pr: GitHubPrRef }),
  }),
  z.object({
    ...noticeBase,
    type: z.literal("pr.merged"),
    data: z.object({
      sessionId: Id.nullable(),
      pr: GitHubPrRef,
      /** Issues the PR closes. */
      linkedIssues: z.array(z.int().positive()),
    }),
  }),
  z.object({
    ...noticeBase,
    type: z.literal("review.submitted"),
    data: z.object({
      sessionId: Id.nullable(),
      pr: GitHubPrRef,
      reviewer: z.string().nullable(),
      state: z.enum(["approved", "changes_requested", "commented", "dismissed", "pending"]),
      /** Start of the review body; empty for an untrusted review. */
      body: z.string(),
      /**
       * The reviewer has no write access to the repository and is not a trusted author: the
       * body is left out, and the review is no instruction to anyone. Absent on trusted
       * reviews (and on notices from before it was tracked).
       */
      untrusted: z.boolean().optional(),
    }),
  }),
  z.object({
    ...noticeBase,
    type: z.literal("issue.opened"),
    data: z.object({
      issue: GitHubIssueRef,
      author: z.string().nullable(),
      labels: z.array(z.string()),
    }),
  }),
  z.object({
    ...noticeBase,
    type: z.literal("automation.skipped"),
    data: z.object({
      automationRunId: Id,
      automationId: Id,
      workKey: WorkKey,
      purpose: z.string(),
      reason: z.string(),
    }),
  }),
  z.object({
    ...noticeBase,
    type: z.literal("conflict"),
    data: z.object({
      conflictId: Id,
      workKey: WorkKey,
      purpose: z.string(),
      requestedBy: StartedBy,
      existing: z.array(WorkSummary),
    }),
  }),
  z.object({
    ...noticeBase,
    type: z.literal("pm.message"),
    data: z.object({
      fromSessionId: Id,
      text: z.string(),
      /** Informational messages never wake the orchestrator; they show in its next digest. */
      informational: z.boolean(),
    }),
  }),
  /**
   * A message from the orchestrator to a PM that the loop guard held back (§8.2): the two had
   * already exchanged several automatic messages without the user stepping in. It reaches the
   * PM with its next wake, at the latest once the guard's window allows another message.
   */
  z.object({
    ...noticeBase,
    type: z.literal("orchestrator.message"),
    data: z.object({
      /** The orchestrator session that sent it, when known. */
      fromSessionId: Id.nullable(),
      /** The message as the orchestrator wrote it (an `ask_pm` question carries its marker). */
      text: z.string(),
    }),
  }),
  z.object({
    ...noticeBase,
    type: z.literal("factory.update"),
    data: z.object({
      /** What happened in the factory loop (§10.1). */
      event: z.enum([
        "triage_needed",
        "digest",
        "paused",
        "escalated",
        "regression",
        "merged",
        "failed",
        "ready",
      ]),
      /** Instructions (for the PM) or a summary (for the orchestrator). */
      text: z.string(),
      itemIds: z.array(Id).default([]),
    }),
  }),
  /**
   * A wake-up the PM or the orchestrator scheduled for itself (`schedule_wakeup`), due at
   * `notBefore`: it wakes them then with their note, so they follow up without the user.
   */
  z.object({
    ...noticeBase,
    type: z.literal("reminder"),
    data: z.object({
      /** What to do when it fires, as they wrote it. */
      note: z.string(),
      /** The role session that scheduled it. */
      requestedBy: Id.nullable(),
    }),
  }),
]);
export type Notice = z.infer<typeof Notice>;
export type NoticeOf<T extends NoticeType> = Extract<Notice, { type: T }>;

/** `notice` item `code` used for the batch of notices shown at the start of a wake turn. */
export const NOTICE_BATCH_CODE = "orchestration_notices";

/** `data` of a `notice` item with `code: "orchestration_notices"` (rendered as cards). */
export const NoticeBatchData = z.object({
  notices: z.array(Notice),
});
export type NoticeBatchData = z.infer<typeof NoticeBatchData>;

// ---------------------------------------------------------------- status digest (§8.4)

/** A recent outcome of agent work, for digests. */
export const RecentOutcome = z.object({
  sessionId: Id,
  workKey: WorkKey,
  purpose: z.string(),
  outcome: z.enum(["finished", "failed", "stopped"]),
  summary: z.string().nullable(),
  at: Timestamp,
});
export type RecentOutcome = z.infer<typeof RecentOutcome>;

/** Everything a PM needs to know about its project, without spending a tool call. */
export const ProjectStatus = z.object({
  project: z.object({
    id: Id,
    name: z.string(),
    kind: z.enum(["github", "local"]),
    /**
     * The project's autonomy mode: tells the PM who merges pull requests (the user in manual and
     * assisted, the factory loop in the software and dark factory).
     */
    mode: AutonomyMode,
  }),
  /** Agent sessions and automation runs that are starting, running or waiting. */
  running: z.array(WorkSummary),
  /** Work queued behind other work (§8.4 `wait`). */
  queued: z.array(WorkSummary),
  /** Next scheduled automation runs. */
  scheduled: z.array(ScheduledRun),
  inbox: z.object({
    open: z.int().nonnegative(),
    items: z.array(
      z.object({ id: Id, kind: InboxItemKind, title: z.string(), sessionId: Id.nullable() }),
    ),
  }),
  /** Finishes and failures of the last 24 hours, newest first. */
  recent: z.array(RecentOutcome),
});
export type ProjectStatus = z.infer<typeof ProjectStatus>;

/** The orchestrator's view: every project rolled up (`get_overview`). */
export const Overview = z.object({
  generatedAt: Timestamp,
  projects: z.array(ProjectStatus),
  /** Work keys running in more than one project at once. */
  sharedWork: z.array(z.object({ workKey: WorkKey, projectIds: z.array(Id) })),
  /** PM messages marked informational that the orchestrator has not seen yet. */
  pmMessages: z.array(z.object({ projectId: Id.nullable(), text: z.string(), at: Timestamp })),
});
export type Overview = z.infer<typeof Overview>;

// ---------------------------------------------------------------- role sessions and conflicts

/** The long-lived role sessions (§8.1): the orchestrator and one PM per project. */
export const RoleSessionsRef = z.object({
  orchestrator: Id.nullable(),
  /** PM session id by project id. */
  pms: z.record(z.string(), Id),
});
export type RoleSessionsRef = z.infer<typeof RoleSessionsRef>;

/**
 * A start request that matched running work, persisted as an inbox item of kind `conflict`
 * (`id` is the inbox item id). Resolved with `wait`, `skip`, `join` or `force` (§8.4).
 */
export const ConflictRecord = z.object({
  id: Id,
  projectId: Id.nullable(),
  request: z.object({ purpose: z.string(), workKey: WorkKey, startedBy: StartedBy }),
  existing: z.array(WorkSummary).min(1),
  /** The original `StartSessionRequest`, retried with the decision. */
  start: JsonValue,
  status: InboxItemStatus,
  resolution: ConflictDecision.nullable(),
  /** The `StartSessionResponse` of the retried start. */
  outcome: JsonValue.nullable(),
  createdAt: Timestamp,
  resolvedAt: Timestamp.nullable(),
});
export type ConflictRecord = z.infer<typeof ConflictRecord>;

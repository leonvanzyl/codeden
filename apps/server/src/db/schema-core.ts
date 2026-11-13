import type {
  Automation,
  AutomationRun,
  ErrorInfo,
  FactoryLimits,
  ForkOrigin,
  GitHubIssueRef,
  GitHubPrRef,
  GitHubRepo,
  Item,
  JsonValue,
  ProjectRemoteWarning,
  QueueSender,
  SessionResult,
  StartedBy,
  Usage,
  UserInput,
  WorkProgress,
  WorkScope,
} from "@codeden/contracts";
import {
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";
import type { StoredStartMeta } from "../services/sessions/repo";

/**
 * SQLite schema (§6). `events` is the append-only audit trail and replay source; every other
 * table is a projection written in the same transaction as the event that produces it.
 * Timestamps are UTC ISO-8601 strings. Change a `schema-*.ts` file, then run `pnpm db:generate`.
 */

const json = <T>(name: string) => text(name, { mode: "json" }).$type<T>();

export const events = sqliteTable(
  "events",
  {
    seq: integer("seq").primaryKey({ autoIncrement: true }),
    sessionId: text("session_id"),
    type: text("type").notNull(),
    payload: json<unknown>("payload").notNull(),
    ts: text("ts").notNull(),
  },
  (t) => [index("events_session_seq").on(t.sessionId, t.seq), index("events_type").on(t.type)],
);

export const projects = sqliteTable(
  "projects",
  {
    id: text("id").primaryKey(),
    kind: text("kind", { enum: ["github", "local"] }).notNull(),
    name: text("name").notNull(),
    slug: text("slug").notNull(),
    path: text("path").notNull(),
    defaultBranch: text("default_branch"),
    defaultProvider: text("default_provider"),
    autonomy: text("autonomy"),
    autonomyMode: text("autonomy_mode").notNull().default("assisted"),
    visionPath: text("vision_path").notNull().default(".codeden/VISION.md"),
    factoryLimits: json<FactoryLimits>("factory_limits"),
    killSwitch: integer("kill_switch", { mode: "boolean" }).notNull().default(false),
    timezone: text("timezone"),
    /** Agent sessions run with `CI=true` (§4.2); the migration keeps it on for every project. */
    agentCiEnv: integer("agent_ci_env", { mode: "boolean" }).notNull().default(true),
    pinned: integer("pinned", { mode: "boolean" }).notNull().default(false),
    /** Manual list position (§13); the migration backfills it from the alphabetical order. */
    sortOrder: integer("sort_order").notNull().default(0),
    github: json<GitHubRepo>("github"),
    /** Set when re-detection found the GitHub remote missing (§9); null when all is well. */
    remoteWarning: json<ProjectRemoteWarning>("remote_warning"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
    archivedAt: text("archived_at"),
  },
  (t) => [uniqueIndex("projects_slug").on(t.slug)],
);

export const sessions = sqliteTable(
  "sessions",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id"),
    role: text("role").notNull(),
    parentSessionId: text("parent_session_id"),
    startedBy: json<StartedBy>("started_by").notNull(),
    purpose: text("purpose").notNull(),
    workKey: text("work_key").notNull(),
    scope: json<WorkScope>("scope").notNull(),
    progress: json<WorkProgress>("progress"),
    title: text("title"),
    provider: text("provider").notNull(),
    model: text("model"),
    effort: text("effort"),
    autonomy: text("autonomy").notNull(),
    planMode: integer("plan_mode", { mode: "boolean" }).notNull().default(false),
    status: text("status").notNull(),
    cwd: text("cwd").notNull(),
    worktreePath: text("worktree_path"),
    branch: text("branch"),
    baseBranch: text("base_branch"),
    issue: json<GitHubIssueRef>("issue"),
    pr: json<GitHubPrRef>("pr"),
    resumeToken: text("resume_token"),
    runnerId: text("runner_id"),
    automationRunId: text("automation_run_id"),
    rootThreadId: text("root_thread_id"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
    endedAt: text("ended_at"),
    archivedAt: text("archived_at"),
    worktreeRemovedAt: text("worktree_removed_at"),
    /** The session this one was forked from, and the checkpoint its worktree started at. */
    forkedFrom: json<ForkOrigin>("forked_from"),
    /** Accumulated usage (server-side projection; not part of the `Session` entity). */
    usage: json<Usage>("usage"),
    /** How the session was started (workspace fallback, forced conflict reason, queue). */
    startMeta: json<StoredStartMeta>("start_meta"),
    /** Structured result from the agent's `finish` tool. */
    result: json<SessionResult>("result"),
  },
  (t) => [
    index("sessions_project").on(t.projectId),
    index("sessions_status").on(t.status),
    index("sessions_work_key").on(t.projectId, t.workKey),
  ],
);

// Thread/turn/item ids come from providers and are only unique within a session.
export const threads = sqliteTable(
  "threads",
  {
    sessionId: text("session_id").notNull(),
    id: text("id").notNull(),
    parentThreadId: text("parent_thread_id"),
    parentItemId: text("parent_item_id"),
    title: text("title"),
    agentType: text("agent_type"),
    createdAt: text("created_at").notNull(),
  },
  (t) => [primaryKey({ columns: [t.sessionId, t.id] })],
);

export const turns = sqliteTable(
  "turns",
  {
    sessionId: text("session_id").notNull(),
    id: text("id").notNull(),
    threadId: text("thread_id").notNull(),
    status: text("status").notNull(),
    startedAt: text("started_at").notNull(),
    completedAt: text("completed_at"),
    error: json<ErrorInfo>("error"),
    /** Usage reported for this turn (latest `usage.updated` with this turnId). */
    usage: json<Usage>("usage"),
    /** The provider's fork point at the end of the turn (`forkPoint` on its end event, §9). */
    forkPoint: text("fork_point"),
  },
  (t) => [primaryKey({ columns: [t.sessionId, t.id] })],
);

export const items = sqliteTable(
  "items",
  {
    sessionId: text("session_id").notNull(),
    id: text("id").notNull(),
    threadId: text("thread_id").notNull(),
    turnId: text("turn_id").notNull(),
    position: integer("position").notNull(),
    kind: text("kind").notNull(),
    status: text("status").notNull(),
    data: json<Item>("data").notNull(),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.sessionId, t.id] }),
    index("items_thread").on(t.sessionId, t.threadId, t.position),
  ],
);

export const inboxItems = sqliteTable(
  "inbox_items",
  {
    id: text("id").primaryKey(),
    kind: text("kind").notNull(),
    status: text("status").notNull(),
    priority: text("priority").notNull().default("normal"),
    notify: text("notify").notNull().default("needs_you"),
    title: text("title").notNull(),
    body: text("body"),
    projectId: text("project_id"),
    sessionId: text("session_id"),
    threadId: text("thread_id"),
    itemId: text("item_id"),
    requestId: text("request_id"),
    issue: json<GitHubIssueRef>("issue"),
    pr: json<GitHubPrRef>("pr"),
    automationRunId: text("automation_run_id"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
    resolvedAt: text("resolved_at"),
    resolution: json<JsonValue>("resolution"),
  },
  (t) => [index("inbox_status").on(t.status)],
);

export const automations = sqliteTable("automations", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  description: text("description"),
  enabled: integer("enabled", { mode: "boolean" }).notNull().default(false),
  source: text("source").notNull(),
  templateId: text("template_id"),
  trigger: json<Automation["trigger"]>("trigger").notNull(),
  action: json<Automation["action"]>("action").notNull(),
  target: json<Automation["target"]>("target").notNull(),
  guards: json<Automation["guards"]>("guards").notNull(),
  workKey: text("work_key"),
  /** `user` (or null), `pm` or `import`. */
  createdBy: text("created_by").$type<NonNullable<Automation["createdBy"]>>(),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

export const automationRuns = sqliteTable(
  "automation_runs",
  {
    id: text("id").primaryKey(),
    automationId: text("automation_id").notNull(),
    projectId: text("project_id"),
    status: text("status").notNull(),
    triggeredBy: text("triggered_by").notNull(),
    startedBy: json<StartedBy>("started_by").notNull(),
    purpose: text("purpose").notNull(),
    workKey: text("work_key").notNull(),
    scope: json<WorkScope>("scope").notNull(),
    progress: json<WorkProgress>("progress"),
    skipReason: text("skip_reason").$type<AutomationRun["skipReason"]>(),
    sessionId: text("session_id"),
    /** The issue an issue-triggered run is about (triage waits for its report). */
    issueNumber: integer("issue_number"),
    startedAt: text("started_at").notNull(),
    finishedAt: text("finished_at"),
    error: json<ErrorInfo>("error"),
  },
  (t) => [
    index("automation_runs_automation").on(t.automationId, t.startedAt),
    index("automation_runs_work_key").on(t.projectId, t.workKey),
  ],
);

export const artifacts = sqliteTable("artifacts", {
  id: text("id").primaryKey(),
  kind: text("kind").notNull(),
  name: text("name").notNull(),
  mediaType: text("media_type").notNull(),
  path: text("path").notNull(),
  sizeBytes: integer("size_bytes").notNull(),
  sha256: text("sha256"),
  projectId: text("project_id"),
  sessionId: text("session_id"),
  threadId: text("thread_id"),
  itemId: text("item_id"),
  createdAt: text("created_at").notNull(),
});

/** Highest runner event seq durably stored, per runner id (drives `resume` and acks). */
export const runnerState = sqliteTable("runner_state", {
  runnerId: text("runner_id").primaryKey(),
  lastAckedSeq: integer("last_acked_seq").notNull().default(0),
  updatedAt: text("updated_at").notNull(),
});

/** Turn checkpoints (§9), projected from `checkpoint.created`; the source of turn diffs. */
export const checkpoints = sqliteTable(
  "checkpoints",
  {
    sessionId: text("session_id").notNull(),
    index: integer("idx").notNull(),
    ref: text("ref").notNull(),
    commit: text("commit_sha").notNull(),
    turnId: text("turn_id"),
    createdAt: text("created_at").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.sessionId, t.index] }),
    index("checkpoints_turn").on(t.sessionId, t.turnId),
  ],
);

/** Messages queued behind a running turn (`message.queued` / `message.dequeued`). */
export const queuedMessages = sqliteTable(
  "queued_messages",
  {
    id: text("id").primaryKey(),
    sessionId: text("session_id").notNull(),
    input: json<UserInput>("input").notNull(),
    /** Who queued it; null for rows written before senders were recorded (the user). */
    sender: text("sender").$type<QueueSender>(),
    createdAt: text("created_at").notNull(),
  },
  (t) => [index("queued_messages_session").on(t.sessionId, t.createdAt)],
);

/**
 * Per-session MCP bearer tokens (§8.3, §15). Only a SHA-256 hash is stored; the token itself
 * exists in memory and in the agent process config. Not event-sourced: tokens are secrets.
 */
export const mcpTokens = sqliteTable(
  "mcp_tokens",
  {
    id: text("id").primaryKey(),
    tokenHash: text("token_hash").notNull(),
    role: text("role").notNull(),
    sessionId: text("session_id").notNull(),
    projectId: text("project_id"),
    createdAt: text("created_at").notNull(),
    revokedAt: text("revoked_at"),
  },
  (t) => [
    uniqueIndex("mcp_tokens_hash").on(t.tokenHash),
    index("mcp_tokens_session").on(t.sessionId),
  ],
);

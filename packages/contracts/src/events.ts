import { z } from "zod";
import {
  type AgentEvent,
  ItemCompletedEvent,
  ItemDeltaEvent,
  ItemStartedEvent,
  ItemUpdatedEvent,
  SessionUpdatedEvent,
  ThreadStartedEvent,
  TurnCompletedEvent,
  TurnFailedEvent,
  TurnInterruptedEvent,
  TurnStartedEvent,
  UsageUpdatedEvent,
} from "./agent-events";
import { Id, Timestamp } from "./common";
import { Artifact } from "./entities/artifact";
import { Automation, AutomationRun } from "./entities/automation";
import { InboxItem } from "./entities/inbox";
import { Project } from "./entities/project";
import { Session } from "./entities/session";
import { FACTORY_EVENT_PAYLOADS } from "./factory-api";
import { GITHUB_EVENT_PAYLOADS } from "./github";
import { ConflictRecord, Notice } from "./orchestration";
import { PtyId } from "./runner/commands";
import { RunnerDeletedPayload, RunnerRecordRef, RunnerRegisteredPayload } from "./runners";
import { Settings } from "./settings";
import { Checkpoint, QueuedMessage, SetupStep } from "./workbench";

/**
 * Untyped row of the append-only `events` table (§6): `seq, session_id, type, payload, ts`.
 * Use `EventEnvelope` to parse it into the typed union.
 */
export const RawEventEnvelope = z.object({
  /** Global, monotonically increasing sequence number assigned by the server. */
  seq: z.int().positive(),
  /** Session the event belongs to; null for global events (projects, settings, runner). */
  sessionId: Id.nullable(),
  type: z.string(),
  payload: z.unknown(),
  ts: Timestamp,
});
export type RawEventEnvelope = z.infer<typeof RawEventEnvelope>;

const base = { seq: z.int().positive(), sessionId: Id.nullable(), ts: Timestamp };
const sessionBase = { seq: z.int().positive(), sessionId: Id, ts: Timestamp };

function globalEvent<T extends string, P extends z.ZodType>(type: T, payload: P) {
  return z.object({ ...base, type: z.literal(type), payload });
}

function agentEvent<T extends string, P extends z.ZodType>(type: T, payload: P) {
  return z.object({ ...sessionBase, type: z.literal(`agent.${type}` as `agent.${T}`), payload });
}

/** Prefix used for persisted agent events: `agent.turn.started`, `agent.item.delta`, ... */
export const AGENT_EVENT_PREFIX = "agent.";

/**
 * Typed persisted event. Agent events (§7.3) are stored as `agent.<type>` with the
 * normalized `AgentEvent` as payload; the rest are domain events written by the server
 * in the same transaction as the projections they update.
 */
export const EventEnvelope = z.discriminatedUnion("type", [
  // Agent events, from runners.
  agentEvent("session.updated", SessionUpdatedEvent),
  agentEvent("thread.started", ThreadStartedEvent),
  agentEvent("turn.started", TurnStartedEvent),
  agentEvent("turn.completed", TurnCompletedEvent),
  agentEvent("turn.failed", TurnFailedEvent),
  agentEvent("turn.interrupted", TurnInterruptedEvent),
  agentEvent("item.started", ItemStartedEvent),
  agentEvent("item.delta", ItemDeltaEvent),
  agentEvent("item.updated", ItemUpdatedEvent),
  agentEvent("item.completed", ItemCompletedEvent),
  agentEvent("usage.updated", UsageUpdatedEvent),
  // Domain events.
  globalEvent("project.created", z.object({ project: Project })),
  globalEvent("project.updated", z.object({ project: Project })),
  globalEvent("project.archived", z.object({ projectId: Id })),
  /**
   * The user rearranged the project list (§13). `projectIds` is every non-archived project in
   * its new order; each one's `sortOrder` becomes its index. Archived projects keep theirs.
   */
  globalEvent("projects.reordered", z.object({ projectIds: z.array(Id) })),
  globalEvent("session.created", z.object({ session: Session })),
  /** Any change to a session row, including status transitions. */
  globalEvent("session.updated", z.object({ session: Session })),
  globalEvent("inbox.created", z.object({ item: InboxItem })),
  globalEvent("inbox.updated", z.object({ item: InboxItem })),
  globalEvent("automation.saved", z.object({ automation: Automation })),
  globalEvent("automation.deleted", z.object({ automationId: Id })),
  globalEvent("automation_run.updated", z.object({ run: AutomationRun })),
  /**
   * Scheduler state of an automation in a project changed (paused, resumed, next run skipped
   * or advanced, per-project override), or a project's automation switch (`automationId` null).
   * A hint for live views to refetch; the state itself is operational and not projected.
   */
  globalEvent(
    "automation.updated",
    z.object({ automationId: Id.nullable(), projectId: Id.nullable() }),
  ),
  globalEvent("artifact.created", z.object({ artifact: Artifact })),
  globalEvent("settings.updated", z.object({ settings: Settings })),
  /**
   * The server added a runner, or re-registered one with new details (projected into
   * `runners`). The home runner is registered on every start.
   */
  globalEvent("runner.registered", RunnerRegisteredPayload),
  /** A runner's sandbox is gone; its record stays with state `deleted`. */
  globalEvent("runner.deleted", RunnerDeletedPayload),
  /** The server connected to a runner. `id` is its record id (none: the home runner). */
  globalEvent(
    "runner.connected",
    z.object({
      ...RunnerRecordRef,
      runnerId: z.string(),
      version: z.string(),
      protocolVersion: z.int(),
    }),
  ),
  /** The server lost its connection to a runner. `id` is its record id (none: home). */
  globalEvent(
    "runner.disconnected",
    z.object({ ...RunnerRecordRef, runnerId: z.string(), reason: z.string() }),
  ),
  /** The runner started draining (upgrade or shutdown); its sessions resume afterwards. */
  globalEvent(
    "runner.draining",
    z.object({ ...RunnerRecordRef, runnerId: z.string(), reason: z.string() }),
  ),
  /** Progress of a worktree setup command (projected into the session's start metadata). */
  globalEvent("session.setup", z.object({ sessionId: Id, step: SetupStep })),
  /** A turn checkpoint was written (projected into `checkpoints`, used for diffs). */
  globalEvent("checkpoint.created", z.object({ checkpoint: Checkpoint })),
  /** A message was queued behind the running turn. */
  globalEvent("message.queued", z.object({ message: QueuedMessage })),
  /** A queued message left the queue: delivered, dropped (interrupt, stop) or deleted. */
  globalEvent(
    "message.dequeued",
    z.object({ sessionId: Id, messageId: Id, reason: z.enum(["sent", "dropped", "deleted"]) }),
  ),
  /** A queued message's text was edited before delivery; its attachments stay. */
  globalEvent(
    "message.edited",
    z.object({ sessionId: Id, messageId: Id, text: z.string(), at: Timestamp }),
  ),
  /** A typed orchestration notice for a PM or the orchestrator (§8.2). */
  globalEvent("notice.created", z.object({ notice: Notice })),
  /** Notices delivered to their target (a wake, or shown in a digest). */
  globalEvent("notice.delivered", z.object({ noticeIds: z.array(Id), at: Timestamp })),
  /**
   * Delivered notices back to undelivered: the role session's turn that carried them failed, so
   * the next wake carries them again (§8.2).
   */
  globalEvent("notice.returned", z.object({ noticeIds: z.array(Id), at: Timestamp })),
  /** A start request matched running work; persisted with its `conflict` inbox item (§8.4). */
  globalEvent("conflict.created", z.object({ conflict: ConflictRecord })),
  /** A runner terminal exited. */
  globalEvent("pty.exited", z.object({ ptyId: PtyId, exitCode: z.int().nullable() })),
  // GitHub sync (§9); `sessionId` is the PR's linked session when there is one.
  globalEvent("github.synced", GITHUB_EVENT_PAYLOADS["github.synced"]),
  globalEvent("issue.opened", GITHUB_EVENT_PAYLOADS["issue.opened"]),
  globalEvent("issue.labeled", GITHUB_EVENT_PAYLOADS["issue.labeled"]),
  globalEvent("issue.updated", GITHUB_EVENT_PAYLOADS["issue.updated"]),
  globalEvent("issue.commented", GITHUB_EVENT_PAYLOADS["issue.commented"]),
  globalEvent("pr.opened", GITHUB_EVENT_PAYLOADS["pr.opened"]),
  globalEvent("pr.updated", GITHUB_EVENT_PAYLOADS["pr.updated"]),
  globalEvent("pr.review_requested", GITHUB_EVENT_PAYLOADS["pr.review_requested"]),
  globalEvent("pr.checks_passed", GITHUB_EVENT_PAYLOADS["pr.checks_passed"]),
  globalEvent("pr.checks_failed", GITHUB_EVENT_PAYLOADS["pr.checks_failed"]),
  globalEvent("pr.merged", GITHUB_EVENT_PAYLOADS["pr.merged"]),
  globalEvent("pr.closed", GITHUB_EVENT_PAYLOADS["pr.closed"]),
  globalEvent("review.submitted", GITHUB_EVENT_PAYLOADS["review.submitted"]),
  // Factory loop (§10.1): the loop record, work items (with merge checks) and daily digests.
  globalEvent("factory.loop.updated", FACTORY_EVENT_PAYLOADS["factory.loop.updated"]),
  globalEvent("factory.item.updated", FACTORY_EVENT_PAYLOADS["factory.item.updated"]),
  globalEvent("factory.digest.created", FACTORY_EVENT_PAYLOADS["factory.digest.created"]),
]);
export type EventEnvelope = z.infer<typeof EventEnvelope>;
export type EventType = EventEnvelope["type"];
/** Narrow an envelope by type: `EventOf<"session.created">`. */
export type EventOf<T extends EventType> = Extract<EventEnvelope, { type: T }>;

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
/** An event before the store assigns `seq` and `ts`. */
export type NewEvent = DistributiveOmit<EventEnvelope, "seq" | "ts">;

/** Build the persisted form of an agent event for a session. */
export function agentEventToNewEvent(sessionId: string, event: AgentEvent): NewEvent {
  return {
    sessionId,
    type: `${AGENT_EVENT_PREFIX}${event.type}`,
    payload: event,
  } as NewEvent;
}

/** True when a persisted event carries an agent event payload. */
export function isAgentEnvelope(
  e: EventEnvelope,
): e is Extract<EventEnvelope, { type: `agent.${string}` }> {
  return e.type.startsWith(AGENT_EVENT_PREFIX);
}

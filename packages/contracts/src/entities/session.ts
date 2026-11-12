import { z } from "zod";
import {
  AutonomyLevel,
  ErrorInfo,
  GitHubIssueRef,
  GitHubPrRef,
  Id,
  ProviderId,
  ReasoningEffort,
  Role,
  Timestamp,
} from "../common";
import { Item } from "../items";
import { workFields } from "../work";
import { SessionResult } from "../workbench";

/**
 * Session lifecycle.
 * - `created`: row exists, nothing started on a runner yet.
 * - `queued`: waiting behind conflicting work (§8.4 `wait`).
 * - `starting`: workspace prepared / provider process launching.
 * - `running`: a turn is in progress.
 * - `waiting`: blocked on the user (approval or question).
 * - `idle`: between turns, ready for input.
 * - `interrupted`: cut off (runner restart, crash); resumable.
 * - `completed` / `failed` / `stopped`: terminal.
 */
export const SessionStatus = z.enum([
  "created",
  "queued",
  "starting",
  "running",
  "waiting",
  "idle",
  "interrupted",
  "completed",
  "failed",
  "stopped",
]);
export type SessionStatus = z.infer<typeof SessionStatus>;

/**
 * Where a forked session came from: the source session and the checkpoint its worktree
 * started from (null when the source had none yet). The fork continues the source's
 * conversation through the provider's native fork; the source is left as it was.
 */
export const ForkOrigin = z.object({
  sessionId: Id,
  checkpoint: z.int().nonnegative().nullable(),
  /**
   * The source's turn the fork was taken at ("Fork from here"): its conversation ends with
   * that turn and its code is that turn's checkpoint. Absent or null: the source's latest
   * moment.
   */
  turnId: Id.nullable().optional(),
});
export type ForkOrigin = z.infer<typeof ForkOrigin>;

/** An agent session of any role (§8.1). */
export const Session = z.object({
  id: Id,
  /** Null for the orchestrator. */
  projectId: Id.nullable(),
  role: Role,
  /** The session that started this one (PM for agents, orchestrator for PMs). */
  parentSessionId: Id.nullable(),
  /** Who/why/what (§8.4): startedBy, purpose, workKey, scope, progress. */
  ...workFields,
  title: z.string().nullable(),
  provider: ProviderId,
  model: z.string().nullable(),
  effort: ReasoningEffort.nullable(),
  autonomy: AutonomyLevel,
  /**
   * True while the session is planning (where the provider reports `capabilities.planMode`):
   * the agent explores and proposes a plan, and implements only once the plan is approved.
   * Absent means false.
   */
  planMode: z.boolean().optional(),
  status: SessionStatus,
  /** Directory the agent runs in. */
  cwd: z.string(),
  /** Set when the session owns a worktree under `~/.codeden/wt/`. */
  worktreePath: z.string().nullable(),
  branch: z.string().nullable(),
  baseBranch: z.string().nullable(),
  issue: GitHubIssueRef.nullable(),
  pr: GitHubPrRef.nullable(),
  /** Provider resume token (session/thread id). */
  resumeToken: z.string().nullable(),
  /** Runner currently hosting the session. */
  runnerId: z.string().nullable(),
  automationRunId: Id.nullable(),
  /** The session's root thread, once the provider started it. */
  rootThreadId: Id.nullable(),
  /** Structured result from the agent's `finish` tool, once reported. */
  result: SessionResult.nullable().optional(),
  /** When the session was archived: hidden from the sidebar, its worktree cleaned up. */
  archivedAt: Timestamp.nullable().optional(),
  /**
   * When CodeDen removed the session's worktree (archive or inactivity cleanup). The branch and
   * checkpoints stay; the worktree is recreated from the branch on the next message.
   */
  worktreeRemovedAt: Timestamp.nullable().optional(),
  /** Set when the session was forked from another one (its conversation and code). */
  forkedFrom: ForkOrigin.nullable().optional(),
  createdAt: Timestamp,
  updatedAt: Timestamp,
  endedAt: Timestamp.nullable(),
});
export type Session = z.infer<typeof Session>;

/** Thread projection (§6 `threads`). */
export const Thread = z.object({
  id: Id,
  sessionId: Id,
  parentThreadId: Id.nullable(),
  parentItemId: Id.nullable(),
  title: z.string().nullable(),
  agentType: z.string().nullable(),
  createdAt: Timestamp,
});
export type Thread = z.infer<typeof Thread>;

export const TurnStatus = z.enum(["running", "completed", "failed", "interrupted"]);
export type TurnStatus = z.infer<typeof TurnStatus>;

/** Turn projection (§6 `turns`). */
export const Turn = z.object({
  id: Id,
  threadId: Id,
  sessionId: Id,
  status: TurnStatus,
  startedAt: Timestamp,
  completedAt: Timestamp.nullable(),
  error: ErrorInfo.nullable(),
  /**
   * The provider's position at the end of this turn (`forkPoint` on its end event): the
   * conversation can be forked through this turn. Absent or null when it can't, e.g. a turn
   * recorded before CodeDen kept these, or a provider that doesn't report them.
   */
  forkPoint: z.string().nullable().optional(),
});
export type Turn = z.infer<typeof Turn>;

/** Item projection (§6 `items`): the latest state of an item plus its location. */
export const ItemRecord = z.object({
  sessionId: Id,
  threadId: Id,
  turnId: Id,
  /** Order within the thread. */
  position: z.int().nonnegative(),
  item: Item,
  createdAt: Timestamp,
  updatedAt: Timestamp,
});
export type ItemRecord = z.infer<typeof ItemRecord>;

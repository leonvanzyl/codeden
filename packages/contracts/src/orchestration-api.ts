import { z } from "zod";
import { StartSessionRequest, StartSessionResponse } from "./api";
import { AutonomyLevel, Id, ReasoningEffort } from "./common";
import { InboxItemStatus } from "./entities/inbox";
import { Session } from "./entities/session";
import { UserInput } from "./input";
import { ConflictRecord, NoticeTarget } from "./orchestration";
import { ConflictDecision } from "./work";

/** HTTP shapes for the orchestrator and PM chats, notices and conflicts (`/api/orchestration`). */

/** `GET|POST /api/orchestration/orchestrator` and `.../projects/:id/pm`. */
export const RoleSessionResponse = z.object({ session: Session.nullable() });
export type RoleSessionResponse = z.infer<typeof RoleSessionResponse>;

/** `POST .../orchestrator/messages` and `.../projects/:id/pm/messages`. */
export const RoleMessageRequest = z.object({
  input: UserInput,
  whenBusy: z.enum(["queue", "steer", "reject"]).default("queue"),
});
export type RoleMessageRequest = z.infer<typeof RoleMessageRequest>;
export type RoleMessageRequestInit = z.input<typeof RoleMessageRequest>;

export const RoleMessageResponse = z.object({
  sessionId: Id,
  status: z.enum(["sent", "queued", "steered"]),
});
export type RoleMessageResponse = z.infer<typeof RoleMessageResponse>;

/** `GET /api/orchestration/notices` query. */
export const ListNoticesQuery = z.object({
  projectId: Id.optional(),
  target: NoticeTarget.optional(),
  limit: z.coerce.number().int().min(1).max(500).default(100),
});
export type ListNoticesQuery = z.infer<typeof ListNoticesQuery>;

/** `GET /api/conflicts` query. Defaults to open conflicts. */
export const ListConflictsQuery = z.object({
  status: InboxItemStatus.optional(),
  projectId: Id.optional(),
});
export type ListConflictsQuery = z.infer<typeof ListConflictsQuery>;

/**
 * `POST /api/conflicts/:id/resolve`: the decision (wait, skip, join or force with a reason).
 * `start` replaces the request saved with the conflict: the New session draft as it is when the
 * card is answered, so edits made after the first send are what starts. Same project only.
 */
export const ResolveConflictRequest = ConflictDecision.and(
  z.object({ start: StartSessionRequest.optional() }),
);
export type ResolveConflictRequest = z.infer<typeof ResolveConflictRequest>;
export type ResolveConflictRequestInit = z.input<typeof ResolveConflictRequest>;

export const ResolveConflictResponse = z.object({
  conflict: ConflictRecord,
  result: StartSessionResponse,
});
export type ResolveConflictResponse = z.infer<typeof ResolveConflictResponse>;

/**
 * `PATCH /api/sessions/:id`: change the model, effort, autonomy, plan mode or title
 * mid-session. Model and effort apply on the next turn (a running turn keeps its settings);
 * `null` returns to the role default.
 */
export const UpdateSessionRequest = z
  .object({
    model: z.string().min(1).nullable().optional(),
    effort: ReasoningEffort.nullable().optional(),
    /**
     * Autonomy level (§11.2), saved on the session and pushed to the live provider session.
     * It applies from the next tool call when the provider reports `liveAutonomy`, otherwise
     * from the next turn. Approvals already waiting stay waiting.
     */
    autonomy: AutonomyLevel.optional(),
    /**
     * Turn plan mode on or off (agent sessions on a provider with `capabilities.planMode`).
     * Saved on the session and pushed to the live provider session like `autonomy`. Off
     * returns the agent to the session's permission level.
     */
    planMode: z.boolean().optional(),
    title: z.string().trim().min(1).max(200).optional(),
  })
  .refine(
    (r) =>
      r.model !== undefined ||
      r.effort !== undefined ||
      r.autonomy !== undefined ||
      r.planMode !== undefined ||
      r.title !== undefined,
    { message: "Nothing to change" },
  );
export type UpdateSessionRequest = z.infer<typeof UpdateSessionRequest>;

/**
 * `POST /api/sessions/:id/archive`: stop the session if it is running, hide it from the
 * sidebar and remove its worktree. The branch and checkpoints stay.
 */
export const ArchiveSessionRequest = z.object({
  /** Remove the worktree even when it has uncommitted changes (those changes are lost). */
  force: z.boolean().default(false),
});
export type ArchiveSessionRequest = z.infer<typeof ArchiveSessionRequest>;

/**
 * What worktree cleanup did: `removed` (`message` notes discarded uncommitted changes);
 * `kept_changes` (uncommitted changes, not forced); `none` (no worktree,
 * or already removed); `failed` (runner unavailable, a file in use; `message` says why).
 */
export const WorktreeCleanupOutcome = z.object({
  status: z.enum(["removed", "kept_changes", "none", "failed"]),
  message: z.string().nullable(),
});
export type WorktreeCleanupOutcome = z.infer<typeof WorktreeCleanupOutcome>;

/** `POST /api/sessions/:id/archive` response. */
export const ArchiveSessionResponse = z.object({
  session: Session,
  worktree: WorktreeCleanupOutcome,
});
export type ArchiveSessionResponse = z.infer<typeof ArchiveSessionResponse>;

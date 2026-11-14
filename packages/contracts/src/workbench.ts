import { z } from "zod";
import { Id, Timestamp } from "./common";
import { MessageSender, UserInput } from "./input";
import { CheckpointIndex, PtyId } from "./runner/commands";

/**
 * Workbench data (§9, §12): turn checkpoints, workspace setup output, persisted message
 * queues, structured session results, diffs, git operations and the terminal channel.
 */

/** A turn checkpoint recorded by the server from the runner's `checkpoint.created` (§9). */
export const Checkpoint = z.object({
  sessionId: Id,
  /** 0 is the baseline at session start; n the end of turn n. */
  index: CheckpointIndex,
  /** `refs/codeden/checkpoints/<session>/<index>`. */
  ref: z.string(),
  commit: z.string(),
  /** The turn that ended; null for the baseline. */
  turnId: Id.nullable(),
  createdAt: Timestamp,
});
export type Checkpoint = z.infer<typeof Checkpoint>;

/** One worktree setup command (`.codeden/project.json` `setup`, §9) and its latest output. */
export const SetupStep = z.object({
  command: z.string(),
  status: z.enum(["running", "succeeded", "failed"]),
  /** Tail of the command's output (bounded). */
  output: z.string(),
  updatedAt: Timestamp,
});
export type SetupStep = z.infer<typeof SetupStep>;

/** Who queued a message: the same senders as `MessageSender`. */
export const QueueSender = MessageSender;
export type QueueSender = MessageSender;

/** A message sent while a turn was running, waiting to be delivered (survives restarts). */
export const QueuedMessage = z.object({
  id: Id,
  sessionId: Id,
  input: UserInput,
  /** Who queued it. Events written before senders were recorded were all the user's. */
  from: QueueSender.default("user"),
  createdAt: Timestamp,
});
export type QueuedMessage = z.infer<typeof QueuedMessage>;

/** `GET /api/sessions/:id/queue`: the session's queued messages, next to be delivered first. */
export const QueuedMessageList = z.object({ messages: z.array(QueuedMessage) });
export type QueuedMessageList = z.infer<typeof QueuedMessageList>;

/**
 * `PATCH /api/sessions/:id/queue/:messageId`: replace a queued message's text (attachments
 * stay). Answers 409 `already_sent` once delivery has taken the message.
 */
export const EditQueuedMessageRequest = z.object({ text: z.string().max(200_000) });
export type EditQueuedMessageRequest = z.infer<typeof EditQueuedMessageRequest>;

/**
 * `POST /api/sessions/:id/queue/:messageId/send-now`: steer the running turn with a queued
 * message (needs `capabilities.steer`). Answers 409 `no_turn` when no turn is running (the
 * queue sends it next) and 409 `unsupported` when the provider cannot steer.
 * `DELETE /api/sessions/:id/queue/:messageId` answers `{ ok: true }`; both answer 409
 * `already_sent` once delivery has taken the message.
 */
export const SendQueuedNowResponse = z.object({ status: z.literal("steered") });
export type SendQueuedNowResponse = z.infer<typeof SendQueuedNowResponse>;

/** Structured result an agent reports with the `finish` tool (§8.3). */
export const SessionResult = z.object({
  outcome: z.enum(["success", "partial", "failed", "blocked"]),
  summary: z.string().min(1),
  /** Files the agent changed, when it reports them. */
  changedFiles: z.array(z.string()).optional(),
  /** Tests or checks run and how they went. */
  tests: z.string().optional(),
  /** Anything a human or PM should do next. */
  nextSteps: z.array(z.string()).optional(),
  at: Timestamp,
});
export type SessionResult = z.infer<typeof SessionResult>;

// ---------------------------------------------------------------------------- diffs

/**
 * What a diff covers: the whole session, one turn, uncommitted changes in the worktree, or
 * `compare`: another session's latest checkpoint against this session's working tree (§12.3),
 * so `+` lines are this session's and `−` lines the other's. The other session must be in the
 * same project and on the same runner (it shares the repository's objects).
 */
export const DiffScope = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("session") }),
  z.object({ kind: z.literal("turn"), turnId: Id }),
  z.object({ kind: z.literal("uncommitted") }),
  z.object({ kind: z.literal("compare"), sessionId: Id }),
]);
export type DiffScope = z.infer<typeof DiffScope>;

/** The other session's checkpoint a `compare` diff starts from. */
export const DiffAgainst = z.object({
  sessionId: Id,
  /** Its checkpoint number (0 is its baseline). */
  index: CheckpointIndex,
  /** When that checkpoint was written. */
  at: Timestamp,
});
export type DiffAgainst = z.infer<typeof DiffAgainst>;

/** One file of a diff, with its unified patch. */
export const DiffFile = z.object({
  path: z.string(),
  previousPath: z.string().optional(),
  change: z.enum(["add", "modify", "delete", "rename"]),
  additions: z.int().nonnegative(),
  deletions: z.int().nonnegative(),
  binary: z.boolean().optional(),
  /** Unified patch for this file. */
  patch: z.string(),
});
export type DiffFile = z.infer<typeof DiffFile>;

/** `POST /api/sessions/:id/diff` (body: `DiffScope`). */
export const DiffResult = z.object({
  scope: DiffScope,
  files: z.array(DiffFile),
  /** Turns that have checkpoints, oldest first. */
  turns: z.array(z.object({ id: Id, index: CheckpointIndex, label: z.string(), at: Timestamp })),
  /** For a `compare` diff: the other session's checkpoint it starts from. */
  against: DiffAgainst.optional(),
});
export type DiffResult = z.infer<typeof DiffResult>;

/** `GET /api/sessions/:id/checkpoints`. */
export const CheckpointList = z.object({ checkpoints: z.array(Checkpoint) });
export type CheckpointList = z.infer<typeof CheckpointList>;

/**
 * `POST /api/sessions/:id/restore`: put files (all, or `paths`) back to their state at a
 * checkpoint. `turnId` restores to the state *before* that turn; `index` names a checkpoint.
 */
export const RestoreFilesRequest = z
  .object({
    turnId: Id.optional(),
    index: CheckpointIndex.optional(),
    paths: z.array(z.string().min(1)).optional(),
  })
  .refine((r) => (r.turnId === undefined) !== (r.index === undefined), {
    message: "Pass exactly one of turnId or index",
  });
export type RestoreFilesRequest = z.infer<typeof RestoreFilesRequest>;

export const RestoreFilesResponse = z.object({
  index: CheckpointIndex,
  restored: z.array(z.string()),
  deleted: z.array(z.string()),
});
export type RestoreFilesResponse = z.infer<typeof RestoreFilesResponse>;

// ---------------------------------------------------------------------------- git

/** `GET /api/sessions/:id/git/status`. */
export const GitStatusResponse = z.object({
  branch: z.string().nullable(),
  baseBranch: z.string().nullable(),
  ahead: z.int().nonnegative(),
  behind: z.int().nonnegative(),
  files: z.array(z.object({ path: z.string(), status: z.string() })),
});
export type GitStatusResponse = z.infer<typeof GitStatusResponse>;

/** `POST /api/sessions/:id/git/commit`: stage (all, or `paths`) and commit. */
export const GitCommitRequest = z.object({
  message: z.string().min(1).max(10_000),
  paths: z.array(z.string().min(1)).optional(),
});
export type GitCommitRequest = z.infer<typeof GitCommitRequest>;

/** `commit` is null when there was nothing to commit. */
export const GitCommitResponse = z.object({ commit: z.string().nullable() });
export type GitCommitResponse = z.infer<typeof GitCommitResponse>;

/** `POST /api/sessions/:id/git/push`. */
export const GitPushRequest = z.object({
  remote: z.string().min(1).optional(),
  forceWithLease: z.boolean().optional(),
});
export type GitPushRequest = z.infer<typeof GitPushRequest>;

export const GitPushResponse = z.object({ remote: z.string(), branch: z.string() });
export type GitPushResponse = z.infer<typeof GitPushResponse>;

// ---------------------------------------------------------------------------- terminal

/**
 * `GET /ws/pty?sessionId=&ptyId=&command=&cols=&rows=` opens (or, with `ptyId`, attaches to)
 * a runner terminal. Without `sessionId` the terminal opens in the CodeDen home folder.
 * Server -> client frames are plain text (terminal output) except for `TerminalServerMessage`
 * control frames, which are JSON objects prefixed with `\u0000`.
 */
export const TerminalQuery = z.object({
  sessionId: Id.optional(),
  /** Attach to an existing terminal instead of opening a new one. */
  ptyId: PtyId.optional(),
  /** Run this command in the shell once it starts (e.g. `claude auth login`). */
  command: z.string().max(2_000).optional(),
  cols: z.coerce.number().int().positive().max(1_000).default(120),
  rows: z.coerce.number().int().positive().max(500).default(30),
});
export type TerminalQuery = z.infer<typeof TerminalQuery>;

/** Client -> server messages on a terminal socket (JSON text frames). */
export const TerminalClientMessage = z.discriminatedUnion("type", [
  z.object({ type: z.literal("input"), data: z.string().max(1_000_000) }),
  z.object({
    type: z.literal("resize"),
    cols: z.int().positive().max(1_000),
    rows: z.int().positive().max(500),
  }),
  /** Kill the terminal process (closing the socket only detaches). */
  z.object({ type: z.literal("kill") }),
]);
export type TerminalClientMessage = z.infer<typeof TerminalClientMessage>;

/** Server -> client control frames (sent as `\u0000` + JSON). */
export const TerminalServerMessage = z.discriminatedUnion("type", [
  z.object({ type: z.literal("opened"), ptyId: PtyId, pid: z.int(), attached: z.boolean() }),
  z.object({ type: z.literal("exited"), ptyId: PtyId, exitCode: z.int().nullable() }),
  z.object({ type: z.literal("error"), message: z.string() }),
]);
export type TerminalServerMessage = z.infer<typeof TerminalServerMessage>;

/** Prefix that marks a terminal control frame. */
export const TERMINAL_CONTROL_PREFIX = "\u0000";

// ---------------------------------------------------------------------------- utility

/** `POST /api/utility/speech-summary`: compress a final message for read-aloud (§11.3). */
export const SpeechSummaryRequest = z.object({ text: z.string().min(1).max(200_000) });
export type SpeechSummaryRequest = z.infer<typeof SpeechSummaryRequest>;

/** `source: "plain"` when the utility model was off or failed and the text was only cleaned. */
export const SpeechSummaryResponse = z.object({
  text: z.string(),
  source: z.enum(["utility", "plain"]),
});
export type SpeechSummaryResponse = z.infer<typeof SpeechSummaryResponse>;

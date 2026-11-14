import { z } from "zod";
import { Usage } from "./agent-events";
import {
  AutonomyLevel,
  ErrorInfo,
  GitHubIssueRef,
  Id,
  ProviderId,
  ReasoningEffort,
  Role,
  Timestamp,
} from "./common";
import { InboxItem, InboxItemKind, InboxItemStatus } from "./entities/inbox";
import { GitHubRepo, Project } from "./entities/project";
import { ItemRecord, Session, SessionStatus, Thread, Turn } from "./entities/session";
import { UserInput } from "./input";
import { FollowupsItem } from "./items";
import { BrokenExecutable, ProviderInfo, RuntimeResponse } from "./provider";
import { ConflictDecision, StartedBy, StartWorkResult, WorkKey } from "./work";
import { SetupStep } from "./workbench";
import { ClientSubscribe, ClientToServerMessage, ServerToClientMessage } from "./ws";

/**
 * HTTP API request/response shapes (`/api/*`) and the UI WebSocket extensions for live
 * transcripts. The server validates every request body and query with these schemas; the web
 * app types against them (and the Hono RPC `AppType`).
 */

/** Error body returned by every failing API route. */
export const ApiError = z.object({ error: ErrorInfo });
export type ApiError = z.infer<typeof ApiError>;

// ---------------------------------------------------------------- projects

/** Package managers CodeDen recognises when adding a project (§14 step 5). */
export const PackageManager = z.enum(["pnpm", "npm", "yarn", "bun"]);
export type PackageManager = z.infer<typeof PackageManager>;

/** Where a new project comes from: an existing folder, or a git URL to clone. */
export const ProjectSource = z.discriminatedUnion("type", [
  z.object({ type: z.literal("local"), path: z.string().min(1) }),
  z.object({
    type: z.literal("clone"),
    /** `https://github.com/owner/repo(.git)`, `git@github.com:owner/repo.git`, or `owner/repo`. */
    url: z.string().min(1),
    /**
     * Exact target folder. When omitted the repo is cloned into `<parentDir>/<repo>`, with
     * `parentDir` defaulting to `~/codeden-projects`.
     */
    path: z.string().min(1).optional(),
    parentDir: z.string().min(1).optional(),
  }),
]);
export type ProjectSource = z.infer<typeof ProjectSource>;

/** `POST /api/projects`. */
export const CreateProjectRequest = z.object({
  source: ProjectSource,
  /** Display name; defaults to the folder name. */
  name: z.string().trim().min(1).max(100).optional(),
  defaultProvider: ProviderId.nullable().optional(),
  autonomy: AutonomyLevel.nullable().optional(),
});
export type CreateProjectRequest = z.infer<typeof CreateProjectRequest>;

/** What CodeDen found in a project folder. */
export const ProjectDetection = z.object({
  isGitRepo: z.boolean(),
  /** Top level of the git checkout (may differ from the chosen folder). */
  gitRoot: z.string().nullable(),
  remoteUrl: z.string().nullable(),
  github: GitHubRepo.nullable(),
  defaultBranch: z.string().nullable(),
  currentBranch: z.string().nullable(),
  packageManager: PackageManager.nullable(),
  /** Suggested worktree setup commands, e.g. `pnpm install`. */
  suggestedSetupCommands: z.array(z.string()),
});
export type ProjectDetection = z.infer<typeof ProjectDetection>;

/** `POST /api/projects` response. */
export const CreateProjectResponse = z.object({
  project: Project,
  detected: ProjectDetection,
});
export type CreateProjectResponse = z.infer<typeof CreateProjectResponse>;

/** `PATCH /api/projects/:id`. */
export const UpdateProjectRequest = z.object({
  name: z.string().trim().min(1).max(100).optional(),
  defaultProvider: ProviderId.nullable().optional(),
  autonomy: AutonomyLevel.nullable().optional(),
  timezone: z.string().nullable().optional(),
  defaultBranch: z.string().nullable().optional(),
  /** Pin or unpin the project in the project list (§13). */
  pinned: z.boolean().optional(),
  /** Run this project's agent sessions with `CI=true`, or not (`Project.agentCiEnv`, §4.2). */
  agentCiEnv: z.boolean().optional(),
});
export type UpdateProjectRequest = z.infer<typeof UpdateProjectRequest>;

/**
 * `PUT /api/projects/order`: the new manual order of the project list (§13). Lists every
 * non-archived project exactly once; the server rejects anything else (`invalid_order`).
 */
export const ReorderProjectsRequest = z.object({
  projectIds: z.array(Id).max(1000),
});
export type ReorderProjectsRequest = z.infer<typeof ReorderProjectsRequest>;

/** `PUT /api/projects/order` response: the non-archived projects in their new order. */
export const ReorderProjectsResponse = z.object({ projects: z.array(Project) });
export type ReorderProjectsResponse = z.infer<typeof ReorderProjectsResponse>;

// ---------------------------------------------------------------- sessions

/**
 * Where a session runs (§9): a fresh worktree (default for agents), the repo root, or an
 * existing directory (`path`).
 */
export const WorkspaceRequest = z.object({
  mode: z.enum(["worktree", "repo_root", "existing"]).default("worktree"),
  path: z.string().min(1).optional(),
  branch: z.string().min(1).optional(),
  baseRef: z.string().min(1).optional(),
  setupCommands: z.array(z.string()).optional(),
  /**
   * Fetch `origin` before creating the worktree (for a `baseRef` such as `origin/<branch>`
   * that may not be local yet). CodeDen fetches; the agent then works offline.
   */
  fetch: z.boolean().optional(),
});
export type WorkspaceRequest = z.infer<typeof WorkspaceRequest>;

/** `POST /api/sessions`: start agent work, with the §8.4 conflict check built in. */
export const StartSessionRequest = z.object({
  /** Null only for the orchestrator. */
  projectId: Id.nullable(),
  role: Role.default("agent"),
  /** Provider id; omitted or `auto` picks the role default / first ready provider. */
  provider: z.union([z.literal("auto"), ProviderId]).optional(),
  model: z.string().min(1).optional(),
  effort: ReasoningEffort.optional(),
  autonomy: AutonomyLevel.optional(),
  /**
   * Start in plan mode: the agent explores and proposes a plan, and implements only once the
   * plan is approved. Agent sessions on a provider with `capabilities.planMode` only.
   */
  planMode: z.boolean().optional(),
  workspace: WorkspaceRequest.prefault({}),
  /** One line describing the work; defaults to the first line of the input. */
  purpose: z.string().trim().min(1).max(300).optional(),
  /** Stable identifier of the work; derived from the issue or purpose when omitted. */
  workKey: WorkKey.optional(),
  /** Narrows the work for overlap detection (§8.4). */
  scope: z
    .object({ paths: z.array(z.string()).optional(), area: z.string().optional() })
    .optional(),
  startedBy: StartedBy.prefault({ kind: "user" }),
  title: z.string().trim().min(1).max(200).optional(),
  parentSessionId: Id.optional(),
  issue: GitHubIssueRef.optional(),
  /** First message; the session starts idle when omitted. */
  input: UserInput.optional(),
  /** The caller's decision when a previous attempt returned `conflict`. */
  conflict: ConflictDecision.optional(),
  /**
   * The open persisted conflict this request is a new version of (the New session draft sent
   * again while its card is up). The server closes that conflict whatever this start returns;
   * a conflict that is closed already or belongs to another project is left alone.
   */
  replacesConflict: Id.optional(),
});
export type StartSessionRequest = z.infer<typeof StartSessionRequest>;
export type StartSessionRequestInit = z.input<typeof StartSessionRequest>;

/**
 * `POST /api/sessions` response: `StartWorkResult` (`started` / `conflict`) plus the outcomes
 * of a `ConflictDecision`: `queued` (wait), `skipped` (skip) and `joined` (join).
 */
export const StartSessionResponse = z.discriminatedUnion("status", [
  ...StartWorkResult.options,
  z.object({
    status: z.literal("queued"),
    sessionId: Id,
    /** Work this session waits for. */
    behind: z.array(Id),
  }),
  z.object({ status: z.literal("skipped") }),
  z.object({ status: z.literal("joined"), sessionId: Id }),
]);
export type StartSessionResponse = z.infer<typeof StartSessionResponse>;

/**
 * `POST /api/sessions/:id/fork`: a new agent session that continues this one's conversation
 * (the provider's native fork) in a new worktree started from its latest checkpoint.
 */
export const ForkSessionRequest = z.object({
  /** Defaults to the source's title followed by "(fork)". */
  title: z.string().trim().min(1).max(200).optional(),
  /**
   * Fork from this finished turn of the source's root thread ("Fork from here"): the
   * conversation ends with it and the code is its checkpoint. Omitted: the latest moment.
   */
  turnId: Id.optional(),
});
export type ForkSessionRequest = z.infer<typeof ForkSessionRequest>;

/** `POST /api/sessions/:id/fork` response: the new session (it starts in the background). */
export const ForkSessionResponse = z.object({ sessionId: Id });
export type ForkSessionResponse = z.infer<typeof ForkSessionResponse>;

/** Longest note a handoff passes on ("What should it do next?"). */
export const HANDOFF_NOTE_MAX = 4_000;

/**
 * `POST /api/sessions/:id/handoff`: continue an agent session in a new one, on any provider
 * (§9). The new session gets the source's code as a fork does (a new branch from the source's
 * branch, its latest checkpoint restored as uncommitted changes) and, instead of a copy of the
 * conversation, a brief of the work so far as its first message, which starts a turn at once.
 * The source is only read.
 */
export const HandoffSessionRequest = z.object({
  /** The provider the work continues on; the source's own gives a fresh conversation. */
  provider: ProviderId,
  /**
   * The model; omitted or null: the source's model when the provider is the same, else the
   * provider's default.
   */
  model: z.string().trim().min(1).nullable().optional(),
  /** The reasoning effort, chosen the same way as `model`. */
  effort: ReasoningEffort.nullable().optional(),
  /** Defaults to the source's title followed by "(to <provider>)". */
  title: z.string().trim().min(1).max(200).optional(),
  /** What the new session should do next, added to the brief; "continue" when omitted. */
  note: z.string().trim().min(1).max(HANDOFF_NOTE_MAX).optional(),
});
export type HandoffSessionRequest = z.infer<typeof HandoffSessionRequest>;

/** `POST /api/sessions/:id/handoff` response: the new session (it starts in the background). */
export const HandoffSessionResponse = z.object({ sessionId: Id });
export type HandoffSessionResponse = z.infer<typeof HandoffSessionResponse>;

/** Recorded with a session about how it was started (forced starts keep their reason). */
export const SessionStartMeta = z.object({
  workspaceMode: WorkspaceRequest.shape.mode,
  /** Set when the runner could not prepare the requested workspace and CodeDen fell back. */
  workspaceFallback: z.string().nullable(),
  forced: z.object({ reason: z.string(), conflictsWith: z.array(Id) }).nullable(),
  queuedBehind: z.array(Id),
  /** Worktree setup commands (`.codeden/project.json`) and their output, in order. */
  setup: z.array(SetupStep).optional(),
});
export type SessionStartMeta = z.infer<typeof SessionStartMeta>;

/** `GET /api/sessions` query. */
export const ListSessionsQuery = z.object({
  projectId: Id.optional(),
  status: z
    .string()
    .transform((s) => s.split(","))
    .pipe(z.array(SessionStatus))
    .optional(),
  workKey: z.string().optional(),
  role: Role.optional(),
});
export type ListSessionsQuery = z.infer<typeof ListSessionsQuery>;

/** `GET /api/sessions/:id`. */
export const SessionDetail = z.object({
  session: Session,
  /** Accumulated usage across turns (token counts and cost summed; context/rate limits latest). */
  usage: Usage.nullable(),
  /** Follow-up suggestions of the latest completed root turn (§7.5). */
  followups: FollowupsItem.nullable(),
  startMeta: SessionStartMeta.nullable(),
  /** Messages waiting to be sent when the current turn ends. */
  queuedMessages: z.int().nonnegative(),
});
export type SessionDetail = z.infer<typeof SessionDetail>;

/** `POST /api/sessions/:id/messages`. */
export const SendMessageRequest = z.object({
  input: UserInput,
  /** What to do while a turn is running: queue (default), steer into it, or reject. */
  whenBusy: z.enum(["queue", "steer", "reject"]).default("queue"),
});
export type SendMessageRequest = z.infer<typeof SendMessageRequest>;
export type SendMessageRequestInit = z.input<typeof SendMessageRequest>;

export const SendMessageResponse = z.object({
  status: z.enum(["sent", "queued", "steered"]),
});
export type SendMessageResponse = z.infer<typeof SendMessageResponse>;

/** `POST /api/sessions/:id/steer`. */
export const SteerRequest = z.object({ input: UserInput });
export type SteerRequest = z.infer<typeof SteerRequest>;

/** `POST /api/sessions/:id/respond`: answer an approval request or question. */
export const RespondRequest = z.object({ requestId: Id, response: RuntimeResponse });
export type RespondRequest = z.infer<typeof RespondRequest>;

/** `GET /api/sessions/:id/threads/:threadId/items` query (positions are per thread). */
export const ThreadItemsQuery = z.object({
  /** Items with `position < before` (older page). */
  before: z.coerce.number().int().nonnegative().optional(),
  /** Items with `position > after` (newer page). */
  after: z.coerce.number().int().min(-1).optional(),
  limit: z.coerce.number().int().min(1).max(500).default(100),
});
export type ThreadItemsQuery = z.infer<typeof ThreadItemsQuery>;

/** A page of transcript items. Large tool outputs are previews (`output.truncated`). */
export const ThreadItemsPage = z.object({
  threadId: Id,
  items: z.array(ItemRecord),
  hasMoreBefore: z.boolean(),
  hasMoreAfter: z.boolean(),
});
export type ThreadItemsPage = z.infer<typeof ThreadItemsPage>;

/**
 * `GET /api/sessions/:id/items/:itemId/output`: the output the server stored for a tool call, as
 * of the request. Long output may itself be stored cut (the latest part of a stream, or what the
 * provider kept), which `truncated` says.
 */
export const ToolOutputResponse = z.object({
  itemId: Id,
  text: z.string(),
  /** UTF-8 size of `text`. */
  totalBytes: z.int().nonnegative(),
  /** The stored copy is cut: part of the output was never kept, so `text` isn't all of it. */
  truncated: z.boolean(),
  /** UTF-8 size of the tool's whole output when the request was answered (≥ `totalBytes`). */
  outputBytes: z.int().nonnegative(),
});
export type ToolOutputResponse = z.infer<typeof ToolOutputResponse>;

// ---------------------------------------------------------------- inbox

/** `GET /api/inbox` query. Defaults to open items. */
export const ListInboxQuery = z.object({
  status: InboxItemStatus.optional(),
  projectId: Id.optional(),
  sessionId: Id.optional(),
});
export type ListInboxQuery = z.infer<typeof ListInboxQuery>;

/**
 * `POST /api/inbox/:id/resolve`. Approvals and questions pass the `response`, which is sent
 * to the agent; other items are just marked resolved or dismissed.
 */
export const ResolveInboxRequest = z.object({
  response: RuntimeResponse.optional(),
  status: z.enum(["resolved", "dismissed"]).default("resolved"),
  note: z.string().max(2000).optional(),
});
export type ResolveInboxRequest = z.infer<typeof ResolveInboxRequest>;

/**
 * `POST /api/inbox/:id/retry`: run a `run_failed` item's session again on its provider. Refused
 * (409 `provider_unavailable`, with what fixes it) while that provider can't run: not
 * installed, too old, signed out, at its usage limit. A retry that fails again updates the same
 * item (attempts, latest error) and answers with the error; one that starts resolves it.
 */
export const RetryInboxResponse = z.object({ item: InboxItem });
export type RetryInboxResponse = z.infer<typeof RetryInboxResponse>;

/**
 * `POST /api/inbox/dismiss`: dismiss several items at once (the inbox's "Dismiss all" for
 * failed runs). Approvals and questions are skipped: they need an answer. Ids that aren't open
 * are ignored.
 */
export const DismissInboxRequest = z.object({
  ids: z.array(Id).min(1).max(1000),
  note: z.string().max(2000).optional(),
});
export type DismissInboxRequest = z.infer<typeof DismissInboxRequest>;

export const DismissInboxResponse = z.object({ dismissed: z.int().nonnegative() });
export type DismissInboxResponse = z.infer<typeof DismissInboxResponse>;

/** `GET /api/inbox/counts`: the sidebar badge numbers. */
export const InboxCounts = z.object({
  open: z.int().nonnegative(),
  byProject: z.record(z.string(), z.int().nonnegative()),
  byKind: z.partialRecord(InboxItemKind, z.int().nonnegative()),
});
export type InboxCounts = z.infer<typeof InboxCounts>;

// ---------------------------------------------------------------- first-run setup

/**
 * A first-run check (§14): the agent CLIs (`claude`, `codex`, `opencode`, `cursor`: the Cursor
 * CLI, `agent`; `gemini`: Gemini CLI), then `gh`, `git`, the browser and Node.js.
 */
export const SetupToolId = z.enum([
  "claude",
  "codex",
  "opencode",
  "cursor",
  "gemini",
  "gh",
  "git",
  "browser",
  "node",
]);
export type SetupToolId = z.infer<typeof SetupToolId>;

/**
 * Setup checks whose sign-in command the UI can run in its embedded terminal (`cursor` runs
 * `agent login`; `gemini` runs `gemini`, which asks how to sign in when it has no login).
 */
export const LoginToolId = z.enum(["claude", "codex", "opencode", "cursor", "gemini", "gh"]);
export type LoginToolId = z.infer<typeof LoginToolId>;

/** A command the UI runs in its embedded terminal to fix a check (§14 step 3). */
export const SetupCommand = z.object({
  kind: z.enum(["install", "login", "upgrade", "configure"]),
  /** Shown to the user and typed into the terminal. */
  command: z.string(),
  /** Docs link for manual installs. */
  url: z.string().optional(),
});
export type SetupCommand = z.infer<typeof SetupCommand>;

/** Result of one detection check. Never contains tokens. */
export const SetupCheck = z.object({
  id: SetupToolId,
  label: z.string(),
  /** `ok`: ready; `warning`: usable but needs attention; `missing`: not usable. */
  state: z.enum(["ok", "warning", "missing", "error"]),
  installed: z.boolean(),
  version: z.string().nullable(),
  executablePath: z.string().nullable(),
  /** Null when not applicable or unknown. */
  loggedIn: z.boolean().nullable(),
  authMethod: z.string().nullable(),
  account: z.string().nullable(),
  loginExpiresAt: Timestamp.nullable(),
  /** Human-readable summary of the state. */
  message: z.string(),
  /**
   * The underlying error behind the message (exit code, stderr, timeout), shown in a details
   * area. Never contains tokens.
   */
  detail: z.string().optional(),
  /**
   * Copies of the tool that were found but do not run. With `installed: false` the tool is
   * "installed but broken"; with a working copy they are informational.
   */
  broken: z.array(BrokenExecutable).optional(),
  fix: SetupCommand.nullable(),
  durationMs: z.int().nonnegative(),
});
export type SetupCheck = z.infer<typeof SetupCheck>;

/** `GET /api/setup/status`. */
export const SetupStatus = z.object({
  checkedAt: Timestamp,
  /** Persisted in settings once the user finishes the checklist. */
  setupCompleted: z.boolean(),
  /** At least one agent provider is installed and logged in. */
  ready: z.boolean(),
  checks: z.array(SetupCheck),
  /** Changes worth a warning (expiring login, logged-out CLI). */
  warnings: z.array(z.object({ id: SetupToolId, message: z.string() })),
});
export type SetupStatus = z.infer<typeof SetupStatus>;

/**
 * Claude Code support (§14): the Claude Agent SDK that drives the user's installed `claude`.
 * The published package does not ship it; it is installed from npm on first use into
 * `<home>/deps` (without its optional platform binaries). `GET /api/setup/claude-sdk`;
 * `POST /api/setup/claude-sdk/install` starts (or joins) the install.
 */
export const ClaudeSdkStatus = z.object({
  /** `ready`: loadable; `missing`: not installed yet; `failed`: the last install failed. */
  state: z.enum(["ready", "missing", "installing", "failed"]),
  /** The SDK version CodeDen is tested with; the only version it installs. */
  version: z.string(),
  /** `deps`: installed on demand into `location`; `workspace`: resolved from a dev checkout. */
  source: z.enum(["deps", "workspace"]),
  /** The deps folder (null for `workspace`). */
  location: z.string().nullable(),
  /** Latest progress line while installing. */
  progress: z.string().nullable(),
  /** Why the last install failed. */
  error: z.string().nullable(),
});
export type ClaudeSdkStatus = z.infer<typeof ClaudeSdkStatus>;

/**
 * `POST /api/providers/:id/refresh-models` response: the runner re-detected the provider and
 * asked it for its models again; `providers` is every provider's list after that refresh.
 */
export const RefreshModelsResponse = z.object({
  providers: z.array(ProviderInfo),
});
export type RefreshModelsResponse = z.infer<typeof RefreshModelsResponse>;

/** `POST /api/setup/login/:tool` response: what to run in a terminal. */
export const LoginCommandResponse = z.object({
  tool: LoginToolId,
  command: z.string(),
  args: z.array(z.string()),
});
export type LoginCommandResponse = z.infer<typeof LoginCommandResponse>;

// ---------------------------------------------------------------- folder picker and files

/** `GET /api/fs/list?path=`: directories only, read-only (§13 server-side folder picker). */
export const FsListResponse = z.object({
  /** The listed directory (absolute), or null for the roots view. */
  path: z.string().nullable(),
  parent: z.string().nullable(),
  home: z.string(),
  /** Drives on Windows, `/` elsewhere. */
  roots: z.array(z.object({ name: z.string(), path: z.string() })),
  entries: z.array(
    z.object({
      name: z.string(),
      path: z.string(),
      hidden: z.boolean(),
      /** True when the folder looks like a git checkout. */
      isGitRepo: z.boolean(),
    }),
  ),
  truncated: z.boolean(),
});
export type FsListResponse = z.infer<typeof FsListResponse>;

/** Roots the config-file API may touch (§12.4): a project checkout or a provider's home. */
export const FileRoot = z.enum(["project", "claude", "codex"]);
export type FileRoot = z.infer<typeof FileRoot>;

/** `GET /api/files` query. `path` is relative to the root. */
export const FileReadQuery = z.object({
  root: FileRoot,
  projectId: Id.optional(),
  path: z.string().min(1),
});
export type FileReadQuery = z.infer<typeof FileReadQuery>;

export const FileContent = z.object({
  root: FileRoot,
  path: z.string(),
  absolutePath: z.string(),
  exists: z.boolean(),
  content: z.string(),
  /** Null when the file does not exist. */
  sha256: z.string().nullable(),
  sizeBytes: z.int().nonnegative(),
});
export type FileContent = z.infer<typeof FileContent>;

/** `PUT /api/files`. A backup is written before overwriting. */
export const FileWriteRequest = z.object({
  root: FileRoot,
  projectId: Id.optional(),
  path: z.string().min(1),
  content: z.string().max(2_000_000),
  /**
   * Optimistic concurrency: the sha256 the editor loaded (null = the file must not exist).
   * Omit to overwrite unconditionally.
   */
  expectedSha256: z.string().nullable().optional(),
});
export type FileWriteRequest = z.infer<typeof FileWriteRequest>;

// ---------------------------------------------------------------- secrets

/** Secrets CodeDen may keep in the OS keychain (§6). Values are never returned. */
export const SecretKey = z.enum([
  "elevenlabs.apiKey",
  "openai.apiKey",
  "gemini.apiKey",
  "anthropic.apiKey",
  /** Fallback GitHub token when `gh auth token` is unavailable (§9). */
  "github.token",
]);
export type SecretKey = z.infer<typeof SecretKey>;

export const SecretsStatus = z.object({
  backend: z.enum(["keyring", "memory"]),
  keys: z.array(z.object({ key: SecretKey, set: z.boolean() })),
});
export type SecretsStatus = z.infer<typeof SecretsStatus>;

export const SetSecretRequest = z.object({ value: z.string().min(1).max(10_000) });
export type SetSecretRequest = z.infer<typeof SetSecretRequest>;

// ---------------------------------------------------------------- UI WebSocket extensions

/**
 * `subscribe` with an extra switch: `agentEvents: false` delivers only domain events
 * (projects, sessions, inbox, settings, runner), leaving transcripts to `watch_session`.
 * Live events are batched (~40ms) and consecutive text deltas of one item are merged, so seqs
 * in a batch may skip; track the highest seq seen.
 */
export const UiSubscribe = ClientSubscribe.extend({
  agentEvents: z.boolean().default(true),
});

/**
 * Watch one session's transcript. The server sends the latest state of every thread, turn and
 * item changed after `fromSeq` (load pages over HTTP first, then watch from their `seq`),
 * then live `transcript` updates. `threadIds` limits items/turns to those threads (child
 * threads they spawn are still announced).
 */
export const WatchSession = z.object({
  type: z.literal("watch_session"),
  sessionId: Id,
  fromSeq: z.int().nonnegative(),
  threadIds: z.array(Id).optional(),
});

export const UnwatchSession = z.object({ type: z.literal("unwatch_session"), sessionId: Id });

/** Everything the UI may send over `/ws`. */
export const UiClientMessage = z.discriminatedUnion("type", [
  UiSubscribe,
  ...ClientToServerMessage.options.filter(
    (o): o is Exclude<(typeof ClientToServerMessage.options)[number], typeof ClientSubscribe> =>
      o !== ClientSubscribe,
  ),
  WatchSession,
  UnwatchSession,
]);
export type UiClientMessage = z.infer<typeof UiClientMessage>;

/** Latest state of transcript rows that changed (replace by id). Outputs are previews. */
export const TranscriptMessage = z.object({
  type: z.literal("transcript"),
  sessionId: Id,
  /** Highest event seq reflected in this message. */
  seq: z.int().nonnegative(),
  threads: z.array(Thread),
  turns: z.array(Turn),
  items: z.array(ItemRecord),
  /** Present when the session's accumulated usage changed. */
  usage: Usage.optional(),
});
export type TranscriptMessage = z.infer<typeof TranscriptMessage>;

/** The server cannot replay this session's changes; reload its transcript over HTTP. */
export const TranscriptResyncMessage = z.object({
  type: z.literal("transcript_resync"),
  sessionId: Id,
  seq: z.int().nonnegative(),
});

/** Everything the server may send over `/ws`. */
export const UiServerMessage = z.discriminatedUnion("type", [
  ...ServerToClientMessage.options,
  TranscriptMessage,
  TranscriptResyncMessage,
]);
export type UiServerMessage = z.infer<typeof UiServerMessage>;

// Workbench routes (diffs, checkpoints, git, terminal, utility) live in `workbench.ts`.
export * from "./workbench";

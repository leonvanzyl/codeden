import type {
  ArchiveSessionResponse,
  ClaudeSdkStatus,
  ConflictRecord,
  CreateProjectRequest,
  CreateProjectResponse,
  DiffResult,
  DiffScope,
  DisconnectGithubResponse,
  ForkSessionRequest,
  ForkSessionResponse,
  FsListResponse,
  GitCommitRequest,
  GitCommitResponse,
  GitPushRequest,
  GitPushResponse,
  GitStatusResponse,
  InboxItem,
  LoginCommandResponse,
  LoginToolId,
  Project,
  RefreshModelsResponse,
  RefreshProjectResponse,
  ResolveConflictRequestInit,
  ResolveConflictResponse,
  RestoreFilesRequest,
  RestoreFilesResponse,
  Role,
  RuntimeResponse,
  Session,
  SessionDetail,
  SessionFileContent,
  SessionFileList,
  SessionSnapshot,
  Settings,
  SettingsPatch,
  SetupStatus,
  SlashCommand,
  Snapshot,
  SpeechSummaryResponse,
  StartSessionRequestInit,
  StartSessionResponse,
  ToolOutputResponse,
  TranscriptMessage,
  TranscriptSearchResponse,
  UiServerMessage,
  UpdateProjectRequest,
  UpdateSessionRequest,
  UpdateStatus,
  UserInputInit,
} from "@codeden/contracts";
import type { AutomationsApi } from "./automations-api";
import type { FactoryApi } from "./factory-api";
import type {
  AgentConfigApi,
  BrowserApi,
  GithubApi,
  ImagesApi,
  OrchestrationApi,
  SecretsApi,
  VoiceApi,
} from "./feature-apis";
import type { AuthApi, NetworkApi } from "./network-api";
import type { QueueApi } from "./queue-api";
import type { MentionCandidate, OpenTerminalOptions, TerminalChannel } from "./types";
import type { UpdatesApi } from "./updates-api";

/** How a message is delivered while a turn is running. */
export type SendMode = "send" | "queue" | "steer";

/** Messages for one watched session transcript. */
export type TranscriptWatchMessage =
  | TranscriptMessage
  | { type: "transcript_resync"; sessionId: string; seq: number };

/** A transcript search (`GET /api/search/transcripts`): one page, newest matches first. */
export interface TranscriptSearchRequest {
  q: string;
  projectId?: string;
  /** Only sessions with this role. */
  role?: Role;
  /** False leaves out archived sessions (they are included by default). */
  includeArchived?: boolean;
  /** The previous page's `nextCursor`. */
  cursor?: string;
  /** Most hits (1–100, default 20). */
  limit?: number;
}

/** Resolve an inbox item; approvals and questions carry the agent `response`. */
export interface InboxResolution {
  status?: "resolved" | "dismissed";
  response?: RuntimeResponse;
  note?: string;
}

/**
 * Everything the UI asks of the server. Two implementations: `createHttpClient` (fetch +
 * WebSocket against the real server) and `createMockClient` (rich fixtures, scripted live
 * events). Screens only ever talk to this interface.
 */
export interface CodeDenClient {
  readonly kind: "http" | "mock";

  // Realtime (§6): snapshot, then subscribe from its seq.
  getSnapshot(): Promise<Snapshot>;
  getSessionSnapshot(sessionId: string): Promise<SessionSnapshot>;
  /**
   * Subscribe to the live event stream (domain events; the mock also sends agent events).
   * Calling it again replaces the subscription. Returns an unsubscribe function.
   */
  subscribe(fromSeq: number, onMessage: (msg: UiServerMessage) => void): () => void;
  /** Watch one session's transcript from `fromSeq` (its snapshot seq). Returns unwatch. */
  watchSession(
    sessionId: string,
    fromSeq: number,
    onMessage: (msg: TranscriptWatchMessage) => void,
  ): () => void;

  /** Live connection state of the realtime socket. Returns an unsubscribe function. */
  onConnectionChange(listener: (state: "connecting" | "open" | "closed") => void): () => void;

  // Sessions and turns.
  getSessionDetail(sessionId: string): Promise<SessionDetail>;
  /**
   * The output the server stored for a tool call, for when the transcript's copy was cut
   * (`output.truncated`): large outputs are fetched on demand, not pushed (§6).
   */
  getToolOutput(sessionId: string, itemId: string): Promise<ToolOutputResponse>;
  sendMessage(sessionId: string, input: UserInputInit, mode: SendMode): Promise<void>;
  interrupt(sessionId: string): Promise<void>;
  respond(sessionId: string, requestId: string, response: RuntimeResponse): Promise<void>;
  startSession(input: StartSessionRequestInit): Promise<StartSessionResponse>;
  stopSession(sessionId: string): Promise<void>;
  /**
   * A new session that continues this one's conversation (the provider's fork) in a new
   * worktree started from its latest checkpoint (§9). The source is left as it is.
   */
  forkSession(sessionId: string, req?: ForkSessionRequest): Promise<ForkSessionResponse>;
  /** Hide a session and remove its worktree (§9); `force` drops uncommitted changes. */
  archiveSession(sessionId: string, opts?: { force?: boolean }): Promise<ArchiveSessionResponse>;
  unarchiveSession(sessionId: string): Promise<Session>;
  /** Change model, effort or title; model and effort apply from the next turn. */
  updateSession(sessionId: string, patch: UpdateSessionRequest): Promise<Session>;
  /** Messages waiting behind a running turn: list, edit, delete, send now. */
  readonly queue: QueueApi;
  /** Full-text search over every transcript, archived sessions included (§13). */
  searchTranscripts(req: TranscriptSearchRequest): Promise<TranscriptSearchResponse>;

  // Conflicts (§8.4): persisted start requests that matched running work.
  listConflicts(query?: { projectId?: string }): Promise<ConflictRecord[]>;
  /** The decision, plus `start` to start that request instead of the saved one. */
  resolveConflict(
    conflictId: string,
    request: ResolveConflictRequestInit,
  ): Promise<ResolveConflictResponse>;

  // Inbox (§11.1).
  resolveInbox(itemId: string, resolution: InboxResolution): Promise<InboxItem>;

  // Projects, automations (§10), factory.
  createProject(input: CreateProjectRequest): Promise<CreateProjectResponse>;
  /** Rename, change defaults, or pin and unpin a project (§13). */
  updateProject(projectId: string, patch: UpdateProjectRequest): Promise<Project>;
  /**
   * Save the manual project order (§13): every non-archived project id, exactly once.
   * Resolves with the projects in their new order.
   */
  reorderProjects(projectIds: string[]): Promise<Project[]>;
  /**
   * Detect the project folder's git checkout and GitHub remote again (§9): a folder that gained
   * a GitHub `origin` becomes a GitHub project. The project change also arrives as an event.
   */
  refreshProject(projectId: string): Promise<RefreshProjectResponse>;
  /** Make a GitHub project local-only, once its folder no longer has a GitHub `origin`. */
  disconnectGithub(projectId: string): Promise<DisconnectGithubResponse>;
  readonly automations: AutomationsApi;
  /** Autonomy modes, the vision, the factory panel and kill switches (§10.1, experimental). */
  readonly factory: FactoryApi;

  // Settings.
  updateSettings(patch: SettingsPatch): Promise<Settings>;
  /** OS keychain secrets (API keys). Values are never echoed back. */
  readonly secrets: SecretsApi;
  /** Network access (§15.1): on/off, the password, signed-in devices. */
  readonly network: NetworkApi;
  /** Sign-in for remote devices (§15.1). */
  readonly auth: AuthApi;

  // First-run setup (§14).
  /** Detection results; `refresh` re-runs every check instead of using the cache. */
  getSetupStatus(opts?: { refresh?: boolean }): Promise<SetupStatus>;
  /** The npm registry version check and self-update state (`settings.updates.mode`). */
  getUpdates(opts?: { refresh?: boolean }): Promise<UpdateStatus>;
  /** One-click self-update: install, restart, roll back, release notes (§16). */
  readonly updates: UpdatesApi;
  loginCommand(tool: LoginToolId): Promise<LoginCommandResponse>;
  /** Ask a provider for its models again (a model was released, the CLI was updated). */
  refreshModels(providerId: string): Promise<RefreshModelsResponse>;
  /** Claude Code support: the Claude Agent SDK, installed on demand into `<home>/deps`. */
  getClaudeSdkStatus(): Promise<ClaudeSdkStatus>;
  /** Start (or join) the Claude Code support install; poll `getClaudeSdkStatus` for progress. */
  installClaudeSdk(): Promise<ClaudeSdkStatus>;
  completeSetup(): Promise<void>;
  listDirectory(path: string | null, opts?: { showHidden?: boolean }): Promise<FsListResponse>;

  // Workbench (§12).
  getDiff(sessionId: string, scope: DiffScope): Promise<DiffResult>;
  restoreFiles(sessionId: string, req: RestoreFilesRequest): Promise<RestoreFilesResponse>;
  gitStatus(sessionId: string): Promise<GitStatusResponse>;
  gitCommit(sessionId: string, req: GitCommitRequest): Promise<GitCommitResponse>;
  gitPush(sessionId: string, req: GitPushRequest): Promise<GitPushResponse>;
  listFiles(sessionId: string): Promise<SessionFileList>;
  readFile(sessionId: string, path: string): Promise<SessionFileContent>;
  searchMentions(sessionId: string, query: string): Promise<MentionCandidate[]>;
  /** The session's `/` commands and skills for the composer, sorted by name. */
  listSlashCommands(sessionId: string): Promise<SlashCommand[]>;
  /** `@` mention candidates from the project folder, for the New session draft. */
  searchProjectMentions(projectId: string, query: string): Promise<MentionCandidate[]>;
  /** The `/` commands and skills `provider` would load in the project (the New session draft). */
  listProjectSlashCommands(projectId: string, provider: string): Promise<SlashCommand[]>;
  openTerminal(opts: OpenTerminalOptions): TerminalChannel;
  /** The session browser: live viewer socket, tabs, navigation, dev servers (§12.2). */
  readonly browser: BrowserApi;
  /** URL for an artifact's bytes (screenshots, generated images, attachments). */
  artifactUrl(artifactId: string): string;
  /** Compress a final message for read-aloud with the utility model (§11.3). */
  speechSummary(text: string): Promise<SpeechSummaryResponse>;

  // Agent configuration (§12.4), image generation (§12.5), cloud voice (§11.3).
  readonly agentConfig: AgentConfigApi;
  readonly images: ImagesApi;
  readonly voice: VoiceApi;

  // Orchestration (§8) and GitHub (§9).
  readonly orchestration: OrchestrationApi;
  readonly github: GithubApi;
}

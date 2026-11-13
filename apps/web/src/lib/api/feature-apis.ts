import type {
  AgentConfigDeleteResponse,
  AgentConfigDiff,
  AgentConfigDiffRequest,
  AgentConfigFileContent,
  AgentConfigListQuery,
  AgentConfigListResponse,
  AgentConfigLocator,
  AgentConfigWriteRequest,
  AgentConfigWriteResponse,
  AgentSkillListResponse,
  BrowserHistoryRequest,
  BrowserInput,
  BrowserNavigateResponse,
  BrowserOpenResponse,
  BrowserScreencastSettings,
  BrowserServerMessage,
  BrowserTabResponse,
  BrowserTabsResponse,
  BrowserViewportSize,
  DevServersResponse,
  GithubConnection,
  GithubIssueDetails,
  GithubIssuesResponse,
  GithubListQuery,
  GithubPrDetails,
  GithubPrsResponse,
  GithubSyncStatus,
  HookChangeRequest,
  HookListResponse,
  HookWriteResponse,
  ImageEnginesResponse,
  ImageTestRequest,
  ImageTestResponse,
  LoadedAgentConfig,
  LocalSttStatus,
  McpServerDiffRequest,
  McpServerListResponse,
  McpServerTarget,
  McpServerTestRequest,
  McpServerTestResult,
  McpServerUpsertRequest,
  McpServerWriteResponse,
  MergePrRequest,
  MergePrResponse,
  Notice,
  Overview,
  ProjectStatus,
  RoleMessageResponse,
  SecretKey,
  SecretsStatus,
  Session,
  SessionGithubResponse,
  SkillSwitchDiff,
  SkillSwitchRequest,
  SkillSwitchResponse,
  SttQuery,
  SttResponse,
  TriageIssueRequest,
  TriageIssueResult,
  TtsRequest,
  UserInputInit,
  VoiceListResponse,
  WhisperModelId,
} from "@codeden/contracts";

/**
 * Feature APIs of the client that map one-to-one onto server routes: the session browser
 * (§12.2), agent configuration (§12.4), image generation (§12.5), cloud voice (§11.3) and
 * keychain secrets. Shapes are the contracts' own.
 */

// ------------------------------------------------------------------ session browser (§12.2)

export type BrowserConnection = "connecting" | "open" | "closed";

/** Options for the `/ws/browser` viewer socket. */
export interface BrowserChannelOptions extends BrowserScreencastSettings {
  /** Open the session's browser if it is not open yet. */
  open?: boolean;
  /**
   * This viewer is the desktop window, which shows native views itself (§17 Phase 2): opens
   * prefer native views and no frames come until `watch` (for a browser on the runner's
   * Chromium).
   */
  native?: boolean;
}

/** One live viewer of a session's browser (`/ws/browser`). */
export interface BrowserChannel {
  onMessage(listener: (msg: BrowserServerMessage) => void): () => void;
  onConnection(listener: (state: BrowserConnection) => void): () => void;
  /** Human input for the active tab (coordinates in displayed-frame space). */
  input(input: BrowserInput): void;
  watch(settings?: BrowserScreencastSettings): void;
  unwatch(): void;
  /** Open the session's browser now (optionally at `url`). */
  open(url?: string): void;
  /**
   * Report the size this viewer wants the page at; `claim` takes the viewport over from other
   * viewers. The latest size is re-sent after a reconnect.
   */
  viewport(size: BrowserViewportSize, claim?: boolean): void;
  close(): void;
}

export interface BrowserApi {
  openChannel(sessionId: string, opts?: BrowserChannelOptions): BrowserChannel;
  /** `native`: the desktop window asks (prefer native views for a browser not open yet). */
  open(sessionId: string, url?: string, native?: boolean): Promise<BrowserOpenResponse>;
  close(sessionId: string): Promise<void>;
  tabs(sessionId: string): Promise<BrowserTabsResponse>;
  newTab(sessionId: string, url?: string): Promise<BrowserTabResponse>;
  closeTab(sessionId: string, tabId: string): Promise<void>;
  activateTab(sessionId: string, tabId: string): Promise<void>;
  navigate(sessionId: string, url: string, tabId?: string): Promise<BrowserNavigateResponse>;
  history(
    sessionId: string,
    action: BrowserHistoryRequest["action"],
    tabId?: string,
  ): Promise<{ url: string }>;
  viewport(sessionId: string, width: number, height: number): Promise<void>;
  openDevServer(sessionId: string, port: number, path?: string): Promise<BrowserTabResponse>;
  devServers(probe?: number[]): Promise<DevServersResponse>;
}

// ------------------------------------------------------------------ agent configuration (§12.4)

export interface AgentConfigApi {
  list(query: AgentConfigListQuery): Promise<AgentConfigListResponse>;
  read(locator: AgentConfigLocator): Promise<AgentConfigFileContent>;
  /** Create or overwrite; `create` refuses an existing file (409 `file_exists`). */
  write(
    req: AgentConfigWriteRequest,
    opts?: { create?: boolean },
  ): Promise<AgentConfigWriteResponse>;
  remove(
    locator: AgentConfigLocator,
    opts?: { folder?: boolean },
  ): Promise<AgentConfigDeleteResponse>;
  diff(req: AgentConfigDiffRequest): Promise<AgentConfigDiff>;
  listMcp(projectId: string | null): Promise<McpServerListResponse>;
  upsertMcp(req: McpServerUpsertRequest): Promise<McpServerWriteResponse>;
  removeMcp(target: McpServerTarget): Promise<McpServerWriteResponse>;
  /** Preview an upsert (with `spec`) or a removal (without). */
  diffMcp(req: McpServerDiffRequest): Promise<AgentConfigDiff>;
  /** Connect to a server (the saved one, or `spec` unsaved) and list its tools. */
  testMcp(req: McpServerTestRequest): Promise<McpServerTestResult>;
  /** Hooks in the settings files of providers that have them (user, plus the project's). */
  listHooks(projectId: string | null): Promise<HookListResponse>;
  /** Preview a hook change as a diff of its settings file. */
  diffHook(req: HookChangeRequest): Promise<AgentConfigDiff>;
  changeHook(req: HookChangeRequest): Promise<HookWriteResponse>;
  /** User skills, plus the project's, each with whether its provider's setting switches it off. */
  listSkills(projectId: string | null): Promise<AgentSkillListResponse>;
  /** Preview switching a skill on or off as a diff of the native file it writes. */
  diffSkillSwitch(req: SkillSwitchRequest): Promise<SkillSwitchDiff>;
  switchSkill(req: SkillSwitchRequest): Promise<SkillSwitchResponse>;
  /** What a session's provider loads from its working directory. */
  loaded(sessionId: string): Promise<LoadedAgentConfig>;
}

// ------------------------------------------------------------------ images, voice, secrets

export interface ImagesApi {
  engines(projectId?: string | null): Promise<ImageEnginesResponse>;
  test(req: ImageTestRequest): Promise<ImageTestResponse>;
}

export interface VoiceApi {
  /** ElevenLabs voices (409 `missing_api_key` without a key). */
  voices(): Promise<VoiceListResponse>;
  /** Spoken audio (`audio/mpeg`) from the server's ElevenLabs proxy. */
  tts(req: TtsRequest): Promise<Blob>;
  /** Transcribe recorded audio with a cloud engine or local Whisper (WAV for local). */
  stt(audio: Blob, query: SttQuery): Promise<SttResponse>;
  /** Local Whisper: runtime and model download status on the server. */
  localStatus(): Promise<LocalSttStatus>;
  /** Start (or join) downloading the runtime and a model. */
  downloadLocalModel(id: WhisperModelId): Promise<LocalSttStatus>;
  /** Cancel a model download or delete the downloaded model. */
  deleteLocalModel(id: WhisperModelId): Promise<LocalSttStatus>;
}

export interface SecretsApi {
  status(): Promise<SecretsStatus>;
  set(key: SecretKey, value: string): Promise<void>;
  remove(key: SecretKey): Promise<void>;
}

// ------------------------------------------------------------------ orchestration (§8)

export type OrchestrationRole = "orchestrator" | "pm";

/** `/api/orchestration/*`: the orchestrator and PM chats, digests and notices. */
export interface OrchestrationApi {
  /** Create the role session if it does not exist yet (the PM needs `projectId`). */
  ensure(role: OrchestrationRole, projectId: string | null): Promise<Session | null>;
  /** Send to the orchestrator or a project's PM; creates the session on first use. */
  send(
    role: OrchestrationRole,
    projectId: string | null,
    input: UserInputInit,
    whenBusy?: "queue" | "steer" | "reject",
  ): Promise<RoleMessageResponse>;
  projectStatus(projectId: string): Promise<ProjectStatus>;
  overview(): Promise<Overview>;
  notices(query?: {
    projectId?: string;
    target?: OrchestrationRole;
    limit?: number;
  }): Promise<Notice[]>;
}

// ------------------------------------------------------------------ GitHub (§9)

export type GithubState = GithubListQuery["state"];

/** `/api/github/connection`, `/api/projects/:id/github/*`, `/api/prs/:id`, session GitHub. */
export interface GithubApi {
  connection(): Promise<GithubConnection>;
  issues(projectId: string, state?: GithubState): Promise<GithubIssuesResponse>;
  prs(projectId: string, state?: GithubState): Promise<GithubPrsResponse>;
  /** One issue, fresh from GitHub, with its latest comments. */
  issue(projectId: string, number: number): Promise<GithubIssueDetails>;
  sync(projectId: string): Promise<GithubSyncStatus>;
  /** `prId` is `<projectId>:<number>` (`githubPrId`). */
  pr(prId: string): Promise<GithubPrDetails>;
  merge(prId: string, req?: Partial<MergePrRequest>): Promise<MergePrResponse>;
  session(sessionId: string): Promise<SessionGithubResponse>;
  triage(
    projectId: string,
    number: number,
    req: Pick<TriageIssueRequest, "decision"> & Partial<TriageIssueRequest>,
  ): Promise<TriageIssueResult>;
}

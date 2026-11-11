import { homedir } from "node:os";
import { join } from "node:path";
import { messageFrom } from "@codeden/contracts";
import { createImageEngineRegistry, type ImageEngineRegistry } from "@codeden/providers";
import type { Db } from "../db/client";
import type { EventStore } from "../events/store";
import { ToolRegistry } from "../mcp/registry";
import { McpTokenStore } from "../mcp/tokens";
import { allTools } from "../mcp/tools";
import type { HomePaths } from "../paths";
import type { SettingsStore } from "../settings-store";
import { AgentConfigService } from "./agent-config/agent-config-service";
import { ArtifactService } from "./artifacts";
import { AutomationService, type AutomationServiceDeps } from "./automations/automation-service";
import { BrowserService } from "./browser/browser-service";
import { type Exec, runTool } from "./exec";
import { type FactoryOptions, FactoryService } from "./factory/factory-service";
import { type FactoryGithub, GithubFactoryPort } from "./factory/github-port";
import { ConfigFiles } from "./files/config-files";
import { GithubService, type GithubServiceDeps } from "./github/github-service";
import { ImageService } from "./images/image-service";
import { InboxService } from "./inbox-service";
import { GithubServicePort } from "./orchestration/github-port";
import {
  type OrchestrationOptions,
  OrchestrationService,
} from "./orchestration/orchestration-service";
import type { AutomationPort, GithubPort } from "./orchestration/ports";
import { ProjectService } from "./projects/project-service";
import { ProjectRedetector } from "./projects/redetector";
import { type RunnerPort, redetectProviders } from "./runner-port";
import type { SecretStore } from "./secrets";
import { AutoRetry, type AutoRetryDeps } from "./sessions/auto-retry";
import { SessionLauncher } from "./sessions/launcher";
import { SessionLifecycle } from "./sessions/lifecycle";
import { Outbox } from "./sessions/outbox";
import { PrFeedbackService } from "./sessions/pr-feedback";
import { QuestionBroker } from "./sessions/questions";
import { QueueService } from "./sessions/queue";
import { SessionRecovery } from "./sessions/recovery";
import { SessionRepo } from "./sessions/repo";
import { SessionService } from "./sessions/session-service";
import { UnwatchedApprovals, type UnwatchedApprovalsDeps } from "./sessions/unwatched-approvals";
import { WorktreeCleanup, type WorktreeCleanupDeps } from "./sessions/worktree-cleanup";
import { ClaudeSdkService } from "./setup/claude-sdk";
import { SetupService } from "./setup/setup-service";
import { execLocate, type Locate } from "./setup/tool-lookup";
import { DesktopUpdateService } from "./updates/desktop";
import { notesSources, updateRegistry } from "./updates/registry";
import { type SelfUpdateHost, UpdateService, type Updates } from "./updates/service";
import { billingFromSetup } from "./usage/billing";
import { UsageService } from "./usage/usage-service";
import { ProviderUtilityService, runnerOneShot, type UtilityService } from "./utility";
import { LocalSttService, type LocalSttServiceDeps } from "./voice/local/local-stt-service";
import { VoiceService } from "./voice/voice-service";
import { WorkbenchService } from "./workbench/workbench-service";

export interface ServicesOptions {
  db: Db;
  store: EventStore;
  settings: SettingsStore;
  paths: HomePaths;
  runner: RunnerPort;
  secrets: SecretStore;
  exec?: Exec;
  /** Finds claude, codex and gh for the setup checks (tests fake it with `exec`). */
  locate?: Locate;
  /** Picks up PATH changes before a setup re-check (tests that pin PATH pass a no-op). */
  refreshPath?: () => Promise<unknown>;
  utility?: UtilityService;
  /** Default clone location (`~/codeden-projects`). */
  projectsDir?: string;
  /** User home for provider config roots (`~/.claude`, `~/.codex`). */
  userHome?: string;
  /** How long `ask_user` waits before returning "pending" (default 4 minutes). */
  askUserWaitMs?: number;
  /** Image engines (§12.5); Codex, Gemini and OpenAI with keychain API keys by default. */
  imageEngines?: ImageEngineRegistry;
  /** Cloud voice API base URLs (tests point them at a local stub). */
  voice?: { elevenLabsBaseUrl?: string; openAiBaseUrl?: string };
  /** Local Whisper downloads and runtime (tests serve fixtures and inject a fake runtime). */
  localStt?: Pick<
    LocalSttServiceDeps,
    "fetch" | "platform" | "runtimePins" | "models" | "loadRuntime" | "idleUnloadMs"
  >;
  /** Orchestration seams and timings (§8): GitHub and automation ports, wake debounce. */
  orchestration?: OrchestrationOptions & { github?: GithubPort; automation?: AutomationPort };
  /** GitHub API transport and poll intervals (tests point them at a fake GitHub). */
  github?: Pick<GithubServiceDeps, "fetch" | "baseUrl" | "idleIntervalMs" | "activeIntervalMs">;
  /** Automation clock, scheduler timings and file rescans (tests). */
  automations?: Pick<AutomationServiceDeps, "now" | "scheduler" | "templatesDir" | "rescanMs">;
  /** Factory loop timings and its GitHub port (§10.1; tests pass a scripted GitHub). */
  factory?: FactoryOptions & { github?: FactoryGithub };
  /** How the hosting process was started and how it restarts into another version (§16). */
  selfUpdate?: SelfUpdateHost;
  /** Update check transport (tests). */
  updates?: { fetch?: typeof fetch; intervalMs?: number };
  /** Worktree cleanup clock and sweep timings (tests). */
  worktreeCleanup?: Pick<WorktreeCleanupDeps, "now" | "intervalMs" | "initialDelayMs">;
  /** Unwatched approvals: how long they wait for the user (tests shorten it). */
  unwatchedApprovals?: Pick<UnwatchedApprovalsDeps, "waitMs" | "now">;
  /** Shorter retry waits (tests). */
  autoRetry?: Pick<AutoRetryDeps, "delaysMs" | "usageMarginMs">;
  log?: (message: string) => void;
}

/** Every application service, wired together. Routes and the realtime hub use these. */
export interface AppServices {
  db: Db;
  store: EventStore;
  settings: SettingsStore;
  paths: HomePaths;
  runner: RunnerPort;
  secrets: SecretStore;
  utility: UtilityService;
  projects: ProjectService;
  /** Re-detects projects' git checkout and GitHub remote (§9): on demand, on start, after turns. */
  redetector: ProjectRedetector;
  sessionRepo: SessionRepo;
  sessions: SessionService;
  /** The queued-message tray: list, edit, delete and send-now. */
  queue: QueueService;
  lifecycle: SessionLifecycle;
  recovery: SessionRecovery;
  questions: QuestionBroker;
  mcpTokens: McpTokenStore;
  /** CodeDen's tool registry (§8.3), exposed over MCP and to API handlers. */
  tools: ToolRegistry;
  workbench: WorkbenchService;
  inbox: InboxService;
  artifacts: ArtifactService;
  /** Session browsers in the runner (§12.2), for the panel and the agent tools. */
  browser: BrowserService;
  /** `generate_image` engines, caps and the settings test (§12.5). */
  images: ImageService;
  /** Optional cloud text to speech and transcription (§11.3). */
  voice: VoiceService;
  /** Local Whisper: runtime and model downloads, and transcription (§11.3). */
  localStt: LocalSttService;
  /** Update checks and one-click self-update (§16; the desktop app's own updater, §17). */
  updates: Updates;
  setup: SetupService;
  /** Claude Code support: the Claude Agent SDK, installed on demand (§14). */
  claudeSdk: ClaudeSdkService;
  configFiles: ConfigFiles;
  /** Provider memory, skills, subagents and MCP servers (§12.4). */
  agentConfig: AgentConfigService;
  /** Orchestrator and PM sessions, digests, notices, conflicts (§8). */
  orchestration: OrchestrationService;
  /** GitHub connection, issue/PR sync, PRs and evidence (§9). */
  github: GithubService;
  /** Usage and cost reports, budgets and rate limits (§12.6). */
  usage: UsageService;
  /** Automations: definitions, scheduler, runs and issue triage (§10). */
  automations: AutomationService;
  /** Autonomy modes and the dark-factory loop (§10.1). */
  factory: FactoryService;
  /** Session archive and worktree cleanup (§9). */
  worktreeCleanup: WorktreeCleanup;
  /** Denies approvals nobody is there to answer, so unattended work never waits forever. */
  unwatchedApprovals: UnwatchedApprovals;
  /** CI failures, requested changes and conflicts sent to user-started sessions' agents (§9). */
  prFeedback: PrFeedbackService;
  /** Continues agent sessions after transient failures and usage limits. */
  autoRetry: AutoRetry;
  userHome: string;
}

export function createServices(opts: ServicesOptions): AppServices {
  const exec = opts.exec ?? runTool;
  const userHome = opts.userHome ?? homedir();
  const utility =
    opts.utility ??
    new ProviderUtilityService({
      settings: () => opts.settings.get(),
      oneShot: runnerOneShot(opts.runner),
    });
  const projects = new ProjectService({
    db: opts.db,
    store: opts.store,
    exec,
    projectsDir: opts.projectsDir ?? join(userHome, "codeden-projects"),
  });
  const sessionRepo = new SessionRepo(opts.db, opts.store);
  const artifacts = new ArtifactService(opts.db, opts.store, opts.paths.artifacts);
  const outbox = new Outbox(opts.db, opts.store);
  const mcpTokens = new McpTokenStore(opts.db);
  const questions = new QuestionBroker({
    db: opts.db,
    store: opts.store,
    waitMs: opts.askUserWaitMs,
    sendMessage: () => async (sessionId, text, by) => {
      const input = by === "pm" ? messageFrom("pm", text) : { text, attachments: [] };
      await sessions?.send(sessionId, { input, whenBusy: "queue" }, by);
    },
  });
  let sessions: SessionService | undefined;
  const inbox = new InboxService(opts.db, opts.store, () => (sessionId, requestId, response) => {
    if (!sessions) throw new Error("Session service not ready");
    return sessions.respond(sessionId, { requestId, response });
  });
  const launcher = new SessionLauncher({
    repo: sessionRepo,
    projects,
    runner: opts.runner,
    inbox,
    worktreesDir: opts.paths.worktrees,
    orchestratorDir: opts.paths.orchestrator,
    tokens: mcpTokens,
    log: opts.log,
  });
  sessions = new SessionService({
    repo: sessionRepo,
    projects,
    runner: opts.runner,
    inbox,
    artifacts,
    settings: opts.settings,
    launcher,
    outbox,
    questions,
  });
  const queue = new QueueService({
    outbox,
    repo: sessionRepo,
    sessions,
    artifacts,
    providers: () => opts.runner.providers(),
  });
  const lifecycle = new SessionLifecycle({
    db: opts.db,
    store: opts.store,
    repo: sessionRepo,
    sessions,
    settings: opts.settings,
    utility,
    tokens: mcpTokens,
    log: opts.log,
  });
  const github = new GithubService({
    db: opts.db,
    store: opts.store,
    projects,
    repo: sessionRepo,
    runner: opts.runner,
    artifacts,
    inbox,
    exec,
    secrets: opts.secrets,
    ...opts.github,
    log: opts.log,
  });
  const redetector = new ProjectRedetector({
    projects,
    store: opts.store,
    repo: sessionRepo,
    onGithubChanged: (projectId) => github.sync.soon(projectId, { now: true }),
    log: opts.log,
  });
  const setup = new SetupService({
    exec,
    settings: opts.settings,
    // Tests that bring their own `exec` fake every CLI; the look-up goes through it too.
    locate: opts.locate ?? (opts.exec ? execLocate(opts.exec) : undefined),
    refreshPath: opts.refreshPath,
    userHome,
    // After an install or a login is re-checked, the runner's model lists follow.
    onChecked: () => redetectProviders(opts.runner, opts.log),
  });
  const claudeSdk = new ClaudeSdkService({ depsDir: opts.paths.deps, log: opts.log });
  const localStt = new LocalSttService({
    runtimeDir: join(opts.paths.deps, "whisper"),
    modelsDir: join(opts.paths.models, "whisper"),
    settings: opts.settings,
    ...opts.localStt,
    log: opts.log,
  });
  const automations = new AutomationService({
    db: opts.db,
    store: opts.store,
    settings: opts.settings,
    projects,
    sessions,
    repo: sessionRepo,
    inbox,
    orchestration: () => services.orchestration,
    home: opts.paths.home,
    ...opts.automations,
    log: opts.log,
  });
  const usage = new UsageService({
    db: opts.db,
    store: opts.store,
    settingsFile: join(opts.paths.home, "usage-settings.json"),
    billing: async () => (setup.lastStatus ? billingFromSetup(setup.lastStatus) : {}),
    log: opts.log,
  });
  const orchestration = new OrchestrationService({
    db: opts.db,
    store: opts.store,
    repo: sessionRepo,
    sessions,
    projects,
    inbox,
    github: opts.orchestration?.github ?? new GithubServicePort(github),
    automation: opts.orchestration?.automation ?? automations,
    options: opts.orchestration,
    log: opts.log,
  });
  const worktreeCleanup = new WorktreeCleanup({
    repo: sessionRepo,
    projects,
    runner: opts.runner,
    store: opts.store,
    settings: () => opts.settings.get(),
    stopSession: (id) => (sessions as SessionService).stop(id),
    inbox,
    ...opts.worktreeCleanup,
    log: opts.log,
  });
  const factory = new FactoryService({
    db: opts.db,
    store: opts.store,
    projects,
    repo: sessionRepo,
    sessions,
    runner: opts.runner,
    usage,
    inbox,
    notify: (draft, wake) => orchestration.notify(draft, wake),
    settings: opts.settings,
    exec,
    github: opts.factory?.github ?? new GithubFactoryPort(github),
    complete: (job, system, prompt) => utility.complete(job, system, prompt),
    archiveSession: (id) => worktreeCleanup.archive(id),
    options: opts.factory,
    log: opts.log,
  });
  const unwatchedApprovals = new UnwatchedApprovals({
    store: opts.store,
    repo: sessionRepo,
    projects,
    inbox,
    respond: (id, req) => (sessions as SessionService).respond(id, req),
    ...opts.unwatchedApprovals,
    log: opts.log,
  });
  const services: AppServices = {
    db: opts.db,
    store: opts.store,
    settings: opts.settings,
    paths: opts.paths,
    runner: opts.runner,
    secrets: opts.secrets,
    utility,
    projects,
    redetector,
    sessionRepo,
    sessions,
    queue,
    lifecycle,
    recovery: new SessionRecovery({
      repo: sessionRepo,
      sessions,
      launcher,
      runner: opts.runner,
      log: opts.log,
    }),
    inbox,
    artifacts,
    browser: new BrowserService({
      runner: opts.runner,
      repo: sessionRepo,
      settings: () => opts.settings.get(),
      log: opts.log,
    }),
    updates: createUpdates(opts),
    images: new ImageService({
      registry: opts.imageEngines ?? defaultImageEngines(opts.secrets),
      settings: opts.settings,
      artifacts,
      repo: sessionRepo,
      usageFile: join(opts.paths.home, "image-usage.json"),
      generatedDir: join(opts.paths.home, "generated"),
      log: opts.log,
    }),
    voice: new VoiceService({
      secrets: opts.secrets,
      settings: opts.settings,
      local: localStt,
      ...opts.voice,
    }),
    localStt,
    setup,
    claudeSdk,
    usage,
    factory,
    worktreeCleanup,
    unwatchedApprovals,
    prFeedback: new PrFeedbackService({
      store: opts.store,
      repo: sessionRepo,
      settings: () => opts.settings.get(),
      send: (id, input) => sessions.send(id, { input, whenBusy: "queue" }, "codeden"),
      log: opts.log,
    }),
    autoRetry: new AutoRetry({
      db: opts.db,
      store: opts.store,
      repo: sessionRepo,
      inbox,
      settings: () => opts.settings.get(),
      send: (id, input) => sessions.send(id, { input, whenBusy: "queue" }, "codeden"),
      ...opts.autoRetry,
      log: opts.log,
    }),
    configFiles: new ConfigFiles({
      projects,
      home: userHome,
      backupDir: join(opts.paths.backups, "files"),
    }),
    agentConfig: new AgentConfigService({
      home: userHome,
      projects,
      repo: sessionRepo,
      backupDir: join(opts.paths.backups, "agent-config"),
      mcpProxyUrl: () => opts.runner.mcpProxyUrl(),
    }),
    github,
    orchestration,
    automations,
    userHome,
    questions,
    mcpTokens,
    workbench: new WorkbenchService({ db: opts.db, repo: sessionRepo, runner: opts.runner }),
    tools: undefined as unknown as ToolRegistry,
  };
  services.tools = new ToolRegistry(allTools, services, opts.log);
  return services;
}

/** The built-in image engines, reading Gemini and OpenAI keys from the OS keychain. */
function defaultImageEngines(secrets: SecretStore): ImageEngineRegistry {
  const key = (name: "gemini.apiKey" | "openai.apiKey") => async () =>
    (await secrets.get(name)) ?? undefined;
  return createImageEngineRegistry({
    gemini: { apiKey: key("gemini.apiKey") },
    openai: { apiKey: key("openai.apiKey") },
  });
}

/** npm self-update for `codeden`, or the desktop app's own updater when it hosts the server. */
function createUpdates(opts: ServicesOptions): Updates {
  const common = {
    mode: () => opts.settings.get().updates.mode,
    checksDisabled: process.env.CODEDEN_UPDATE_CHECK === "0",
    notes: notesSources(),
    fetch: opts.updates?.fetch,
    intervalMs: opts.updates?.intervalMs,
    log: opts.log,
  };
  const desktop = opts.selfUpdate?.desktop;
  if (desktop) return new DesktopUpdateService({ ...common, desktop });
  return new UpdateService({
    ...common,
    home: opts.paths.home,
    host: opts.selfUpdate,
    registry: updateRegistry(),
  });
}

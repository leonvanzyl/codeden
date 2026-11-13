import { rmSync } from "node:fs";
import {
  CODEDEN_VERSION,
  type RunnerConnectionStatus,
  type ServerLock,
  TerminalQuery,
} from "@codeden/contracts";
import { ImageEngineRegistry } from "@codeden/providers";
import { createAdaptorServer, upgradeWebSocket } from "@hono/node-server";
import { Hono } from "hono";
import { WebSocketServer } from "ws";
import { type Database, openDatabase } from "./db/client";
import { EventStore } from "./events/store";
import { writeJsonFile } from "./json-file";
import { createMcpHandler } from "./mcp/endpoint";
import { NetworkAccess } from "./network/access";
import type { InterfaceMap } from "./network/addresses";
import { HttpListener } from "./network/listener";
import { RemoteAccessStore } from "./network/store";
import { ensureHome, type HomePaths } from "./paths";
import { BROWSER_LOOPBACK_ONLY_PATHS, mountBrowserSockets } from "./realtime/browser-routes";
import { WsHub } from "./realtime/hub";
import { TerminalBridge } from "./realtime/terminals";
import { createApi } from "./routes/api";
import { findWebDir, mountWeb } from "./routes/static";
import { RunnerClient } from "./runner/client";
import {
  defaultRunnerLaunch,
  type RunnerLaunchConfig,
  type RunnerStartTimeouts,
} from "./runner/launcher";
import { loopbackOrigins, securityMiddleware } from "./security";
import { type AppServices, createServices, type ServicesOptions } from "./services/container";
import type { Exec } from "./services/exec";
import { FILE_RESET_NOTICES, reportFileReset } from "./services/file-reset-notice";
import { runnerPort } from "./services/runner-port";
import { createSecretStore, MemorySecretStore, type SecretStore } from "./services/secrets";
import { sessionWorkdir } from "./services/sessions/workdir";
import type { Locate } from "./services/setup/tool-lookup";
import type { UtilityService } from "./services/utility";
import { SettingsStore } from "./settings-store";

export interface StartServerOptions {
  /**
   * Port to listen on: 127.0.0.1, or 0.0.0.0 while network access is on (§15.1). 0 picks a
   * free port; a later switch keeps the port.
   */
  port: number;
  /** Data directory (`~/.codeden` by default; resolve it with `resolveHome`). */
  dataDir: string;
  /** Per-install token required on every request (§15). */
  token: string;
  /**
   * How to start the runner. `undefined` = auto-detect (bundle or monorepo source),
   * `false` = don't use a runner (tests, UI-only work).
   */
  runner?: RunnerLaunchConfig | false;
  /** How long to wait for a runner this server spawns (tests shorten the slow-start note). */
  runnerStartTimeouts?: RunnerStartTimeouts;
  /** Load the scripted Fake provider in the runner (development and tests). */
  enableFakeProvider?: boolean;
  /**
   * Load the real Claude Code, Codex and OpenCode adapters in a runner this server starts.
   * Default true, unless `CODEDEN_BUILTIN_PROVIDERS=0` (the server test suite sets it).
   */
  builtinProviders?: boolean;
  /**
   * Run OpenCode from this executable in a runner this server starts (`--opencode`): an
   * install outside PATH, or the fake OpenCode in tests.
   */
  openCodeExecutable?: string;
  /** Built web assets to serve; auto-detected when omitted. */
  webDir?: string;
  /** Extra allowed origins, e.g. the Vite dev server. */
  allowedOrigins?: string[];
  /** Drizzle migrations folder; auto-detected when omitted. */
  migrationsDir?: string;
  /** Wait for the runner handshake before resolving. Default false. */
  waitForRunner?: boolean;
  /** Called when a client requests shutdown via the API (the CLI exits the process). */
  onShutdownRequest?: () => void;
  /** Secret storage: the OS keychain by default; `"memory"` for tests. */
  secrets?: SecretStore | "memory";
  /** Utility-model jobs (§7.4); one-shots through the runner's providers by default. */
  utility?: UtilityService;
  /** Runs CLI tools (detection, git); injectable for tests. */
  exec?: Exec;
  /** Finds claude, codex and gh for the setup checks; injectable for tests. */
  locate?: Locate;
  /**
   * Picks up PATH changes before a setup re-check (default: the Windows registry's `Path`).
   * Tests that pin PATH pass a no-op.
   */
  refreshPath?: () => Promise<unknown>;
  /** User home for provider config files and the default clone folder. */
  userHome?: string;
  /** Where clones go by default (`~/codeden-projects`). */
  projectsDir?: string;
  /** How long `ask_user` waits for an answer before returning "pending" (default 4 min). */
  askUserWaitMs?: number;
  /** Batching window for live UI updates (default 40ms). */
  realtimeFlushMs?: number;
  /**
   * Image engines for `generate_image` (§12.5). Default: Codex, Gemini and OpenAI, or none
   * when built-in providers are off (`CODEDEN_BUILTIN_PROVIDERS=0`, the server test suite).
   */
  imageEngines?: ImageEngineRegistry;
  /** Cloud voice API base URLs (tests). */
  voice?: { elevenLabsBaseUrl?: string; openAiBaseUrl?: string };
  /** Local Whisper downloads and runtime (tests). */
  localStt?: ServicesOptions["localStt"];
  /** Orchestration seams and timings (§8): GitHub/automation ports, wake debounce, ask_pm wait. */
  orchestration?: ServicesOptions["orchestration"];
  /**
   * GitHub (§9): API transport and poll intervals for tests, and `sync: false` to skip
   * background polling (default on unless `CODEDEN_GITHUB_SYNC=0`).
   */
  github?: ServicesOptions["github"] & { sync?: boolean };
  /** Automations (§10): clock, scheduler timings and file rescans for tests. */
  automations?: ServicesOptions["automations"];
  /** Factory loop (§10.1): tick interval, background ticking, a scripted GitHub for tests. */
  factory?: ServicesOptions["factory"];
  /** Run first-run detection in the background on launch (default true). */
  checkSetupOnStart?: boolean;
  /**
   * How the hosting process was started and how it restarts into another CodeDen version
   * (§16). The `codeden` CLI passes it; without it the server counts as running from source.
   */
  selfUpdate?: ServicesOptions["selfUpdate"];
  /** Update check transport and interval (tests). */
  updates?: ServicesOptions["updates"];
  /** Worktree cleanup clock and sweep timings (tests). */
  worktreeCleanup?: ServicesOptions["worktreeCleanup"];
  /** Automatic retry waits (tests). */
  autoRetry?: ServicesOptions["autoRetry"];
  /** Network interfaces for the address list (tests). */
  networkInterfaces?: () => InterfaceMap;
  log?: (message: string) => void;
}

export interface RunningServer {
  port: number;
  /** Base URL, e.g. `http://127.0.0.1:4317`. */
  url: string;
  /** URL that authenticates the browser on first load. */
  launchUrl: string;
  paths: HomePaths;
  store: EventStore;
  database: Database;
  services: AppServices;
  runner: RunnerClient | undefined;
  /** Network access (§15.1): the switch, password, remote sessions and the listener binding. */
  network: NetworkAccess;
  /** Stop listening and disconnect from the runner (which keeps running). */
  close(opts?: { stopRunner?: boolean }): Promise<void>;
}

/**
 * Start the CodeDen server (§4.1). This is the only entry point; it imports nothing
 * platform-specific so a desktop shell can host it later (§17).
 */
export async function startServer(opts: StartServerOptions): Promise<RunningServer> {
  const log = opts.log ?? (() => {});
  const paths = ensureHome(opts.dataDir);
  const database = openDatabase(paths.db, opts.migrationsDir);
  const store = new EventStore(database.db);
  const settings = new SettingsStore(paths.settings);
  if (settings.reset) reportFileReset(settings.reset, FILE_RESET_NOTICES.settings, { store, log });
  const startedAt = Date.now();
  let port = opts.port;
  let runner: RunnerClient | undefined;
  let closing: Promise<void> | undefined;

  const disabledStatus: RunnerConnectionStatus = {
    state: "disabled",
    runnerId: null,
    version: null,
    providers: [],
    lastError: null,
  };
  const runnerStatus = () => runner?.status ?? disabledStatus;
  const hub = new WsHub(store, database.db, runnerStatus, {
    flushMs: opts.realtimeFlushMs,
    updateStatus: () => services.updates.snapshot(),
    artifacts: { artifactForPath: (path) => services.artifacts.artifactForPath(path) },
  });
  const secrets =
    opts.secrets === "memory"
      ? new MemorySecretStore()
      : (opts.secrets ?? (await createSecretStore(log)));
  const builtin = opts.builtinProviders ?? process.env.CODEDEN_BUILTIN_PROVIDERS !== "0";
  const services = createServices({
    db: database.db,
    store,
    settings,
    paths,
    runner: runnerPort(() => runner),
    secrets,
    exec: opts.exec,
    locate: opts.locate,
    refreshPath: opts.refreshPath,
    utility: opts.utility,
    userHome: opts.userHome,
    projectsDir: opts.projectsDir,
    askUserWaitMs: opts.askUserWaitMs,
    imageEngines: opts.imageEngines ?? (builtin ? undefined : new ImageEngineRegistry([])),
    voice: opts.voice,
    localStt: opts.localStt,
    orchestration: opts.orchestration,
    github: opts.github,
    automations: opts.automations,
    factory: opts.factory,
    selfUpdate: opts.selfUpdate,
    updates: opts.updates,
    worktreeCleanup: opts.worktreeCleanup,
    autoRetry: opts.autoRetry,
    log,
  });
  // Find out early whether `generate_image` can be offered to agents.
  void services.images.refresh();
  services.lifecycle.start();
  services.orchestration.start();
  services.github.start({ sync: opts.github?.sync ?? process.env.CODEDEN_GITHUB_SYNC !== "0" });
  // A folder may have gained a git checkout or a GitHub remote while CodeDen was away.
  services.redetector.start();
  services.usage.start();
  services.automations.start();
  services.factory.start();
  services.worktreeCleanup.start();
  services.unwatchedApprovals.start();
  // Also shows the images of tool calls stored while the server stopped mid-copy.
  void services.generatedImages.start();
  services.prFeedback.start();
  services.autoRetry.start();
  const stopUpdateEvents = services.updates.onChange((status) => hub.broadcastUpdate(status));
  services.updates.start();

  let baseOrigins = new Set<string>();
  const app = new Hono();
  const wss = new WebSocketServer({ noServer: true });
  // The HTTP server never listens itself: `HttpListener` hands it connections, so network
  // access can move between 127.0.0.1 and 0.0.0.0 without touching open connections.
  const httpServer = createAdaptorServer({ fetch: app.fetch, websocket: { server: wss } });
  const listener = new HttpListener(httpServer as import("node:http").Server);
  const network = new NetworkAccess({
    store: new RemoteAccessStore(paths.remoteAccess, Date.now, (reset) =>
      reportFileReset(reset, FILE_RESET_NOTICES.remoteAccess, { store, log }),
    ),
    listener,
    interfaces: opts.networkInterfaces,
    securityLogFile: paths.remoteAccessLog,
    log,
  });
  const sessionCookie = () => `codeden_session_${port}`;
  const tokenCookie = () => `codeden_token_${port}`;
  const allowedOrigins = () => {
    const own = [...network.ownHosts()].map((h) => `http://${h}:${port}`);
    return own.length === 0 ? baseOrigins : new Set([...baseOrigins, ...own]);
  };
  app.use(
    "*",
    securityMiddleware({
      token: opts.token,
      cookieName: tokenCookie,
      allowedOrigins,
      // `/mcp` authenticates agents with per-session tokens instead of the install token.
      publicPaths: new Set(["/api/health", "/mcp"]),
      // Agents and the desktop app only: never reachable from another device.
      loopbackOnlyPaths: new Set(["/mcp", ...BROWSER_LOOPBACK_ONLY_PATHS]),
      remote: {
        enabled: () => network.enabled,
        ownHosts: () => network.ownHosts(),
        port: () => port,
        sessionCookieName: sessionCookie,
        verifySession: (token) => network.store.verifySession(token),
      },
    }),
  );
  const api = createApi({
    services,
    runnerStatus,
    startedAt,
    network: { network, sessionCookie, tokenCookie, token: opts.token },
    log,
    shutdown: ({ stopRunner }) => {
      setTimeout(() => {
        void close({ stopRunner }).then(() => opts.onShutdownRequest?.());
      }, 50);
    },
  });
  app.route("/api", api);
  const mcp = createMcpHandler({ tokens: services.mcpTokens, registry: services.tools, log });
  app.all("/mcp", (c) => mcp(c.req.raw));
  app.get(
    "/ws",
    upgradeWebSocket(() => hub.handlers()),
  );
  const terminals = new TerminalBridge({
    runner: services.runner,
    cwdFor: (sessionId) => {
      const session = sessionId ? services.sessionRepo.find(sessionId)?.session : undefined;
      return session ? sessionWorkdir(session) : paths.home;
    },
    log,
  });
  const stopTerminalEvents = store.subscribe((events) => terminals.onEvents(events));
  app.get("/ws/pty", async (c, next) => {
    const query = TerminalQuery.safeParse(c.req.query());
    if (!query.success)
      return c.json({ error: { code: "bad_request", message: "Invalid terminal query" } }, 400);
    return upgradeWebSocket(() => terminals.handlers(query.data))(c, next);
  });
  const browserBridge = mountBrowserSockets(app, services, log);
  mountWeb(app, findWebDir(opts.webDir));

  if (network.store.enabled && !network.store.passwordSet) {
    log("network access is on but no password is set: listening on 127.0.0.1 only");
  }
  port = await listener.listen(opts.port, network.desiredHost());
  baseOrigins = new Set([...loopbackOrigins(port), ...(opts.allowedOrigins ?? [])]);
  const url = `http://127.0.0.1:${port}`;
  const lock: ServerLock = {
    pid: process.pid,
    port,
    version: CODEDEN_VERSION,
    startedAt: new Date(startedAt).toISOString(),
  };
  writeJsonFile(paths.serverLock, lock);
  log(`server listening on ${url}`);
  if (network.enabled) {
    log(
      `network access on: ${network
        .addresses()
        .map((a) => `${a.label} ${a.url}`)
        .join(", ")}`,
    );
  }

  if (opts.checkSetupOnStart !== false) {
    // Re-check tools silently on every launch (§14 step 6); results are cached.
    services.setup
      .status({ refresh: true })
      .catch((error: unknown) => log(`setup: ${String(error)}`));
  }

  if (opts.runner !== false) {
    const args = [
      ...(opts.enableFakeProvider ? ["--fake"] : []),
      ...(builtin ? [] : ["--no-builtin"]),
      ...(opts.openCodeExecutable ? ["--opencode", opts.openCodeExecutable] : []),
    ];
    const launch = opts.runner ?? defaultRunnerLaunch(args) ?? null;
    runner = new RunnerClient({
      home: paths.home,
      lockFile: paths.runnerLock,
      db: database.db,
      store,
      launch,
      mcpUpstreamUrl: `${url}/mcp`,
      startTimeouts: opts.runnerStartTimeouts,
      onStatus: (status) => hub.broadcastRunner(status),
      onStream: (stream) => {
        if (stream.kind === "pty.output") terminals.onStream(stream);
        else browserBridge.onStream(stream);
      },
      onReady: () => void services.recovery.onRunnerReady(),
      log,
    });
    const started = runner.start();
    if (opts.waitForRunner) await started;
    else started.catch((error: unknown) => log(`runner: ${String(error)}`));
  }

  async function close(closeOpts: { stopRunner?: boolean } = {}): Promise<void> {
    closing ??= (async () => {
      services.lifecycle.stop();
      services.orchestration.stop();
      services.github.stop();
      services.redetector.stop();
      services.usage.stop();
      services.automations.stop();
      services.factory.stop();
      services.worktreeCleanup.stop();
      services.unwatchedApprovals.stop();
      services.generatedImages.stop();
      services.prFeedback.stop();
      services.autoRetry.stop();
      services.updates.stop();
      await services.localStt.stop();
      stopUpdateEvents();
      stopTerminalEvents();
      if (runner) {
        if (closeOpts.stopRunner) await runner.shutdownRunner();
        else await runner.stop();
      }
      hub.close();
      wss.close();
      await listener.close();
      if ("closeAllConnections" in httpServer) httpServer.closeAllConnections();
      database.close();
      rmSync(paths.serverLock, { force: true });
    })();
    return closing;
  }

  return {
    port,
    url,
    launchUrl: `${url}/?token=${opts.token}`,
    paths,
    store,
    database,
    services,
    runner,
    network,
    close,
  };
}

/** Type of the HTTP API for the Hono RPC client (`hc<AppType>(baseUrl + "/api")`). */
export type AppType = ReturnType<typeof createApi>;

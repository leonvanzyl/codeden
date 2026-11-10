import { randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import {
  CODEDEN_VERSION,
  RUNNER_PROTOCOL_VERSION,
  type RunnerEvent,
  type RunnerLock,
  type RunnerStream,
} from "@codeden/contracts";
import {
  builtinProviders,
  configureClaudeSdk,
  FakeProvider,
  loadFixture,
  OpenCodeAdapter,
  type ProviderAdapter,
  ProviderRegistry,
  ReplayProvider,
  type ResolvedCommand,
  resolveExecutable,
} from "@codeden/providers";
import { serve, upgradeWebSocket } from "@hono/node-server";
import { Hono } from "hono";
import { WebSocketServer } from "ws";
import { BrowserManager, createBrowserCommandHandlers } from "./browser";
import type { RunnerCore } from "./commands";
import { connectionHandlers, type ServerConnection } from "./connection";
import { Journal } from "./journal";
import { assertSingleInstance, removeOwnLock } from "./lock";
import { HttpMcpUpstream, handleMcpRequest, type McpUpstream } from "./mcp/proxy";
import { ProcessSupervisor } from "./process/supervisor";
import { TerminalHost } from "./pty/terminal-host";
import { SessionHost } from "./session-host";
import { emptyTrash } from "./workspace/trash";

export interface StartRunnerOptions {
  /** CodeDen data directory; the runner uses `<home>/runner/` and `<home>/wt/`. */
  home: string;
  /** Load the scripted Fake provider (development and tests). */
  enableFakeProvider?: boolean;
  /** Extra adapters (tests). */
  adapters?: ProviderAdapter[];
  /** Load the real Claude Code, Codex and OpenCode adapters (the runner process does; tests opt in). */
  builtinProviders?: boolean;
  /**
   * Run OpenCode from this executable instead of looking for `opencode` (an install outside
   * PATH, or the fake OpenCode in end-to-end tests). Loads OpenCode even without the built-ins.
   */
  openCodeExecutable?: string;
  /** Recorded fixtures to serve as Replay providers (tests), registered as `replay-<n>`. */
  replayFixtures?: string[];
  /** Port to listen on (127.0.0.1); 0 = random. */
  port?: number;
  /** Initial MCP proxy upstream (the server's `/mcp`); also set by `runner.configure`. */
  mcpUpstreamUrl?: string;
  /** Version reported in the handshake and lock file. Default `CODEDEN_VERSION` (tests override). */
  version?: string;
  /** On close, also kill leftover descendants of this process (the real runner process). */
  sweepDescendants?: boolean;
  /** Replace the browser engine (tests); by default one `BrowserManager` per runner. */
  browser?: BrowserManager;
  /** Called after `runner.shutdown` or a drain-and-exit closed everything (the CLI exits). */
  onShutdown?: () => void;
  log?: (message: string) => void;
}

export interface RunningRunner {
  port: number;
  token: string;
  lockFile: string;
  /** Agent-facing MCP proxy URL. */
  mcpUrl: string;
  close(): Promise<void>;
}

const LOOPBACK = /^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/i;
const DEFAULT_DRAIN_TIMEOUT = 5 * 60_000;
/**
 * A server attaching refreshes provider model lists confirmed longer ago than this (or by an
 * executable that has changed since). Each refresh starts a provider CLI, so not on every
 * reconnect; runner start-up, sessions and `provider.detect` refresh too.
 */
export const MODEL_LIST_MAX_AGE_MS = 10 * 60_000;

/**
 * Start the runner (§4.2): WebSocket server on 127.0.0.1, lock file with port/token/pid,
 * provider sessions, terminals, git/worktree operations, the local MCP proxy and a durable
 * journal. Survives server restarts.
 */
/** An `opencode` given by path: a JavaScript file runs with Node.js (the e2e stand-in). */
function openCodeCommand(file: string): ResolvedCommand | undefined {
  if (/\.[cm]?js$/i.test(file)) {
    return existsSync(file) ? { kind: "node-script", path: file, script: file } : undefined;
  }
  return resolveExecutable(file);
}

export async function startRunner(opts: StartRunnerOptions): Promise<RunningRunner> {
  const log = opts.log ?? (() => {});
  const version = opts.version ?? CODEDEN_VERSION;
  const dir = join(opts.home, "runner");
  mkdirSync(dir, { recursive: true });
  const lockFile = join(dir, "runner.json");
  await assertSingleInstance(lockFile);

  const token = randomBytes(32).toString("hex");
  const journal = new Journal(dir);
  // Claude Code support is installed on demand into `<home>/deps` in the published package.
  configureClaudeSdk({
    depsDir: join(opts.home, "deps"),
    onProgress: (line) => log(`claude sdk: ${line}`),
  });
  const registry = new ProviderRegistry(opts.adapters ?? []);
  if (opts.enableFakeProvider && !registry.get("fake"))
    registry.register(new FakeProvider({ delayMs: 15 }));
  if (opts.openCodeExecutable && !registry.get("opencode")) {
    const executable = openCodeCommand(opts.openCodeExecutable);
    if (executable) registry.register(new OpenCodeAdapter({ executable }));
    else log(`opencode: ${opts.openCodeExecutable} not found; looking for it on PATH`);
  }
  if (opts.builtinProviders) {
    for (const adapter of builtinProviders())
      if (!registry.get(adapter.id)) registry.register(adapter);
  }
  opts.replayFixtures?.forEach((file, i) => {
    registry.register(
      new ReplayProvider(loadFixture(file), { id: i === 0 ? "replay" : `replay-${i}` }),
    );
  });

  const connections = new Set<ServerConnection>();
  let attached: ServerConnection | undefined;
  let draining = false;
  let drainExit: Promise<void> | undefined;
  let closing: Promise<void> | undefined;
  let mcpUpstream: McpUpstream | undefined = opts.mcpUpstreamUrl
    ? new HttpMcpUpstream(opts.mcpUpstreamUrl)
    : undefined;
  let port = 0;

  let stopped = false;
  const emit = (event: RunnerEvent) => {
    if (stopped) return; // late callbacks after close (killed processes)
    const msg = journal.append(event);
    attached?.deliver(msg);
  };
  const stream = (data: RunnerStream) => {
    attached?.deliver({ type: "stream", ts: new Date().toISOString(), stream: data });
  };
  // Model lists change after the handshake (discovery, sessions): keep the server current.
  const stopProviderUpdates = registry.onChange(() => {
    if (!stopped) attached?.deliver({ type: "providers", providers: registry.info() });
  });
  const supervisor = new ProcessSupervisor();
  const host = new SessionHost(registry, emit, { log });
  const terminals = new TerminalHost({ supervisor, emit, stream });
  // Chromium launches lazily on the first `browser.*` command (§12.2).
  const browserManager = opts.browser ?? new BrowserManager({ stream, log });
  const browser = createBrowserCommandHandlers({ manager: browserManager });
  const finish = () => void close().then(() => opts.onShutdown?.());

  const core: RunnerCore = {
    home: opts.home,
    version,
    journal,
    host,
    terminals,
    supervisor,
    registry,
    browser,
    startedAt: new Date().toISOString(),
    emit,
    log,
    isDraining: () => draining,
    drain: ({ reason, timeoutMs, exitWhenDrained }) => {
      if (!draining) {
        draining = true;
        log(`draining: ${reason}`);
        emit({ kind: "runner.draining", reason });
      }
      if (exitWhenDrained && !drainExit) {
        drainExit = host.drain(timeoutMs ?? DEFAULT_DRAIN_TIMEOUT).then(finish);
      }
    },
    configureMcp: (url) => {
      mcpUpstream = url ? new HttpMcpUpstream(url) : undefined;
      return url ? `http://127.0.0.1:${port}/mcp` : null;
    },
    shutdown: () => {
      setTimeout(finish, 50);
    },
  };

  const app = new Hono();
  app.use("*", async (c, next) => {
    if (!LOOPBACK.test(c.req.header("host") ?? "")) return c.text("Forbidden host", 403);
    // Only the server and agents' MCP clients call the runner; a browser page never may.
    if (c.req.header("origin") !== undefined) return c.text("Forbidden origin", 403);
    return next();
  });
  // Agents authenticate with their session-scoped token, validated by the server.
  app.all("/mcp", (c) => handleMcpRequest(c.req.raw, mcpUpstream));
  app.use("*", async (c, next) => {
    const auth = c.req.header("authorization") ?? "";
    const given = Buffer.from(auth.replace(/^Bearer\s+/i, ""));
    const expected = Buffer.from(token);
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
      return c.text("Unauthorized", 401);
    }
    return next();
  });
  app.get("/health", (c) => c.json({ ok: true, version, runnerId: journal.runnerId }));
  app.get(
    "/runner",
    upgradeWebSocket(() =>
      connectionHandlers(
        core,
        (conn) => connections.add(conn),
        (conn) => {
          connections.delete(conn);
          if (attached === conn) attached = undefined;
        },
        (conn) => {
          // A newer server connection replaces the previous one.
          if (attached && attached !== conn) attached.close("replaced by a new connection");
          attached = conn;
          log("server attached");
          // The runner outlives app restarts, and a model release changes a provider's list
          // without any local change: a (re)starting app gets a fresh list unless it is recent.
          void registry.refreshModels(undefined, { maxAgeMs: MODEL_LIST_MAX_AGE_MS });
        },
      ),
    ),
  );

  const wss = new WebSocketServer({ noServer: true });
  const server = await new Promise<ReturnType<typeof serve>>((resolve, reject) => {
    const s = serve(
      { fetch: app.fetch, port: opts.port ?? 0, hostname: "127.0.0.1", websocket: { server: wss } },
      () => resolve(s),
    );
    s.once("error", reject);
  });
  port = (server.address() as AddressInfo).port;

  const lock: RunnerLock = {
    pid: process.pid,
    port,
    token,
    version,
    protocolVersion: RUNNER_PROTOCOL_VERSION,
    runnerId: journal.runnerId,
    startedAt: core.startedAt,
    providers: registry.list().map((a) => a.id),
  };
  const tmp = `${lockFile}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(lock, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, lockFile);
  log(`runner ${journal.runnerId} listening on 127.0.0.1:${port}`);
  // Ask providers for their models now, so pickers are right before the first session.
  // Spawns provider CLIs, so it runs in the background; it never throws.
  void registry.refreshModels();
  // Finish deleting worktrees a previous run moved to the trash; it never throws.
  void emptyTrash(opts.home, log);

  const removeLock = () => removeOwnLock(lockFile);
  process.once("exit", removeLock);

  async function close(): Promise<void> {
    closing ??= (async () => {
      // Stop advertising first so a new server spawns a fresh runner instead of reconnecting.
      removeLock();
      stopProviderUpdates();
      await host.closeAll();
      await terminals.closeAll();
      await browserManager.shutdown().catch((error: unknown) => log(`browser: ${String(error)}`));
      await supervisor.killAll(opts.sweepDescendants ?? false);
      for (const conn of connections) conn.close("runner stopping");
      wss.close();
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
        if ("closeAllConnections" in server) server.closeAllConnections();
      });
      process.off("exit", removeLock);
      stopped = true;
      log("runner stopped");
    })();
    return closing;
  }

  return { port, token, lockFile, mcpUrl: `http://127.0.0.1:${port}/mcp`, close };
}

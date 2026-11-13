import { randomUUID } from "node:crypto";
import {
  CODEDEN_VERSION,
  RUNNER_PROTOCOL_VERSION,
  type RunnerCommand,
  type RunnerCommandName,
  type RunnerCommandOf,
  type RunnerCommandResult,
  RunnerCommandResults,
  type RunnerConnectionStatus,
  type RunnerEventMessage,
  type RunnerLock,
  type RunnerStream,
  RunnerToServerMessage,
  type RunnerWelcome,
  type ServerToRunnerMessage,
} from "@codeden/contracts";
import { eq } from "drizzle-orm";
import WebSocket from "ws";
import type { Db } from "../db/client";
import { runnerState } from "../db/schema";
import { ingestRunnerEvent } from "../events/ingest";
import type { EventStore } from "../events/store";
import { type RunnerLaunchConfig, type RunnerStartTimeouts, startRunnerProcess } from "./launcher";
import { isProcessAlive, probeRunnerLock, readLiveRunnerLock } from "./lock";

export interface RunnerClientOptions {
  /**
   * The runner's record id (`runners.id`), stamped on its `runner.*` events. Omitted: the home
   * runner, as in event logs from before several runners existed.
   */
  recordId?: string;
  /** Names a runner other than the home runner in its errors, e.g. "Runner rn-1 (docker)". */
  name?: string;
  home: string;
  lockFile: string;
  db: Db;
  store: EventStore;
  /** How to start a runner when none is live; `null` only attaches to an existing one. */
  launch: RunnerLaunchConfig | null;
  /** Called on every connection status change. */
  onStatus?: (status: RunnerConnectionStatus) => void;
  /** Ephemeral stream data (terminal output, browser frames). */
  onStream?: (stream: RunnerStream) => void;
  log?: (message: string) => void;
  /**
   * How long to wait for a spawned runner's lock file. A live runner is waited for well past
   * `slowAfterMs` (default 20 s); only `timeoutMs` (default 5 minutes) gives up on it.
   */
  startTimeouts?: RunnerStartTimeouts;
  /**
   * The server's MCP endpoint (`http://127.0.0.1:<port>/mcp`). Pushed to the runner after
   * every handshake so its local proxy (§4.4) forwards there.
   */
  mcpUpstreamUrl?: string;
  /** How long a version-mismatch drain may wait for running turns. Default 5 minutes. */
  drainTimeoutMs?: number;
  /**
   * Called once a current, non-draining runner is connected and configured (MCP proxy set),
   * e.g. to resume sessions interrupted by a runner restart.
   */
  onReady?: (runnerId: string) => void;
}

interface Pending {
  name: RunnerCommandName;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

/** Error returned by the runner for a failed command. */
export class RunnerCommandError extends Error {
  constructor(
    readonly code: string | undefined,
    message: string,
  ) {
    super(message);
    this.name = "RunnerCommandError";
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Server side of the runner protocol (§4.3): finds or starts the runner, connects,
 * handshakes, persists durable events (acking by seq after commit) and reconnects.
 */
export class RunnerClient {
  private ws: WebSocket | undefined;
  private stopped = false;
  private reconnectDelay = 250;
  private readonly pending = new Map<string, Pending>();
  private connectedWaiters: Array<() => void> = [];
  private runnerId: string | undefined;
  private lastAckedSeq = 0;
  private proxyUrl: string | null = null;
  private runnerPid: number | undefined;
  private current: RunnerConnectionStatus = {
    state: "starting",
    runnerId: null,
    version: null,
    providers: [],
    lastError: null,
  };

  constructor(private readonly opts: RunnerClientOptions) {}

  get status(): RunnerConnectionStatus {
    return this.current;
  }

  /** Agent-facing MCP proxy URL on the runner, once configured. */
  get mcpProxyUrl(): string | null {
    return this.proxyUrl;
  }

  /** Ensure a runner is live and connect. Resolves once the handshake completed. */
  async start(): Promise<void> {
    this.stopped = false;
    const connected = this.waitForConnection();
    void this.connectLoop();
    await connected;
  }

  /** Resolve when connected (immediately if already). */
  waitForConnection(): Promise<void> {
    if (this.current.state === "connected") return Promise.resolve();
    return new Promise((resolve) => this.connectedWaiters.push(resolve));
  }

  /** Send a command and await its typed result. */
  async request<N extends RunnerCommandName>(
    command: RunnerCommandOf<N>,
    timeoutMs = 30_000,
  ): Promise<RunnerCommandResult<N>> {
    const ws = this.ws;
    if (!ws || this.current.state !== "connected") {
      throw this.unavailable("is not connected");
    }
    const id = randomUUID();
    const result = new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new RunnerCommandError("timeout", `Runner command ${command.name} timed out`));
      }, timeoutMs);
      this.pending.set(id, { name: command.name, resolve, reject, timer });
    });
    this.send({ type: "command", id, command: command as RunnerCommand });
    const raw = await result;
    return RunnerCommandResults[command.name as N].parse(raw) as RunnerCommandResult<N>;
  }

  /** Disconnect without stopping the runner (it keeps agents alive across server restarts). */
  async stop(): Promise<void> {
    this.stopped = true;
    const ws = this.ws;
    this.ws = undefined;
    if (ws && ws.readyState === WebSocket.OPEN) {
      await new Promise<void>((resolve) => {
        ws.once("close", () => resolve());
        ws.close(1000, "server stopping");
        setTimeout(resolve, 1000).unref();
      });
    }
    this.failPending("client stopped");
  }

  /** Ask the runner process to exit, then disconnect. */
  async shutdownRunner(timeoutMs = 10_000): Promise<void> {
    const pid = this.runnerPid;
    if (this.current.state === "connected") {
      await this.request({ name: "runner.shutdown" }, 5_000).catch(() => undefined);
    }
    await this.stop();
    // Resolve only once the process is gone, so callers can remove the home directory.
    const deadline = Date.now() + timeoutMs;
    while (pid !== undefined && isProcessAlive(pid) && Date.now() < deadline) await sleep(50);
  }

  // ---------------------------------------------------------------- connection

  private async connectLoop(): Promise<void> {
    while (!this.stopped) {
      try {
        const lock = await this.ensureRunner();
        await this.connect(lock);
        this.reconnectDelay = 250;
        return; // `close` handler restarts the loop.
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.setStatus({ ...this.current, state: "disconnected", lastError: message });
        this.opts.log?.(`runner: ${message}; retrying in ${this.reconnectDelay}ms`);
        await sleep(this.reconnectDelay);
        this.reconnectDelay = Math.min(this.reconnectDelay * 2, 5_000);
      }
    }
  }

  private async ensureRunner(): Promise<RunnerLock> {
    const existing = readLiveRunnerLock(this.opts.lockFile);
    if (existing && (await probeRunnerLock(existing))) return existing;
    if (existing) {
      this.opts.log?.(`runner: pid ${existing.pid} does not answer; starting a new runner`);
    }
    if (!this.opts.launch) throw new Error("No live runner and launching is disabled");
    this.opts.log?.("runner: starting a new runner process");
    // A retry after a failed start keeps showing why the previous attempt failed.
    const previous = this.current.state === "disconnected" ? this.current.lastError : null;
    this.setStatus({ ...this.current, state: "starting", lastError: previous });
    return startRunnerProcess({
      launch: this.opts.launch,
      home: this.opts.home,
      lockFile: this.opts.lockFile,
      stale: existing,
      timeouts: this.opts.startTimeouts,
      onSlow: ({ pid, elapsedMs }) => {
        const s = Math.round(elapsedMs / 1000);
        this.opts.log?.(`runner: pid ${pid} is still starting after ${s} s; waiting for it`);
        const lastError = "The runner is taking longer than usual to start";
        this.setStatus({ ...this.current, state: "starting", lastError });
      },
    });
  }

  private connect(lock: RunnerLock): Promise<void> {
    this.runnerPid = lock.pid;
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${lock.port}/runner`, {
        headers: { authorization: `Bearer ${lock.token}` },
      });
      let settled = false;
      const settle = (error?: Error) => {
        if (settled) return;
        settled = true;
        if (error) reject(error);
        else resolve();
      };
      ws.on("open", () => {
        this.ws = ws;
        this.send({
          type: "hello",
          protocolVersion: RUNNER_PROTOCOL_VERSION,
          serverVersion: CODEDEN_VERSION,
        });
      });
      ws.on("message", (data) => {
        try {
          this.handle(RunnerToServerMessage.parse(JSON.parse(data.toString())), settle);
        } catch (error) {
          this.opts.log?.(`runner: bad message: ${(error as Error).message}`);
        }
      });
      ws.on("error", (error) => settle(error));
      ws.on("close", () => {
        const wasConnected = this.current.state === "connected";
        if (this.ws === ws) this.ws = undefined;
        settle(new Error("Runner connection closed during handshake"));
        if (wasConnected && this.runnerId) {
          this.opts.store.append([
            {
              type: "runner.disconnected",
              sessionId: null,
              payload: {
                ...this.recordRef(),
                runnerId: this.runnerId,
                reason: "connection closed",
              },
            },
          ]);
        }
        this.failPending("connection closed");
        if (this.current.state !== "incompatible") {
          this.setStatus({ ...this.current, state: "disconnected" });
        }
        if (!this.stopped && wasConnected) void this.connectLoop();
      });
    });
  }

  private handle(msg: RunnerToServerMessage, settle: (error?: Error) => void): void {
    switch (msg.type) {
      case "welcome":
        this.onWelcome(msg);
        settle();
        return;
      case "reject":
        this.setStatus({ ...this.current, state: "incompatible", lastError: msg.message });
        settle(new Error(`Runner rejected the connection: ${msg.message}`));
        return;
      case "result": {
        const pending = this.pending.get(msg.id);
        if (!pending) return;
        this.pending.delete(msg.id);
        clearTimeout(pending.timer);
        if (msg.ok) pending.resolve(msg.result);
        else pending.reject(new RunnerCommandError(msg.error.code, msg.error.message));
        return;
      }
      case "event":
        this.onEvent(msg);
        return;
      case "stream":
        this.opts.onStream?.(msg.stream);
        return;
      case "providers":
        // Model lists found after the handshake (discovery, sessions); broadcast to the UI.
        this.setStatus({ ...this.current, providers: msg.providers });
        return;
      case "ping":
        this.send({ type: "pong", id: msg.id });
        return;
      case "pong":
        return;
    }
  }

  private onWelcome(msg: RunnerWelcome): void {
    this.runnerId = msg.runnerId;
    const row = this.opts.db
      .select()
      .from(runnerState)
      .where(eq(runnerState.runnerId, msg.runnerId))
      .get();
    this.lastAckedSeq = row?.lastAckedSeq ?? 0;
    const versionNote =
      msg.runnerVersion === CODEDEN_VERSION
        ? null
        : `Runner version ${msg.runnerVersion} differs from server ${CODEDEN_VERSION}`;
    this.opts.store.append([
      {
        type: "runner.connected",
        sessionId: null,
        payload: {
          ...this.recordRef(),
          runnerId: msg.runnerId,
          version: msg.runnerVersion,
          protocolVersion: msg.protocolVersion,
        },
      },
    ]);
    this.setStatus({
      state: "connected",
      runnerId: msg.runnerId,
      version: msg.runnerVersion,
      providers: msg.providers,
      lastError: versionNote,
    });
    this.send({ type: "resume", lastAckedSeq: this.lastAckedSeq });
    this.afterHandshake(msg);
    const waiters = this.connectedWaiters;
    this.connectedWaiters = [];
    for (const w of waiters) w();
  }

  /**
   * Push runtime config, and on a version mismatch ask the runner to drain and exit
   * (§4.2): it finishes or interrupts running turns, closes sessions (resumable through
   * their resume tokens) and exits; the reconnect loop then starts a current runner.
   */
  private afterHandshake(msg: RunnerWelcome): void {
    const log = this.opts.log;
    const mismatch = msg.runnerVersion !== CODEDEN_VERSION && this.opts.launch !== null;
    const configured = this.opts.mcpUpstreamUrl
      ? this.request({ name: "runner.configure", mcpUpstreamUrl: this.opts.mcpUpstreamUrl })
          .then((r) => {
            this.proxyUrl = r.mcpProxyUrl;
          })
          .catch((error: unknown) => log?.(`runner: configure failed: ${String(error)}`))
      : Promise.resolve();
    if (!mismatch && !msg.draining) {
      void configured.then(() => {
        if (this.runnerId === msg.runnerId && this.current.state === "connected") {
          this.opts.onReady?.(msg.runnerId);
        }
      });
    }
    if (mismatch && !msg.draining) {
      log?.(`runner: version ${msg.runnerVersion} != ${CODEDEN_VERSION}; draining for restart`);
      this.request({
        name: "runner.drain",
        reason: `upgrade to ${CODEDEN_VERSION}`,
        exitWhenDrained: true,
        timeoutMs: this.opts.drainTimeoutMs,
      }).catch((error: unknown) => log?.(`runner: drain failed: ${String(error)}`));
    }
  }

  /** Persist a durable event and its ack position atomically, then ack. */
  private onEvent(msg: RunnerEventMessage): void {
    const runnerId = this.runnerId;
    if (!runnerId) return;
    if (msg.seq > this.lastAckedSeq) {
      try {
        ingestRunnerEvent(this.opts.db, this.opts.store, runnerId, msg, this.opts.recordId);
      } catch (error) {
        // Not acked: the runner keeps it journaled and redelivers it after a reconnect.
        this.opts.log?.(`runner: failed to store event ${msg.seq}: ${String(error)}`);
        return;
      }
      this.lastAckedSeq = msg.seq;
    }
    this.send({ type: "ack", seq: msg.seq });
  }

  private send(msg: ServerToRunnerMessage): void {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg));
  }

  private failPending(reason: string): void {
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(this.unavailable(reason));
      this.pending.delete(id);
    }
  }

  /**
   * `runner_unavailable`: "Runner is not connected" for the home runner, "Runner rn-1 (docker)
   * is not connected" for another one.
   */
  private unavailable(what: string): RunnerCommandError {
    return new RunnerCommandError("runner_unavailable", `${this.opts.name ?? "Runner"} ${what}`);
  }

  /** The record id for this runner's `runner.*` events (none for the home runner's default). */
  private recordRef(): { id?: string } {
    return this.opts.recordId ? { id: this.opts.recordId } : {};
  }

  private setStatus(status: RunnerConnectionStatus): void {
    this.current = status;
    this.opts.onStatus?.(status);
  }
}

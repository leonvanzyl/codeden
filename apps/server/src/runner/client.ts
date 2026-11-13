import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import {
  CODEDEN_VERSION,
  HOME_RUNNER_ID,
  RUNNER_PROTOCOL_VERSION,
  type RunnerCommand,
  type RunnerCommandName,
  type RunnerCommandOf,
  type RunnerCommandResult,
  RunnerCommandResults,
  type RunnerConnectionStatus,
  type RunnerEventMessage,
  type RunnerStream,
  RunnerToServerMessage,
  type RunnerWelcome,
  type ServerToRunnerMessage,
} from "@codeden/contracts";
import { eq } from "drizzle-orm";
import type { Db } from "../db/client";
import { runnerState } from "../db/schema";
import { ingestRunnerEvent } from "../events/ingest";
import type { EventStore } from "../events/store";
import { journalIdRefusal } from "./identity";
import type { RunnerLaunchConfig, RunnerStartTimeouts } from "./launcher";
import { isProcessAlive } from "./lock";
import type { RunnerTransport, RunnerTransportHandlers } from "./transport";
import { type ExecLinkConfig, openExecTransport } from "./transport-exec";
import { findOrStartRunner, openLoopbackTransport } from "./transport-loopback";
import { UntrustedRunnerGuard } from "./untrusted";

export interface RunnerClientOptions {
  /**
   * The runner's record id (`runners.id`), stamped on its `runner.*` events. Omitted: the home
   * runner, as in event logs from before several runners existed.
   */
  recordId?: string;
  /**
   * Names a runner other than the home runner in its errors, e.g. "Runner rn-1 (docker, runner
   * r-1)". Read when an error happens, so it can carry the journal id learned on connecting.
   */
  describe?: () => string;
  /**
   * The runner's messages are untrusted input: every runner but the home runner (a sandbox
   * runner shares its sandbox with an agent that has a shell). Its events and streams count only
   * for sessions routed to it and ptys the server opened on it, and its journal id must be new
   * on its first connection and the same on every later one (`identity.ts`, `untrusted.ts`).
   */
  untrusted?: boolean;
  /**
   * Reach the runner through an exec link (`codeden runner-link` next to it, `docs/remote-runners.md`
   * §6). Without one, the `loopback` transport finds it through `lockFile` (and `launch`).
   */
  link?: ExecLinkConfig;
  /** The runner's data directory (loopback: where a started runner lives and logs). */
  home: string;
  /** Loopback: the runner's lock file. */
  lockFile: string;
  db: Db;
  store: EventStore;
  /** Loopback: how to start a runner when none is live; `null` only attaches to one. */
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
   * No command gives up sooner than this, whatever deadline its caller set (tests on a busy
   * machine, where the runner answers slowly). Default: each command's own deadline.
   */
  requestTimeoutFloorMs?: number;
  /**
   * Called once a current, non-draining runner is connected and configured (MCP proxy set),
   * e.g. to resume sessions interrupted by a runner restart.
   */
  onReady?: (runnerId: string) => void;
}

/** Where a runner runs, as its `welcome` reported it (each part absent from older runners). */
export type RunnerHostInfo = Pick<RunnerWelcome, "platform" | "arch" | "home" | "backend">;

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
/** Wait `ms`, or less when `signal` aborts first. */
const pause = (ms: number, signal: AbortSignal) =>
  delay(ms, undefined, { signal }).catch(() => undefined);

/**
 * Server side of the runner protocol (§4.3): reaches the runner over a `RunnerTransport`
 * (finding or starting a local one through its lock file, or opening an exec link), handshakes,
 * persists durable events (acking by seq after commit) and reconnects, resuming by seq.
 */
export class RunnerClient {
  private transport: RunnerTransport | undefined;
  private stopped = false;
  /** Aborted by `stop()`: cancels the connection attempt in flight (probe, start, handshake). */
  private abort = new AbortController();
  /** The connection attempt in flight, if any; `stop()` waits for it to settle. */
  private attempt: Promise<void> | undefined;
  private reconnectDelay = 250;
  private readonly pending = new Map<string, Pending>();
  private connectedWaiters: Array<() => void> = [];
  private runnerId: string | undefined;
  private lastAckedSeq = 0;
  private proxyUrl: string | null = null;
  private runnerPid: number | undefined;
  private where: RunnerHostInfo | null = null;
  private current: RunnerConnectionStatus = {
    state: "starting",
    runnerId: null,
    version: null,
    providers: [],
    lastError: null,
  };

  /** What an untrusted runner may send beyond its sessions' events; none for the home runner. */
  private readonly guard: UntrustedRunnerGuard | undefined;

  constructor(private readonly opts: RunnerClientOptions) {
    this.guard = opts.untrusted ? new UntrustedRunnerGuard(opts.db) : undefined;
  }

  get status(): RunnerConnectionStatus {
    return this.current;
  }

  /** Agent-facing MCP proxy URL on the runner, once configured. */
  get mcpProxyUrl(): string | null {
    return this.proxyUrl;
  }

  /** Where the runner runs, from its last `welcome`; null before one (or from older runners). */
  get hostInfo(): RunnerHostInfo | null {
    return this.where;
  }

  /** The current exec link process's pid, when the link is a local child process. */
  get linkPid(): number | undefined {
    return this.transport?.linkPid;
  }

  /**
   * Ensure a runner is live and connect. Resolves once the handshake completed; rejects with
   * `runner_unavailable` when `stop()` comes first.
   */
  async start(): Promise<void> {
    this.stopped = false;
    this.abort = new AbortController();
    await this.connectLoop();
    if (this.current.state !== "connected") throw this.unavailable("was stopped while connecting");
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
    const transport = this.transport;
    if (!transport || this.current.state !== "connected") {
      throw this.unavailable("is not connected");
    }
    const id = randomUUID();
    const deadlineMs = Math.max(timeoutMs, this.opts.requestTimeoutFloorMs ?? 0);
    const result = new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new RunnerCommandError("timeout", `Runner command ${command.name} timed out`));
      }, deadlineMs);
      this.pending.set(id, { name: command.name, resolve, reject, timer });
    });
    this.guard?.sending(command as RunnerCommand);
    try {
      transport.send({ type: "command", id, command: command as RunnerCommand });
    } catch (error) {
      // Too large for the link: fail now rather than at the timeout.
      const pending = this.pending.get(id);
      this.pending.delete(id);
      if (pending) clearTimeout(pending.timer);
      pending?.reject(new RunnerCommandError("too_large", (error as Error).message));
    }
    const raw = await result;
    return RunnerCommandResults[command.name as N].parse(raw) as RunnerCommandResult<N>;
  }

  /**
   * Disconnect without stopping the runner (it keeps agents alive across server restarts). A
   * connection attempt in flight is cancelled and awaited, so once this resolves the client
   * never connects, records `runner.connected` or answers commands again.
   */
  async stop(): Promise<void> {
    this.stopped = true;
    this.abort.abort();
    const transport = this.transport;
    this.transport = undefined;
    await transport?.close("server stopping");
    await this.attempt;
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

  /** Connect, retrying until connected or stopped; the running attempt is kept for `stop()`. */
  private connectLoop(): Promise<void> {
    this.attempt = this.runConnectLoop(this.abort.signal);
    return this.attempt;
  }

  private async runConnectLoop(signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      try {
        await this.connect(signal);
        this.reconnectDelay = 250;
        return; // `onClosed` restarts the loop.
      } catch (error) {
        if (signal.aborted) return; // stopped: whatever failed was cancelled
        const message = error instanceof Error ? error.message : String(error);
        this.setStatus({ ...this.current, state: "disconnected", lastError: message });
        this.opts.log?.(`runner: ${message}; retrying in ${this.reconnectDelay}ms`);
        await pause(this.reconnectDelay, signal);
        this.reconnectDelay = Math.min(this.reconnectDelay * 2, 5_000);
      }
    }
  }

  /**
   * Open a transport (finding or starting a local runner first), handshake, resume. `signal`
   * (`stop()`) cancels the attempt at any point: the probe, the start, opening the transport or
   * the handshake, which then drops the transport.
   */
  private async connect(signal: AbortSignal): Promise<void> {
    signal.throwIfAborted();
    let settle: (error?: Error) => void = () => undefined;
    const handshake = new Promise<void>((resolve, reject) => {
      let settled = false;
      settle = (error) => {
        if (settled) return;
        settled = true;
        signal.removeEventListener("abort", cancel);
        if (error) reject(error);
        else resolve();
      };
    });
    handshake.catch(() => undefined); // awaited below; may settle before that
    // A transport let go after a failed handshake: its end changes nothing any more.
    let abandoned = false;
    let transport: RunnerTransport | undefined;
    // `stop()` during the handshake drops the transport; once connected it closes cleanly.
    const cancel = () => {
      settle(new Error("Runner connection cancelled"));
    };
    // Whether this connection's `welcome` was accepted: events count only after it.
    let welcomed = false;
    const handlers: RunnerTransportHandlers = {
      onMessage: (raw) => {
        try {
          const msg = RunnerToServerMessage.parse(raw);
          if (msg.type === "welcome") {
            // A handshake that completes after `stop()` is discarded, never recorded as
            // connected; a failed handshake closes the transport (below).
            if (signal.aborted) return void settle(new Error("stopped"));
            if (welcomed) return; // one handshake per connection
            // Refused: the connect loop shows the reason as the last error and retries.
            const refused = this.welcomeRefusal(msg);
            if (refused) return void settle(new Error(refused));
            welcomed = true;
          } else if ((msg.type === "event" || msg.type === "stream") && !welcomed) {
            return;
          }
          this.handle(msg, settle);
        } catch (error) {
          this.opts.log?.(`runner: bad message: ${(error as Error).message}`);
        }
      },
      onClose: (detail) => {
        settle(new Error(detail ?? "Runner connection closed during handshake"));
        if (!abandoned) this.onClosed(transport, detail);
      },
      log: this.opts.log,
    };
    transport = await this.openTransport(handlers, signal);
    this.transport = transport;
    signal.addEventListener("abort", cancel, { once: true });
    if (signal.aborted) cancel();
    this.send({
      type: "hello",
      protocolVersion: RUNNER_PROTOCOL_VERSION,
      serverVersion: CODEDEN_VERSION,
    });
    try {
      await handshake;
    } catch (error) {
      // Rejected, stopped, or the link ended before `welcome`: leave no socket or process behind.
      abandoned = true;
      if (this.transport === transport) this.transport = undefined;
      void transport.close("handshake failed");
      throw error;
    }
  }

  private async openTransport(
    handlers: RunnerTransportHandlers,
    signal: AbortSignal,
  ): Promise<RunnerTransport> {
    const link = this.opts.link;
    if (link) return openExecTransport(link, handlers);
    const lock = await findOrStartRunner({
      home: this.opts.home,
      lockFile: this.opts.lockFile,
      launch: this.opts.launch,
      startTimeouts: this.opts.startTimeouts,
      signal,
      log: this.opts.log,
      onStarting: () => {
        // A retry after a failed start keeps showing why the previous attempt failed.
        const previous = this.current.state === "disconnected" ? this.current.lastError : null;
        this.setStatus({ ...this.current, state: "starting", lastError: previous });
      },
      onSlow: () => {
        const lastError = "The runner is taking longer than usual to start";
        this.setStatus({ ...this.current, state: "starting", lastError });
      },
    });
    this.runnerPid = lock.pid;
    return openLoopbackTransport(lock, handlers);
  }

  /** A transport that completed its handshake (or was mid-handshake) ended. */
  private onClosed(transport: RunnerTransport | undefined, detail: string | undefined): void {
    // A transport a newer one replaced changes nothing (`stop` clears it before closing).
    if (this.transport !== undefined && this.transport !== transport) return;
    const wasConnected = this.current.state === "connected";
    this.transport = undefined;
    if (wasConnected && this.runnerId) {
      this.opts.store.append([
        {
          type: "runner.disconnected",
          sessionId: null,
          payload: {
            ...this.recordRef(),
            runnerId: this.runnerId,
            reason: this.opts.link && detail ? detail : "connection closed",
          },
        },
      ]);
    }
    this.failPending("connection closed");
    if (this.current.state !== "incompatible") {
      this.setStatus({ ...this.current, state: "disconnected" });
    }
    if (!this.stopped && wasConnected) void this.connectLoop();
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
        // An untrusted runner's stream for a pty or session that isn't its own is dropped.
        if (this.guard && !this.guard.allowsStream(msg.stream, this.runnerId)) return;
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

  /** Why this runner's `welcome` is refused (its journal id isn't its own), or `null`. */
  private welcomeRefusal(msg: RunnerWelcome): string | null {
    const recordId = this.opts.recordId ?? HOME_RUNNER_ID;
    const reason = journalIdRefusal(this.opts.db, recordId, msg.runnerId, !!this.opts.untrusted);
    if (!reason) return null;
    const name = this.opts.describe?.() ?? "Runner";
    return `${name} was refused: ${reason}`;
  }

  private onWelcome(msg: RunnerWelcome): void {
    this.runnerId = msg.runnerId;
    const { platform, arch, home, backend } = msg;
    this.where = platform || arch || home || backend ? { platform, arch, home, backend } : null;
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
        const guard = this.guard;
        const { refused } = ingestRunnerEvent(this.opts.db, this.opts.store, runnerId, msg, {
          recordId: this.opts.recordId,
          untrusted: !!guard,
          ownsPty: guard && ((ptyId) => guard.ownsPty(ptyId)),
        });
        // Acked like any other, so the runner stops redelivering it, but never stored.
        if (refused) {
          this.opts.log?.(`runner: dropped event ${msg.seq} (${msg.event.kind}): ${refused}`);
        } else if (msg.event.kind === "pty.exited") {
          guard?.ptyExited(msg.event.ptyId);
        }
      } catch (error) {
        // Not acked: the runner keeps it journaled and redelivers it after a reconnect.
        this.opts.log?.(`runner: failed to store event ${msg.seq}: ${String(error)}`);
        return;
      }
      this.lastAckedSeq = msg.seq;
    }
    this.send({ type: "ack", seq: msg.seq });
  }

  /** Protocol housekeeping (hello, resume, acks, pongs): small, and dropped when closed. */
  private send(msg: ServerToRunnerMessage): void {
    try {
      this.transport?.send(msg);
    } catch (error) {
      this.opts.log?.(`runner: ${(error as Error).message}`);
    }
  }

  private failPending(reason: string): void {
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(this.unavailable(reason));
      this.pending.delete(id);
    }
  }

  /**
   * `runner_unavailable`: "Runner is not connected" for the home runner, "Runner rn-1 (docker,
   * runner r-1) is not connected" for another one.
   */
  private unavailable(what: string): RunnerCommandError {
    const name = this.opts.describe?.() ?? "Runner";
    return new RunnerCommandError("runner_unavailable", `${name} ${what}`);
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

import { type ChildProcess, fork } from "node:child_process";
import { mkdirSync, openSync, renameSync, statSync } from "node:fs";
import { dirname } from "node:path";

/** The server log is moved aside to `<file>.1` (one copy kept) when it grows past this. */
const LOG_LIMIT_BYTES = 5 * 1024 * 1024;

/**
 * Keep the server log from growing without bound: past `limit` it becomes `<file>.1`
 * (replacing an older one) and a fresh file starts. Never throws.
 */
export function rotateLog(file: string, limit = LOG_LIMIT_BYTES): void {
  try {
    if (statSync(file).size > limit) renameSync(file, `${file}.1`);
  } catch {
    // No log yet, or it is in use: append to it as it is.
  }
}

import {
  type DesktopHostMessage,
  DesktopServerMessage,
  type DesktopUpdateCommand,
} from "@codeden/contracts";
import { loginShellPath } from "./login-shell-path";

export interface ServerReady {
  url: string;
  port: number;
  launchUrl: string;
  version: string;
}

export class ServerStartError extends Error {
  constructor(
    message: string,
    readonly code: string | null,
  ) {
    super(message);
  }
}

export interface ServerProcessOptions {
  /** `dist/server.js`. */
  entry: string;
  home: string;
  port: number;
  fake: boolean;
  /** Server output goes here (`<home>/logs/desktop-server.log`). */
  logFile: string;
  /** The server asks the updater to do something; answer with `send({ type: "update.done" })`. */
  onUpdateCommand: (id: string, command: DesktopUpdateCommand) => void;
  /** The process exited without being asked to (crash, or `codeden stop` from a terminal). */
  onUnexpectedExit: (code: number | null) => void;
  log: (message: string) => void;
}

/**
 * The server the app starts (§17): `dist/server.js` forked on the app's own binary as Node.js
 * (Electron's `fork` sets `ELECTRON_RUN_AS_NODE` and, on macOS, uses the helper binary so no
 * second dock icon appears). It is a normal child: when the app goes away it closes, while
 * the detached runner it started keeps the agents running.
 */
export class ServerProcess {
  private child: ChildProcess | undefined;
  private stopping = false;

  constructor(private readonly opts: ServerProcessOptions) {}

  get pid(): number | undefined {
    return this.child?.pid;
  }

  async start(): Promise<ServerReady> {
    // A Dock or Finder launch has launchd's minimal PATH: hand the server the login shell's.
    const loginPath = await loginShellPath();
    mkdirSync(dirname(this.opts.logFile), { recursive: true });
    rotateLog(this.opts.logFile);
    const out = openSync(this.opts.logFile, "a");
    const args = ["--home", this.opts.home, "--port", String(this.opts.port)];
    if (this.opts.fake) args.push("--fake");
    const child = fork(this.opts.entry, args, {
      stdio: ["ignore", out, out, "ipc"],
      env: {
        ...process.env,
        ...(loginPath ? { PATH: loginPath } : {}),
        CODEDEN_DEPS_INSTALLER: "registry",
      },
      windowsHide: true,
    });
    this.child = child;
    this.opts.log(`server: started pid ${child.pid} (port ${this.opts.port})`);

    return new Promise<ServerReady>((resolve, reject) => {
      let settled = false;
      child.on("message", (raw) => {
        const parsed = DesktopServerMessage.safeParse(raw);
        if (!parsed.success) return;
        const message = parsed.data;
        if (message.type === "ready" && !settled) {
          settled = true;
          resolve(message);
        } else if (message.type === "failed" && !settled) {
          settled = true;
          reject(new ServerStartError(message.message, message.code));
        } else if (message.type === "update.command") {
          this.opts.onUpdateCommand(message.id, message.command);
        }
      });
      child.once("exit", (code) => {
        this.opts.log(`server: exited (code ${code})`);
        this.child = undefined;
        if (!settled) {
          settled = true;
          reject(new ServerStartError(`The server exited (code ${code}) before it started`, null));
          return;
        }
        if (!this.stopping) this.opts.onUnexpectedExit(code);
      });
    });
  }

  send(message: DesktopHostMessage): void {
    if (this.child?.connected) this.child.send(message);
  }

  /**
   * Close the server; with `stopRunner` the runner drains and exits too (as `codeden stop`),
   * so an update can replace the files it runs from. A server that doesn't exit in time gets
   * SIGTERM (which ends a stuck close), then SIGKILL, so quitting the app never hangs on it.
   */
  async stop(opts: { stopRunner: boolean; timeoutMs?: number; graceMs?: number }): Promise<void> {
    const child = this.child;
    if (!child) return;
    this.stopping = true;
    const grace = opts.graceMs ?? KILL_GRACE_MS;
    const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
    this.send({ type: "shutdown", stopRunner: opts.stopRunner });
    if (await settlesWithin(exited, opts.timeoutMs ?? 20_000)) return;
    this.opts.log("server: did not exit in time; stopping it");
    child.kill();
    if (await settlesWithin(exited, grace)) return;
    this.opts.log("server: still running; killing it");
    child.kill("SIGKILL");
    if (!(await settlesWithin(exited, grace))) this.opts.log("server: did not exit after SIGKILL");
  }
}

/** How long a server gets after SIGTERM, and again after SIGKILL. */
const KILL_GRACE_MS = 5_000;

/** True when `promise` settles within `ms`; never waits longer. */
async function settlesWithin(promise: Promise<void>, ms: number): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<false>((resolve) => {
    timer = setTimeout(() => resolve(false), ms);
    timer.unref();
  });
  try {
    return await Promise.race([promise.then(() => true as const), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

import type { ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createInterface } from "node:readline";
import { killTree, type ResolvedCommand, spawnResolved } from "../util/exec";
import { OpenCodeClient } from "./client";
import { HIDDEN_ENV_VARS } from "./plugin";

/** How long `opencode serve` may take to print its URL. It usually takes 200-400 ms. */
export const OPENCODE_START_TIMEOUT_MS = 20_000;

export interface OpenCodeServerOptions {
  /** The server's working directory (sessions still name their own directory). */
  cwd: string;
  /** Extra environment for the server and the agent's commands. */
  env?: Record<string, string>;
  /** Inline config (`OPENCODE_CONFIG_CONTENT`), layered over the user's own config. */
  config?: Record<string, unknown>;
  /** Aborting stops the server at any point, including start-up. */
  signal?: AbortSignal;
  startTimeoutMs?: number;
  /** Timeout of each HTTP request (prompts return as soon as they are queued). */
  requestTimeoutMs?: number;
}

/**
 * One private `opencode serve --stdio` (§7.2). It listens on a random 127.0.0.1 port with a
 * per-process password, prints `{"url": ...}` on stdout, and exits when its stdin closes, so it
 * never outlives the runner, even when the runner is killed.
 */
export class OpenCodeServer {
  private exitedFlag = false;
  private stderrTail = "";
  private readonly exitListeners = new Set<(code: number | null, stderrTail: string) => void>();

  private constructor(
    private readonly child: ChildProcess,
    readonly url: string,
    readonly client: OpenCodeClient,
  ) {
    child.stderr?.setEncoding("utf8").on("data", (d: string) => {
      this.stderrTail = (this.stderrTail + d).slice(-4000);
    });
    child.on("exit", (code) => this.handleExit(code));
    child.on("error", (error) => {
      this.stderrTail += `\n${error.message}`;
      this.handleExit(null);
    });
  }

  /** Spawn the server and wait for its URL. Rejects (and stops the process) on failure. */
  static async start(exe: ResolvedCommand, opts: OpenCodeServerOptions): Promise<OpenCodeServer> {
    const password = randomBytes(24).toString("base64url");
    const child = spawnResolved(
      exe,
      ["serve", "--stdio", "--hostname", "127.0.0.1", "--port", "0"],
      {
        cwd: opts.cwd,
        env: openCodeServerEnv(process.env, opts.env, password, opts.config ?? {}),
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
    child.stdin?.on("error", () => {});
    try {
      const url = await readUrl(
        child,
        opts.startTimeoutMs ?? OPENCODE_START_TIMEOUT_MS,
        opts.signal,
      );
      const server = new OpenCodeServer(
        child,
        url,
        new OpenCodeClient(url, password, opts.requestTimeoutMs),
      );
      opts.signal?.addEventListener("abort", () => void server.close(), { once: true });
      return server;
    } catch (error) {
      stop(child);
      throw error;
    }
  }

  get exited(): boolean {
    return this.exitedFlag;
  }

  get pid(): number | undefined {
    return this.child.pid;
  }

  /** Called once when the process exits (crash or `close()`). Returns unsubscribe. */
  onExit(listener: (code: number | null, stderrTail: string) => void): () => void {
    this.exitListeners.add(listener);
    return () => this.exitListeners.delete(listener);
  }

  /**
   * Stop the server: close stdin (it exits within ~50 ms), then kill the process tree (the
   * user's MCP servers run as its children) if it lingers. Resolves once it has exited.
   */
  close(): Promise<void> {
    if (this.exitedFlag) return Promise.resolve();
    return stop(this.child);
  }

  private handleExit(code: number | null): void {
    if (this.exitedFlag) return;
    this.exitedFlag = true;
    for (const listener of this.exitListeners) {
      try {
        listener(code, this.stderrTail);
      } catch {
        // One failing listener must not stop the others.
      }
    }
  }
}

function stop(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  const exited = new Promise<void>((resolve) => {
    child.once("exit", () => resolve());
    setTimeout(resolve, 5000).unref();
  });
  try {
    child.stdin?.end();
  } catch {
    // ignore
  }
  setTimeout(() => {
    if (child.exitCode === null && child.signalCode === null) killTree(child);
  }, 1500).unref();
  return exited;
}

function readUrl(child: ChildProcess, timeoutMs: number, signal?: AbortSignal): Promise<string> {
  return new Promise((resolve, reject) => {
    let stderr = "";
    const lines = child.stdout ? createInterface({ input: child.stdout }) : undefined;
    const done = (error?: Error, url?: string) => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      lines?.removeAllListeners("line");
      if (error) reject(error);
      else resolve(url as string);
    };
    const onAbort = () => done(new Error("Aborted while starting OpenCode"));
    const timer = setTimeout(
      () => done(new Error(`opencode serve did not start within ${timeoutMs}ms${tail(stderr)}`)),
      timeoutMs,
    );
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) onAbort();
    child.stderr?.setEncoding("utf8").on("data", (d: string) => {
      stderr = (stderr + d).slice(-2000);
    });
    child.once("error", (error) => done(new Error(`Could not start opencode: ${error.message}`)));
    child.once("exit", (code) =>
      done(
        new Error(
          `opencode serve exited during start-up (code ${code ?? "unknown"})${tail(stderr)}`,
        ),
      ),
    );
    lines?.on("line", (line) => {
      try {
        const url = (JSON.parse(line) as { url?: unknown }).url;
        if (typeof url === "string" && /^http:\/\/127\.0\.0\.1:\d+$/.test(url.replace(/\/$/, ""))) {
          done(undefined, url.replace(/\/$/, ""));
        }
      } catch {
        // Not the URL line; keep waiting.
      }
    });
  });
}

const tail = (stderr: string) => (stderr.trim() ? `: ${stderr.trim().slice(-500)}` : "");

/**
 * The server's environment: the runner's, the session's extras, the password and the inline
 * config. `ELECTRON_RUN_AS_NODE` and any inherited OpenCode secrets are dropped (Windows env
 * names are case-insensitive, so matching ignores case). A user's own
 * `OPENCODE_CONFIG_CONTENT` is kept underneath CodeDen's.
 */
export function openCodeServerEnv(
  base: NodeJS.ProcessEnv,
  extra: Record<string, string> | undefined,
  password: string,
  config: Record<string, unknown>,
): NodeJS.ProcessEnv {
  const drop = new Set(["ELECTRON_RUN_AS_NODE", ...HIDDEN_ENV_VARS]);
  const env: NodeJS.ProcessEnv = {};
  let userConfig: string | undefined;
  for (const [key, value] of Object.entries({ ...base, ...extra })) {
    const upper = key.toUpperCase();
    if (upper === "OPENCODE_CONFIG_CONTENT") userConfig = value;
    if (!drop.has(upper)) env[key] = value;
  }
  env.OPENCODE_PASSWORD = password;
  env.OPENCODE_CONFIG_CONTENT = JSON.stringify(mergeConfig(parseConfig(userConfig), config));
  return env;
}

function parseConfig(text: string | undefined): Record<string, unknown> {
  if (!text) return {};
  try {
    const value = JSON.parse(text) as unknown;
    return value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === "object" && !Array.isArray(v);

/** Deep-merge `over` onto `base`: objects merge, `plugins` arrays concatenate, the rest wins. */
export function mergeConfig(
  base: Record<string, unknown>,
  over: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(over)) {
    const prev = out[key];
    if (key === "plugins" && Array.isArray(prev) && Array.isArray(value))
      out[key] = [...prev, ...value];
    else if (isRecord(prev) && isRecord(value)) out[key] = mergeConfig(prev, value);
    else out[key] = value;
  }
  return out;
}

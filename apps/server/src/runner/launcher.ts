import { type ChildProcess, spawn } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, readSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import type { RunnerLock } from "@codeden/contracts";
import { ownNodeEnv } from "@codeden/providers";
import { isProcessAlive, readLiveRunnerLock } from "./lock";

/** How to start the runner process. */
export interface RunnerLaunchConfig {
  command: string;
  args: string[];
  /** Extra environment for the runner. */
  env?: Record<string, string>;
}

/**
 * How long to wait for a spawned runner. A runner that is still alive is never killed for being
 * slow (antivirus scans, a cold disk and a loaded machine can each take longer than a minute);
 * only `timeoutMs`, a generous upper bound for a runner that hangs, ends the wait.
 */
export interface RunnerStartTimeouts {
  /** After this long the start counts as slow: logged once, and the wait goes on. Default 20 s. */
  slowAfterMs?: number;
  /** Give up, stop the runner and report it as hung. Default 5 minutes. */
  timeoutMs?: number;
}

export const DEFAULT_RUNNER_SLOW_AFTER_MS = 20_000;
export const DEFAULT_RUNNER_START_TIMEOUT_MS = 5 * 60_000;

/**
 * Work out how to launch the runner when the caller didn't say:
 * - a bundle ships `runner.js` next to the server code;
 * - in the monorepo, run `apps/runner/src/main.ts` through tsx.
 */
export function defaultRunnerLaunch(extraArgs: string[] = []): RunnerLaunchConfig | undefined {
  const here = import.meta.dirname;
  const bundled = resolve(here, "runner.js");
  if (existsSync(bundled)) return { command: process.execPath, args: [bundled, ...extraArgs] };
  const source = resolve(here, "../../../runner/src/main.ts");
  if (existsSync(source)) {
    const tsx = import.meta.resolve("tsx");
    return { command: process.execPath, args: ["--import", tsx, source, ...extraArgs] };
  }
  return undefined;
}

const runnerLogPath = (home: string) => join(home, "logs", "runner.log");

function spawnRunnerChild(config: RunnerLaunchConfig, home: string): ChildProcess {
  mkdirSync(join(home, "logs"), { recursive: true });
  const log = openSync(runnerLogPath(home), "a");
  const env = { ...process.env, ...config.env, CODEDEN_HOME: home };
  try {
    const child = spawn(config.command, [...config.args, "--home", home], {
      detached: true,
      stdio: ["ignore", log, log],
      windowsHide: true,
      cwd: home,
      // In the desktop app `process.execPath` is the Electron binary: run it as Node.js (§17).
      env: config.command === process.execPath ? ownNodeEnv(env) : env,
    });
    // A failed spawn (missing command) is reported through `exit` below, never thrown later.
    child.on("error", () => undefined);
    child.unref();
    return child;
  } finally {
    closeSync(log); // the child has its own handle
  }
}

/**
 * Start the runner as a detached process that outlives the server (§4.2).
 * Output goes to `<home>/logs/runner.log`.
 */
export function spawnRunner(config: RunnerLaunchConfig, home: string): number | undefined {
  return spawnRunnerChild(config, home).pid;
}

/** The end of what the runner wrote to its log since `offset`: the last lines, at most 2 KB. */
export function runnerLogTail(home: string, offset = 0, maxBytes = 2048): string {
  const file = runnerLogPath(home);
  try {
    const size = statSync(file).size;
    const start = Math.max(offset, size - maxBytes);
    if (size <= start) return "";
    const buffer = Buffer.alloc(size - start);
    const fd = openSync(file, "r");
    try {
      readSync(fd, buffer, 0, buffer.length, start);
    } finally {
      closeSync(fd);
    }
    const lines = buffer.toString("utf8").split(/\r?\n/);
    if (start > offset) lines.shift(); // a partial first line
    return lines
      .filter((line) => line.trim() !== "")
      .slice(-15)
      .join("\n");
  } catch {
    return "";
  }
}

function logSize(home: string): number {
  try {
    return statSync(runnerLogPath(home)).size;
  } catch {
    return 0;
  }
}

/** True when `lock` belongs to the runner we spawned (or, without a pid, is not the stale one). */
function isFreshLock(
  lock: RunnerLock,
  spawnedPid: number | undefined,
  stale?: RunnerLock,
): boolean {
  if (spawnedPid !== undefined) return lock.pid === spawnedPid;
  return !stale || lock.pid !== stale.pid || lock.startedAt !== stale.startedAt;
}

const withTail = (message: string, tail: string) =>
  tail ? `${message}. The end of logs/runner.log:\n${tail}` : `${message} (see logs/runner.log)`;

/**
 * Spawn a runner and wait for the lock file it writes. Only the lock of the runner just
 * spawned is accepted: a stale lock whose pid happens to be alive would otherwise be returned
 * at once, fail to connect, and the retry would spawn a second runner that is never stopped.
 *
 * A runner that exits before writing its lock fails at once, with the end of its log. One that
 * is alive but slow is waited for (`onSlow` is called once after `slowAfterMs`); only after
 * `timeoutMs` is it stopped, so the caller never starts a second runner beside a slow one.
 */
export async function startRunnerProcess(opts: {
  launch: RunnerLaunchConfig;
  home: string;
  lockFile: string;
  stale?: RunnerLock;
  timeouts?: RunnerStartTimeouts;
  /** Stop waiting (the client stopped); the runner keeps starting and is attached to later. */
  signal?: AbortSignal;
  onSlow?: (info: { pid: number | undefined; elapsedMs: number }) => void;
}): Promise<RunnerLock> {
  const slowAfterMs = opts.timeouts?.slowAfterMs ?? DEFAULT_RUNNER_SLOW_AFTER_MS;
  const timeoutMs = opts.timeouts?.timeoutMs ?? DEFAULT_RUNNER_START_TIMEOUT_MS;
  const offset = logSize(opts.home);
  const child = spawnRunnerChild(opts.launch, opts.home);
  const pid = child.pid;
  let exitCode: number | string | null | undefined;
  const exitEvent = new Promise<void>((resolve) => {
    child.once("exit", (code, signal) => {
      exitCode = code ?? signal ?? null;
      resolve();
    });
  });
  const started = Date.now();
  let slowReported = false;
  for (;;) {
    await new Promise((r) => setTimeout(r, 100));
    opts.signal?.throwIfAborted();
    const lock = readLiveRunnerLock(opts.lockFile);
    if (lock && isFreshLock(lock, pid, opts.stale)) return lock;
    const exited = pid === undefined || exitCode !== undefined || !isProcessAlive(pid);
    if (exited) {
      // A busy machine can report the process gone before its `exit` event arrives: wait for
      // the event a moment, so the message says how the runner ended.
      if (pid !== undefined && exitCode === undefined) {
        await Promise.race([exitEvent, new Promise((r) => setTimeout(r, 1_000).unref())]);
      }
      const how = exitCode === undefined || exitCode === null ? "" : ` (exit ${exitCode})`;
      const what = pid === undefined ? "The runner process could not be started" : "";
      throw new Error(
        withTail(
          what || `The runner exited during start-up${how}`,
          runnerLogTail(opts.home, offset),
        ),
      );
    }
    const elapsedMs = Date.now() - started;
    if (!slowReported && elapsedMs >= slowAfterMs) {
      slowReported = true;
      opts.onSlow?.({ pid, elapsedMs });
    }
    if (elapsedMs >= timeoutMs) break;
  }
  try {
    if (pid !== undefined) process.kill(pid);
  } catch {
    // already gone
  }
  const seconds = Math.round(timeoutMs / 1000);
  throw new Error(
    withTail(`The runner did not start within ${seconds} s`, runnerLogTail(opts.home, offset)),
  );
}

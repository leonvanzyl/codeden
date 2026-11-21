import { join } from "node:path";
import type { RunnerLock } from "@codeden/contracts";
import { installedClaudeSdkVersion } from "@codeden/providers";
import WebSocket from "ws";
import { type RunnerLaunchConfig, type RunnerStartTimeouts, startRunnerProcess } from "./launcher";
import { probeRunnerLock, readLiveRunnerLock } from "./lock";
import type { RunnerTransport, RunnerTransportHandlers } from "./transport";

export interface FindRunnerOptions {
  home: string;
  lockFile: string;
  /** How to start a runner when none is live; `null` only attaches to an existing one. */
  launch: RunnerLaunchConfig | null;
  startTimeouts?: RunnerStartTimeouts;
  /** Cancels the probe and the start (the client's `stop()`). */
  signal?: AbortSignal;
  log?: (message: string) => void;
  /** About to start a runner process. */
  onStarting: () => void;
  /** A started runner is taking longer than usual. */
  onSlow: () => void;
  /**
   * When set, an existing live runner whose `<home>/deps` holds a different Claude Agent SDK
   * version is treated as stale and replaced. Guards against reconnecting to a runner that
   * started before a `claude update` or a manual SDK upgrade in `~/.codeden/deps`.
   */
  requiredSdkVersion?: string;
}

/**
 * The live runner in `lockFile`, or a newly started one (§4.2): a lock whose pid is alive and
 * that answers `/health` with its token is used as is; otherwise a runner is started.
 */
export async function findOrStartRunner(opts: FindRunnerOptions): Promise<RunnerLock> {
  const existing = readLiveRunnerLock(opts.lockFile);
  if (existing && (await probeRunnerLock(existing, undefined, opts.signal))) {
    if (opts.requiredSdkVersion) {
      const installed = installedClaudeSdkVersion(join(opts.home, "deps"));
      if (installed !== opts.requiredSdkVersion) {
        opts.log?.(
          `runner: SDK in deps changed (${installed ?? "none"} → ${opts.requiredSdkVersion}); restarting runner to pick up the new version`,
        );
      } else {
        return existing;
      }
    } else {
      return existing;
    }
  }
  opts.signal?.throwIfAborted();
  if (existing) {
    opts.log?.(`runner: pid ${existing.pid} does not answer; starting a new runner`);
  }
  if (!opts.launch) throw new Error("No live runner and launching is disabled");
  opts.log?.("runner: starting a new runner process");
  opts.onStarting();
  return startRunnerProcess({
    launch: opts.launch,
    home: opts.home,
    lockFile: opts.lockFile,
    stale: existing,
    timeouts: opts.startTimeouts,
    signal: opts.signal,
    onSlow: ({ pid, elapsedMs }) => {
      const s = Math.round(elapsedMs / 1000);
      opts.log?.(`runner: pid ${pid} is still starting after ${s} s; waiting for it`);
      opts.onSlow();
    },
  });
}

/**
 * The `loopback` transport: the runner's WebSocket on `127.0.0.1`, authenticated with the
 * token from its lock file. Resolves once the socket is open; rejects if it fails before, or
 * when `signal` aborts first, which drops the socket at once, even while the runner has not
 * answered the upgrade yet (the client's `stop()` never waits on a hung runner).
 */
export function openLoopbackTransport(
  lock: RunnerLock,
  handlers: RunnerTransportHandlers,
  signal?: AbortSignal,
): Promise<RunnerTransport> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new Error("Runner connection cancelled"));
    const ws = new WebSocket(`ws://127.0.0.1:${lock.port}/runner`, {
      headers: { authorization: `Bearer ${lock.token}` },
    });
    let opened = false;
    let lastError: Error | undefined;
    const cancel = () => {
      reject(new Error("Runner connection cancelled"));
      ws.terminate();
    };
    signal?.addEventListener("abort", cancel, { once: true });
    const transport: RunnerTransport = {
      send: (message) => {
        if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(message));
      },
      close: (reason = "server stopping") => {
        if (ws.readyState !== WebSocket.OPEN) return Promise.resolve();
        return new Promise<void>((done) => {
          ws.once("close", () => done());
          ws.close(1000, reason);
          setTimeout(done, 1000).unref();
        });
      },
    };
    ws.on("open", () => {
      // Once open, the client's own abort handling closes it.
      signal?.removeEventListener("abort", cancel);
      opened = true;
      resolve(transport);
    });
    ws.on("message", (data) => {
      let message: unknown;
      try {
        message = JSON.parse(data.toString());
      } catch (error) {
        handlers.log?.(`runner: bad message: ${(error as Error).message}`);
        return;
      }
      handlers.onMessage(message);
    });
    ws.on("error", (error) => {
      lastError = error;
      if (opened) return;
      signal?.removeEventListener("abort", cancel);
      reject(error);
    });
    ws.on("close", () => {
      if (opened) handlers.onClose(lastError?.message);
    });
  });
}

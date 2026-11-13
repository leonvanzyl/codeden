import type { RunnerLock } from "@codeden/contracts";
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
}

/**
 * The live runner in `lockFile`, or a newly started one (§4.2): a lock whose pid is alive and
 * that answers `/health` with its token is used as is; otherwise a runner is started.
 */
export async function findOrStartRunner(opts: FindRunnerOptions): Promise<RunnerLock> {
  const existing = readLiveRunnerLock(opts.lockFile);
  if (existing && (await probeRunnerLock(existing, undefined, opts.signal))) return existing;
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
 * token from its lock file. Resolves once the socket is open; rejects if it fails before.
 */
export function openLoopbackTransport(
  lock: RunnerLock,
  handlers: RunnerTransportHandlers,
): Promise<RunnerTransport> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${lock.port}/runner`, {
      headers: { authorization: `Bearer ${lock.token}` },
    });
    let opened = false;
    let lastError: Error | undefined;
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
      if (!opened) reject(error);
    });
    ws.on("close", () => {
      if (opened) handlers.onClose(lastError?.message);
    });
  });
}

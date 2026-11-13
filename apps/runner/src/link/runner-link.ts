import { join } from "node:path";
import type { Readable, Writable } from "node:stream";
import {
  encodeLinkFrame,
  LinkFrameDecoder,
  RUNNER_LINK_MAX_LINE_BYTES,
  RunnerLinkExit,
  type RunnerLinkExitCode,
  type RunnerLock,
} from "@codeden/contracts";
import WebSocket from "ws";
import { readLock } from "../lock";
import { isAlive } from "../process/tree";

export interface RunnerLinkOptions {
  /** The runner's data directory; its lock file is `<home>/runner/runner.json`. */
  home: string;
  /** Frames from the server. */
  stdin: Readable;
  /** Frames to the server, and nothing else. */
  stdout: Writable;
  /** The link's own log. */
  stderr: Writable;
  /** Ends the link at once, like killing its process: the socket drops without a goodbye. */
  signal?: AbortSignal;
}

const MAX_MIB = RUNNER_LINK_MAX_LINE_BYTES / (1024 * 1024);

/**
 * `codeden runner-link` (`docs/remote-runners.md` §6): run next to a runner, usually inside a
 * sandbox the server reaches through the backend's own stdio channel (`docker exec -i`). It
 * finds the runner through its lock file, connects to its loopback WebSocket with the lock's
 * token, and splices: each newline-delimited JSON line on stdin becomes one WebSocket message,
 * and each message from the runner one line on stdout. Stdout carries only those frames; logs
 * go to stderr and never contain the token. Resolves with the exit code (`RunnerLinkExit`).
 */
export async function runRunnerLink(opts: RunnerLinkOptions): Promise<RunnerLinkExitCode> {
  const log = (message: string) => {
    opts.stderr.write(`codeden runner-link: ${message}\n`);
  };
  const lock = readLock(join(opts.home, "runner", "runner.json"));
  if (!lock || !isAlive(lock.pid)) {
    log(`no runner is running in ${opts.home}`);
    return RunnerLinkExit.noRunner;
  }
  if (opts.signal?.aborted) return RunnerLinkExit.failed;
  const opened = await connect(lock);
  if ("exit" in opened) {
    log(opened.message);
    return opened.exit;
  }
  log(`linked to runner ${lock.runnerId} (pid ${lock.pid})`);
  return splice(opened.ws, opts, log);
}

type Opened = { ws: WebSocket } | { exit: RunnerLinkExitCode; message: string };

function connect(lock: RunnerLock): Promise<Opened> {
  return new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${lock.port}/runner`, {
      headers: { authorization: `Bearer ${lock.token}` },
    });
    // Kept for the socket's whole life: an `error` without a listener would throw.
    ws.on("error", (error) =>
      resolve({
        exit: RunnerLinkExit.noRunner,
        message: `cannot reach the runner on 127.0.0.1:${lock.port}: ${error.message}`,
      }),
    );
    ws.once("unexpected-response", (req, res) => {
      const status = res.statusCode ?? 0;
      res.resume();
      req.destroy();
      resolve(
        status === 401 || status === 403
          ? {
              exit: RunnerLinkExit.rejected,
              message: `the runner refused the link (HTTP ${status})`,
            }
          : { exit: RunnerLinkExit.failed, message: `the runner answered HTTP ${status}` },
      );
    });
    ws.once("open", () => resolve({ ws }));
  });
}

function splice(
  ws: WebSocket,
  opts: RunnerLinkOptions,
  log: (message: string) => void,
): Promise<RunnerLinkExitCode> {
  const { stdin, stdout, signal } = opts;
  return new Promise((resolve) => {
    let done = false;
    let inputEnded = false;
    let paused = false;

    const finish = (code: RunnerLinkExitCode, message?: string) => {
      if (done) return;
      done = true;
      if (message) log(message);
      stdin.off("data", onInput);
      stdin.off("end", onInputEnd);
      stdin.off("error", onInputError);
      stdout.off("drain", onDrain);
      signal?.removeEventListener("abort", onAbort);
      resolve(code);
    };

    // Server -> runner: one WebSocket text message per frame.
    const decoder = new LinkFrameDecoder({
      onDrop: (reason, bytes) =>
        log(
          reason === "too_large"
            ? `dropped a ${bytes}-byte line from the server (over the ${MAX_MIB} MiB limit)`
            : "dropped a line from the server that is not JSON",
        ),
    });
    const onInput = (chunk: Buffer | string) => {
      const bytes = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
      for (const message of decoder.push(bytes)) {
        if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(message));
      }
    };
    // The server closed the link: say goodbye to the runner, which keeps running.
    const onInputEnd = () => {
      inputEnded = true;
      if (ws.readyState === WebSocket.OPEN) ws.close(1000, "link closed");
      setTimeout(() => ws.terminate(), 2_000).unref();
    };
    const onInputError = (error: Error) => {
      ws.terminate();
      finish(RunnerLinkExit.failed, `reading from the server failed: ${error.message}`);
    };

    // Runner -> server: one line per message, paused while stdout is full.
    const onDrain = () => {
      paused = false;
      ws.resume();
    };
    ws.on("message", (data, isBinary) => {
      if (isBinary) return log("dropped a binary message from the runner");
      let message: unknown;
      try {
        message = JSON.parse(data.toString());
      } catch {
        return log("dropped a message from the runner that is not JSON");
      }
      const frame = encodeLinkFrame(message);
      if (frame === null) {
        const size = Buffer.byteLength(data.toString());
        return log(
          `dropped a ${size}-byte message from the runner (over the ${MAX_MIB} MiB limit)`,
        );
      }
      if (!stdout.write(frame) && !paused) {
        paused = true;
        ws.pause();
        stdout.once("drain", onDrain);
      }
    });
    ws.on("close", (code, reason) => {
      if (inputEnded) return finish(RunnerLinkExit.closed);
      const why = reason.toString() || `code ${code}`;
      finish(RunnerLinkExit.failed, `the runner closed the link (${why})`);
    });
    ws.on("error", (error) => {
      ws.terminate();
      finish(RunnerLinkExit.failed, `the link to the runner failed: ${error.message}`);
    });

    const onAbort = () => {
      ws.terminate();
      finish(RunnerLinkExit.failed);
    };
    if (signal?.aborted) return onAbort();
    signal?.addEventListener("abort", onAbort, { once: true });
    stdin.on("data", onInput);
    stdin.once("end", onInputEnd);
    stdin.once("error", onInputError);
  });
}

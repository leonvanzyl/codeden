import { spawn } from "node:child_process";
import type { Readable, Writable } from "node:stream";
import {
  describeRunnerLinkExit,
  encodeLinkFrame,
  LinkFrameDecoder,
  RUNNER_LINK_MAX_LINE_BYTES,
} from "@codeden/contracts";
import { ownNodeEnv } from "@codeden/providers";
import {
  RunnerFrameTooLargeError,
  type RunnerTransport,
  type RunnerTransportHandlers,
} from "./transport";

/**
 * A started link: `codeden runner-link` running next to a runner, its stdio reaching the
 * server through whatever channel the backend offers. A local child process (`docker exec -i
 * <container> codeden runner-link`) is one (`spawnLinkProcess`); a cloud exec session is
 * another, behind the same shape.
 */
export interface LinkProcess {
  /** Frames to the runner. */
  readonly stdin: Writable;
  /** Frames from the runner, and nothing else. */
  readonly stdout: Readable;
  /** The link's log (and the channel's own errors), shown in the server log. */
  readonly stderr: Readable | null;
  /** Its pid when it is a local child process. */
  readonly pid?: number;
  /** End it at once. */
  kill(): void;
  /**
   * Called once, when it has ended and its output has been read. `code` is its exit code
   * (`RunnerLinkExit`), or null when it was killed or never started.
   */
  onExit(listener: (code: number | null) => void): void;
}

/** Reach a runner through an exec link: `start` opens a new link for every (re)connect. */
export interface ExecLinkConfig {
  kind: "exec";
  start: () => LinkProcess;
}

/** An exec link that runs `command args` as a local child process (e.g. `docker exec -i`). */
export function execLink(
  command: string,
  args: string[],
  env?: Record<string, string>,
): ExecLinkConfig {
  return { kind: "exec", start: () => spawnLinkProcess(command, args, env) };
}

/** Start a link as a child process with piped stdio. */
export function spawnLinkProcess(
  command: string,
  args: string[],
  extraEnv?: Record<string, string>,
): LinkProcess {
  const env = { ...process.env, ...extraEnv };
  const child = spawn(command, args, {
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
    // In the desktop app `process.execPath` is the Electron binary: run it as Node.js (§17).
    env: command === process.execPath ? ownNodeEnv(env) : env,
  });
  let exit: { code: number | null } | undefined;
  const listeners: Array<(code: number | null) => void> = [];
  const ended = (code: number | null) => {
    if (exit) return;
    exit = { code };
    for (const listener of listeners.splice(0)) listener(code);
  };
  // A command that could not start (not found) ends here; other errors end in `close`.
  child.on("error", () => {
    if (child.pid === undefined) ended(null);
  });
  child.once("close", (code) => ended(code));
  return {
    stdin: child.stdin,
    stdout: child.stdout,
    stderr: child.stderr,
    pid: child.pid,
    kill: () => {
      child.kill();
    },
    onExit: (listener) => {
      if (exit) listener(exit.code);
      else listeners.push(listener);
    },
  };
}

const CLOSE_GRACE_MS = 2_000;
const MAX_MIB = RUNNER_LINK_MAX_LINE_BYTES / (1024 * 1024);
/** Characters kept of a stderr line: its end, where errors usually say what went wrong. */
const STDERR_LINE_CHARS = 300;

/**
 * A link's stderr as trimmed, non-empty lines of at most `max` characters, keeping each long
 * line's end (marked with a leading "…"). An unfinished line holds at most `max` characters
 * however long it grows, so a noisy channel that never writes a newline costs bounded memory.
 */
export class StderrLines {
  private partial = "";
  private cut = false;

  constructor(private readonly max = STDERR_LINE_CHARS) {}

  /** Characters of an unfinished line held so far. */
  get pending(): number {
    return this.partial.length;
  }

  /** Feed the next chunk; returns the lines it completed. */
  push(text: string): string[] {
    const lines: string[] = [];
    let start = 0;
    for (;;) {
      const newline = text.indexOf("\n", start);
      this.keep(text.slice(start, newline === -1 ? text.length : newline));
      if (newline === -1) return lines;
      const line = this.take();
      if (line) lines.push(line);
      start = newline + 1;
    }
  }

  /** The unfinished line, once the stream has ended. */
  flush(): string | undefined {
    return this.take() || undefined;
  }

  private keep(piece: string): void {
    if (!piece) return;
    // Only the last `max` characters can survive, so never join more than that.
    const tail = piece.length > this.max ? piece.slice(-this.max) : piece;
    const joined = this.partial + tail;
    if (tail.length < piece.length || joined.length > this.max) this.cut = true;
    this.partial = joined.length > this.max ? joined.slice(-this.max) : joined;
  }

  private take(): string {
    const text = this.partial.trim();
    const line = text && this.cut ? `…${text}` : text;
    this.partial = "";
    this.cut = false;
    return line;
  }
}

/**
 * The `exec` transport: one link process, newline-delimited JSON on its stdin and stdout
 * (`@codeden/contracts` `runner/link.ts`). Its stderr goes to the log, and its last line
 * explains why it ended. Nothing to wait for: the runner's `welcome` is the first frame.
 */
export function openExecTransport(
  link: ExecLinkConfig,
  handlers: RunnerTransportHandlers,
): RunnerTransport {
  const log = handlers.log;
  const proc = link.start();
  let exited = false;
  const exitWaiters: Array<() => void> = [];

  const decoder = new LinkFrameDecoder({
    onDrop: (reason, bytes) =>
      log?.(
        reason === "too_large"
          ? `runner-link: dropped a ${bytes}-byte line (over the ${MAX_MIB} MiB limit)`
          : "runner-link: dropped a line that is not JSON",
      ),
  });
  proc.stdout.on("data", (chunk: Buffer | string) => {
    const bytes = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
    for (const message of decoder.push(bytes)) handlers.onMessage(message);
  });
  proc.stdout.on("error", (error) => log?.(`runner-link: reading failed: ${error.message}`));
  // A link that died mid-write must not take the server down (EPIPE).
  proc.stdin.on("error", (error) => log?.(`runner-link: writing failed: ${error.message}`));

  let lastLine = "";
  const stderr = new StderrLines();
  const stderrLine = (line: string) => {
    lastLine = line;
    log?.(`runner-link: ${line}`);
  };
  proc.stderr?.setEncoding("utf8");
  proc.stderr?.on("data", (text: string) => {
    for (const line of stderr.push(text)) stderrLine(line);
  });
  proc.stderr?.on("error", () => undefined);

  proc.onExit((code) => {
    exited = true;
    const rest = stderr.flush();
    if (rest) stderrLine(rest);
    for (const done of exitWaiters.splice(0)) done();
    const why = describeRunnerLinkExit(code);
    handlers.onClose(lastLine ? `${why} (${lastLine})` : why);
  });

  const waitForExit = (ms: number) =>
    new Promise<void>((resolve) => {
      if (exited) return resolve();
      exitWaiters.push(resolve);
      setTimeout(resolve, ms).unref();
    });

  return {
    linkPid: proc.pid,
    send: (message) => {
      const frame = encodeLinkFrame(message);
      if (frame === null) {
        const what =
          message.type === "command" ? `Runner command ${message.command.name}` : "A message";
        throw new RunnerFrameTooLargeError(what);
      }
      if (!exited && proc.stdin.writable) proc.stdin.write(frame);
    },
    close: async () => {
      if (exited) return;
      // Ending stdin asks the link to say goodbye to the runner and exit; then it is killed.
      proc.stdin.end();
      await waitForExit(CLOSE_GRACE_MS);
      if (exited) return;
      proc.kill();
      await waitForExit(CLOSE_GRACE_MS);
    },
  };
}

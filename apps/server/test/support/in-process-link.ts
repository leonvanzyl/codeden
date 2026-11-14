import { PassThrough } from "node:stream";
import { runRunnerLink } from "@codeden/runner/link";
import type { LinkProcess } from "../../src/runner/transport-exec";

/** An exec link run in this process: `codeden runner-link`'s code, over in-memory pipes. */
export interface InProcessLink extends LinkProcess {
  /** What the link wrote to stderr so far. */
  readonly log: () => string;
}

/**
 * Start `runRunnerLink` for the runner in `home` with stdio on PassThrough streams, shaped like
 * a link child process: `kill()` drops its socket at once, as killing the process would, and
 * `onExit` reports null then (otherwise the link's exit code) after its stdout has been read.
 */
export function startInProcessLink(home: string): InProcessLink {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  let log = "";
  stderr.on("data", (chunk: Buffer) => {
    log += chunk.toString();
  });
  const abort = new AbortController();
  let exit: { code: number | null } | undefined;
  const listeners: Array<(code: number | null) => void> = [];
  void runRunnerLink({ home, stdin, stdout, stderr, signal: abort.signal }).then((code) => {
    const reported = abort.signal.aborted ? null : code;
    stdout.once("end", () => {
      exit = { code: reported };
      for (const listener of listeners.splice(0)) listener(reported);
    });
    stdout.end();
    stderr.end();
  });
  return {
    stdin,
    stdout,
    stderr,
    log: () => log,
    kill: () => abort.abort(),
    onExit: (listener) => {
      if (exit) listener(exit.code);
      else listeners.push(listener);
    },
  };
}

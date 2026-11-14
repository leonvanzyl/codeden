import type { ServerToRunnerMessage } from "@codeden/contracts";

/**
 * One connection to a runner (`docs/remote-runners.md` §6). The runner protocol (§4.3) is JSON
 * messages and doesn't depend on what carries them:
 * - `loopback` (`transport-loopback.ts`): the runner's `127.0.0.1` WebSocket, found through
 *   its lock file. The home runner, and any runner on this machine.
 * - `exec` (`transport-exec.ts`): newline-delimited JSON on the stdin and stdout of a link
 *   process, `codeden runner-link` started next to the runner through a backend's own stdio
 *   channel (`docker exec -i`, an Upstash exec session). Needs no listener anywhere.
 *
 * A transport is opened with its handlers (`RunnerTransportHandlers`), so nothing it receives
 * or any way it ends is missed. `RunnerClient` drives the handshake, acks and reconnects on top.
 */
export interface RunnerTransport {
  /**
   * Send one message. Dropped once the transport is closed; throws `RunnerFrameTooLargeError`
   * when the message can't cross it.
   */
  send(message: ServerToRunnerMessage): void;
  /** Close it (the runner keeps running). Resolves once it is closed, or after a short grace. */
  close(reason?: string): Promise<void>;
  /** The link process's pid, for an exec link started as a local child process. */
  readonly linkPid?: number;
}

export interface RunnerTransportHandlers {
  /** Each message from the runner, as parsed JSON (the client validates it). */
  onMessage: (message: unknown) => void;
  /**
   * Called once when an opened transport ends, for any reason, with what is known about why
   * (the socket error, or how the link process exited).
   */
  onClose: (detail?: string) => void;
  log?: (message: string) => void;
}

/** A message too large for the transport (an exec link line is at most 16 MiB). */
export class RunnerFrameTooLargeError extends Error {
  constructor(what: string) {
    super(`${what} is too large for the runner link`);
    this.name = "RunnerFrameTooLargeError";
  }
}

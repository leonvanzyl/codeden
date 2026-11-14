import { utf8ByteLength } from "../tool-output";

/**
 * The exec link's wire format (`docs/remote-runners.md` §6). The server reaches a runner in a
 * sandbox by starting `codeden runner-link` there through the backend's own stdio channel
 * (`docker exec -i`, an Upstash exec session). Runner protocol messages (`./messages.ts`) cross
 * it as newline-delimited JSON: one compact JSON message per line, each line at most
 * `RUNNER_LINK_MAX_LINE_BYTES`, on the link's stdin (server to runner) and stdout (runner to
 * server). The link writes nothing else to stdout; its logs go to stderr.
 *
 * Portable code (no `Buffer`), shared by the server's exec transport and the link itself.
 */

/**
 * The longest line either side accepts: 16 MiB of UTF-8, counting every byte but the `\n` (a
 * `\r` before it counts too).
 */
export const RUNNER_LINK_MAX_LINE_BYTES = 16 * 1024 * 1024;

/**
 * How `codeden runner-link` exits, so the server can tell why a link ended:
 * - `closed`: the server closed the link (its stdin ended);
 * - `failed`: the link broke, or the runner closed its end (stopping, or replaced by a newer
 *   connection);
 * - `usage`: bad command-line arguments;
 * - `noRunner`: no live runner in the home folder (no lock file, its process is gone, or it
 *   refused the connection);
 * - `rejected`: the runner refused the link (it did not accept the token in its lock file).
 */
export const RunnerLinkExit = {
  closed: 0,
  failed: 1,
  usage: 2,
  noRunner: 3,
  rejected: 4,
} as const;
export type RunnerLinkExitCode = (typeof RunnerLinkExit)[keyof typeof RunnerLinkExit];

/** Why a link process ended, for logs and the runner's `lastError`, from its exit code. */
export function describeRunnerLinkExit(code: number | null): string {
  switch (code) {
    case null:
      return "the runner link was killed";
    case RunnerLinkExit.closed:
      return "the runner link closed";
    case RunnerLinkExit.failed:
      return "the runner link failed";
    case RunnerLinkExit.usage:
      return "the runner link was started with bad arguments";
    case RunnerLinkExit.noRunner:
      return "no runner is running at the other end of the link";
    case RunnerLinkExit.rejected:
      return "the runner rejected the link";
    default:
      return `the runner link exited with code ${code}`;
  }
}

/**
 * One message as a link frame: compact JSON and a `\n`. Null when it can't be one: longer
 * than `maxBytes`, or not JSON at all (`undefined`). `JSON.stringify` escapes every control
 * character inside strings, so the frame holds no other newline.
 */
export function encodeLinkFrame(
  message: unknown,
  maxBytes = RUNNER_LINK_MAX_LINE_BYTES,
): string | null {
  const json = JSON.stringify(message) as string | undefined;
  if (json === undefined) return null;
  // At most 3 bytes per UTF-16 unit: skip counting when it can't be too long.
  if (json.length * 3 > maxBytes && utf8ByteLength(json) > maxBytes) return null;
  return `${json}\n`;
}

/** Why the decoder dropped a line. */
export type LinkDropReason = "too_large" | "invalid_json";

export interface LinkFrameDecoderOptions {
  /** Default `RUNNER_LINK_MAX_LINE_BYTES`. */
  maxBytes?: number;
  /** Called for every line dropped, with its size in bytes (as far as it was read). */
  onDrop?: (reason: LinkDropReason, bytes: number) => void;
}

const NEWLINE = 0x0a;
const CARRIAGE_RETURN = 0x0d;

/**
 * Splits a byte stream into link messages. Lines may arrive split across any number of chunks,
 * mid-character included (a `\n` byte never occurs inside a UTF-8 sequence, so a line is only
 * decoded once whole). A trailing `\r` is tolerated (it still counts towards the limit) and
 * empty lines are skipped. A line over the limit is dropped without buffering more than the
 * limit, and decoding resumes after its `\n`; a line that is not JSON is dropped too. Each drop
 * is reported through `onDrop` with the line's size. A partial line left when the stream ends is
 * never delivered.
 */
export class LinkFrameDecoder {
  private readonly maxBytes: number;
  private readonly onDrop: LinkFrameDecoderOptions["onDrop"];
  private readonly text = new TextDecoder();
  private parts: Uint8Array[] = [];
  private size = 0;
  /** Inside a line over the limit: its bytes so far, discarded until its `\n`. */
  private skipped: number | null = null;

  constructor(opts: LinkFrameDecoderOptions = {}) {
    this.maxBytes = opts.maxBytes ?? RUNNER_LINK_MAX_LINE_BYTES;
    this.onDrop = opts.onDrop;
  }

  /** Bytes of an unfinished line held so far. */
  get buffered(): number {
    return this.size;
  }

  /** Feed the next chunk; returns the messages of every line it completed. */
  push(chunk: Uint8Array): unknown[] {
    const messages: unknown[] = [];
    let start = 0;
    while (start < chunk.length) {
      const newline = chunk.indexOf(NEWLINE, start);
      const end = newline === -1 ? chunk.length : newline;
      const piece = chunk.subarray(start, end);
      if (this.skipped !== null) {
        this.skipped += piece.length;
      } else if (this.size + piece.length > this.maxBytes) {
        // Every byte before the "\n" counts, a "\r" included: past the limit it can't fit.
        this.skipped = this.size + piece.length;
        this.parts = [];
        this.size = 0;
      } else if (newline === -1) {
        // Copied: the caller may reuse its buffer for the next chunk.
        this.parts.push(piece.slice());
        this.size += piece.length;
      }
      if (newline === -1) break;
      if (this.skipped !== null) {
        this.onDrop?.("too_large", this.skipped);
        this.skipped = null;
      } else {
        this.line(this.take(piece), messages);
      }
      start = newline + 1;
    }
    return messages;
  }

  /** The held parts and the line's last piece, as one array; clears the buffer. */
  private take(last: Uint8Array): Uint8Array {
    if (this.parts.length === 0) return last;
    const line = new Uint8Array(this.size + last.length);
    let offset = 0;
    for (const part of this.parts) {
      line.set(part, offset);
      offset += part.length;
    }
    line.set(last, offset);
    this.parts = [];
    this.size = 0;
    return line;
  }

  private line(bytes: Uint8Array, messages: unknown[]): void {
    // The raw line is checked before its "\r" is stripped (`push` keeps it within the limit).
    if (bytes.length > this.maxBytes) {
      this.onDrop?.("too_large", bytes.length);
      return;
    }
    const end = bytes[bytes.length - 1] === CARRIAGE_RETURN ? bytes.length - 1 : bytes.length;
    if (end === 0) return;
    const text = this.text.decode(bytes.subarray(0, end));
    if (text.trim() === "") return;
    try {
      messages.push(JSON.parse(text));
    } catch {
      this.onDrop?.("invalid_json", bytes.length);
    }
  }
}

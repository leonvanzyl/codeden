import { PassThrough } from "node:stream";
import { encodeLinkFrame, RunnerLinkExit } from "@codeden/contracts";
import { describe, expect, it } from "vitest";
import { type LinkProcess, openExecTransport, StderrLines } from "../src/runner/transport-exec";

/**
 * The `exec` transport over an in-memory link process: frames in, and a link's stderr kept
 * bounded with the end of each line (where errors say what went wrong) surviving.
 */

/** A link process made of pipes; `exit(code)` ends it once its output has been read. */
function fakeLink() {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const listeners: Array<(code: number | null) => void> = [];
  const proc: LinkProcess = {
    stdin,
    stdout,
    stderr,
    kill: () => undefined,
    onExit: (listener) => {
      listeners.push(listener);
    },
  };
  const ended = (stream: PassThrough) =>
    new Promise<void>((resolve) => {
      stream.once("end", () => resolve());
      stream.end();
    });
  return {
    proc,
    stdout,
    stderr,
    exit: async (code: number | null) => {
      await Promise.all([ended(stdout), ended(stderr)]);
      for (const listener of listeners) listener(code);
    },
  };
}

describe("exec transport stderr", () => {
  it("holds a bounded part of an unfinished line, however many chunks arrive without a newline", () => {
    const lines = new StderrLines(300);
    for (let i = 0; i < 5_000; i++) {
      expect(lines.push("x".repeat(1_000))).toEqual([]);
      expect(lines.pending).toBeLessThanOrEqual(300);
    }
    const [line] = lines.push(" FATAL: no space left on device\nnext");
    expect(line?.startsWith("…")).toBe(true);
    expect(line?.endsWith("FATAL: no space left on device")).toBe(true);
    expect(line?.length).toBeLessThanOrEqual(301);
    expect(lines.pending).toBe(4);
    expect(lines.flush()).toBe("next");
  });

  it("keeps short lines whole, split across chunks, and skips blank ones", () => {
    const lines = new StderrLines(300);
    expect(lines.push("codeden runner-link: no runner ")).toEqual([]);
    expect(lines.push("is running in /x\r\n\n  \nsecond\n")).toEqual([
      "codeden runner-link: no runner is running in /x",
      "second",
    ]);
    expect(lines.push("y".repeat(300))).toEqual([]);
    expect(lines.flush()).toBe("y".repeat(300)); // exactly the limit: not cut
    expect(lines.flush()).toBeUndefined();
  });

  it("explains a link's end with the end of its last stderr line, bounded", async () => {
    const link = fakeLink();
    const messages: unknown[] = [];
    const logged: string[] = [];
    let detail: string | undefined;
    openExecTransport(
      { kind: "exec", start: () => link.proc },
      {
        onMessage: (message) => messages.push(message),
        onClose: (why) => {
          detail = why;
        },
        log: (line) => logged.push(line),
      },
    );
    link.stdout.write(encodeLinkFrame({ type: "pong", id: "p1" }));
    // A noisy channel: many chunks, no newline, the error at the very end.
    for (let i = 0; i < 2_000; i++) link.stderr.write("z".repeat(512));
    link.stderr.write(" docker: Error response from daemon: container abc is not running");
    await link.exit(RunnerLinkExit.failed);

    expect(messages).toEqual([{ type: "pong", id: "p1" }]);
    expect(detail).toMatch(/^the runner link failed \(…z*/);
    expect(detail).toMatch(/container abc is not running\)$/);
    expect(detail?.length).toBeLessThan(400);
    expect(logged.every((line) => line.length < 400)).toBe(true);
  });
});

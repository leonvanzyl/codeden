import { PassThrough } from "node:stream";
import {
  CODEDEN_VERSION,
  encodeLinkFrame,
  LinkFrameDecoder,
  RUNNER_PROTOCOL_VERSION,
  RunnerLinkExit,
  type RunnerWelcome,
  ServerToRunnerMessage,
} from "@codeden/contracts";
import { describe, expect, it, vi } from "vitest";
import { openDatabase } from "../src/db/client";
import { EventStore } from "../src/events/store";
import { RunnerClient } from "../src/runner/client";
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

it("reports an attached runner missing pongs and recovers only on the current ping", async () => {
  const database = openDatabase(":memory:");
  const store = new EventStore(database.db);
  const link = fakeLink();
  const decoder = new LinkFrameDecoder();
  const sent: ServerToRunnerMessage[] = [];
  (link.proc.stdin as PassThrough).on("data", (chunk: Buffer) => {
    for (const raw of decoder.push(chunk)) {
      const message = ServerToRunnerMessage.parse(raw);
      sent.push(message);
      if (message.type === "hello") {
        link.stdout.write(
          encodeLinkFrame({
            type: "welcome",
            protocolVersion: RUNNER_PROTOCOL_VERSION,
            runnerId: "heartbeat-runner",
            runnerVersion: CODEDEN_VERSION,
            pid: process.pid,
            startedAt: "2026-11-21T12:00:00.000Z",
            capabilities: { pty: false, browser: false, git: true, mcpProxy: false },
            providers: [],
            sessions: [],
            journal: { lastSeq: 0, unacked: 0 },
            draining: false,
          } satisfies RunnerWelcome),
        );
      }
    }
  });
  const client = new RunnerClient({
    home: ".",
    lockFile: "",
    launch: null,
    db: database.db,
    store,
    link: { kind: "exec", start: () => link.proc },
  });
  const pings = () => sent.filter((m) => m.type === "ping");
  let ended = false;
  try {
    vi.useFakeTimers({
      toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "performance"],
    });
    await client.start();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(pings()).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(client.status).toMatchObject({ state: "connected", responsive: false });
    expect(pings()).toHaveLength(2);
    link.stdout.write(encodeLinkFrame({ type: "pong", id: pings()[0]?.id }));
    expect(client.status.responsive).toBe(false);
    link.stdout.write(encodeLinkFrame({ type: "pong", id: pings()[1]?.id }));
    expect(client.status).toMatchObject({ state: "connected", responsive: true });
    expect(store.listAfter(0, 100).filter((e) => e.type === "runner.disconnected")).toEqual([]);
    const stopping = client.stop();
    await link.exit(0);
    ended = true;
    await stopping;
    await vi.advanceTimersByTimeAsync(30_000);
    expect(pings()).toHaveLength(2);
  } finally {
    vi.useRealTimers();
    if (!ended) await Promise.all([client.stop(), link.exit(0)]);
    database.close();
  }
});

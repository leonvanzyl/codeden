import { mkdirSync, writeFileSync } from "node:fs";
import { type AddressInfo, createServer, type Socket } from "node:net";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import {
  encodeLinkFrame,
  LinkFrameDecoder,
  RUNNER_PROTOCOL_VERSION,
  RunnerLinkExit,
  type RunnerLock,
  RunnerToServerMessage,
  type ServerToRunnerMessage,
} from "@codeden/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { type RunningRunner, startRunner } from "../src";
import { runRunnerLink } from "../src/link/runner-link";
import { removeDir, tempDir } from "./helpers";

/**
 * `codeden runner-link` (`docs/remote-runners.md` §6) run in this process over in-memory
 * pipes: exit codes, stdout carrying only protocol frames, and logs that never show the token.
 */

const homes: string[] = [];
let runner: RunningRunner | undefined;

afterEach(async () => {
  await runner?.close();
  runner = undefined;
  for (const home of homes.splice(0)) removeDir(home);
});

function newHome(): string {
  const home = tempDir("codeden-link-");
  homes.push(home);
  return home;
}

/** Run the link against `home` with piped stdio; collects everything it writes. */
function link(home: string, signal?: AbortSignal) {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const out: Buffer[] = [];
  let log = "";
  const received: unknown[] = [];
  const decoder = new LinkFrameDecoder();
  stdout.on("data", (chunk: Buffer) => {
    out.push(chunk);
    received.push(...decoder.push(chunk));
  });
  stderr.on("data", (chunk: Buffer) => {
    log += chunk.toString();
  });
  const exit = runRunnerLink({ home, stdin, stdout, stderr, signal });
  return {
    exit,
    send: (message: ServerToRunnerMessage) => stdin.write(encodeLinkFrame(message)),
    raw: (text: string) => stdin.write(text),
    end: () => stdin.end(),
    received,
    stdout: () => Buffer.concat(out).toString("utf8"),
    log: () => log,
  };
}

async function until<T>(probe: () => T | undefined, timeoutMs = 10_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = probe();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 20));
  }
}

describe("runner-link", () => {
  it("splices frames both ways, writes only frames to stdout, and exits 0 when stdin ends", async () => {
    const home = newHome();
    runner = await startRunner({ home, enableFakeProvider: true });
    const l = link(home);
    l.send({ type: "hello", protocolVersion: RUNNER_PROTOCOL_VERSION, serverVersion: "test" });
    const welcome = await until(() => l.received.find((m) => (m as { type?: string }).type));
    expect(welcome).toMatchObject({ type: "welcome", backend: "local", home });
    l.send({ type: "resume", lastAckedSeq: 0 });
    // A line that is not JSON is dropped (and logged); the link goes on.
    l.raw("this is not json\n");
    l.send({ type: "command", id: "c1", command: { name: "runner.status" } });
    await until(() =>
      l.received.some((m) => (m as { id?: string }).id === "c1") ? true : undefined,
    );
    l.end();
    expect(await l.exit).toBe(RunnerLinkExit.closed);

    // Every stdout line is one protocol message; nothing else was written there.
    const lines = l.stdout().split("\n");
    expect(lines.pop()).toBe("");
    expect(lines.length).toBeGreaterThanOrEqual(3);
    for (const line of lines) {
      expect(RunnerToServerMessage.safeParse(JSON.parse(line)).success).toBe(true);
    }
    expect(l.log()).toContain("linked to runner");
    expect(l.log()).toContain("not JSON");
    expect(l.log()).not.toContain(runner.token);
  });

  it("exits 3 when no runner is running in the home", async () => {
    const home = newHome();
    const l = link(home);
    expect(await l.exit).toBe(RunnerLinkExit.noRunner);
    expect(l.stdout()).toBe("");
    expect(l.log()).toContain("no runner is running");
  });

  it("exits 4 when the runner refuses the token, without logging it", async () => {
    const live = newHome();
    runner = await startRunner({ home: live, enableFakeProvider: true });
    // A lock that points at the live runner with the wrong token.
    const home = newHome();
    const wrong = "0".repeat(64);
    writeLock(home, runner.port, wrong);
    const l = link(home);
    expect(await l.exit).toBe(RunnerLinkExit.rejected);
    expect(l.stdout()).toBe("");
    expect(l.log()).toContain("refused");
    expect(l.log()).not.toContain(wrong);
  });

  it("exits 1 when the runner closes the link", async () => {
    const home = newHome();
    runner = await startRunner({ home, enableFakeProvider: true });
    const l = link(home);
    l.send({ type: "hello", protocolVersion: RUNNER_PROTOCOL_VERSION, serverVersion: "test" });
    await until(() => (l.received.length > 0 ? true : undefined));
    await runner.close();
    runner = undefined;
    expect(await l.exit).toBe(RunnerLinkExit.failed);
    expect(l.log()).toContain("the runner closed the link");
  });

  it("aborting while the upgrade is still pending drops the socket and ends the link", async () => {
    // A listener that accepts the connection but never answers the WebSocket upgrade.
    const accepted: Socket[] = [];
    let onConnection: () => void = () => undefined;
    const connected = new Promise<void>((resolve) => {
      onConnection = resolve;
    });
    const stall = createServer((socket) => {
      socket.on("error", () => undefined);
      accepted.push(socket);
      onConnection();
    });
    await new Promise<void>((resolve) => stall.listen(0, "127.0.0.1", resolve));
    try {
      const home = newHome();
      writeLock(home, (stall.address() as AddressInfo).port, "s".repeat(64));
      const abort = new AbortController();
      const l = link(home, abort.signal);
      await connected;
      const socket = accepted[0] as Socket;
      const dropped = new Promise<void>((resolve) => socket.once("close", () => resolve()));
      abort.abort();
      // Settles without the upgrade ever finishing, and the attempted socket is closed.
      expect(await l.exit).toBe(RunnerLinkExit.failed);
      await dropped;
      expect(l.stdout()).toBe("");
    } finally {
      for (const socket of accepted) socket.destroy();
      await new Promise<void>((resolve) => stall.close(() => resolve()));
    }
  });
});

/** A lock file in `home` pointing at `port` with `token`, owned by this (live) process. */
function writeLock(home: string, port: number, token: string): void {
  const lock: RunnerLock = {
    pid: process.pid,
    port,
    token,
    version: "test",
    protocolVersion: RUNNER_PROTOCOL_VERSION,
    runnerId: "someone-else",
    startedAt: new Date().toISOString(),
    providers: [],
  };
  mkdirSync(join(home, "runner"), { recursive: true });
  writeFileSync(join(home, "runner", "runner.json"), JSON.stringify(lock));
}

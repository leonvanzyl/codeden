import { mkdirSync, writeFileSync } from "node:fs";
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
function link(home: string) {
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
  const exit = runRunnerLink({ home, stdin, stdout, stderr });
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
    // A lock that points at the live runner with the wrong token (alive pid: this process).
    const home = newHome();
    const wrong = "0".repeat(64);
    const lock: RunnerLock = {
      pid: process.pid,
      port: runner.port,
      token: wrong,
      version: "test",
      protocolVersion: RUNNER_PROTOCOL_VERSION,
      runnerId: "someone-else",
      startedAt: new Date().toISOString(),
      providers: [],
    };
    mkdirSync(join(home, "runner"), { recursive: true });
    writeFileSync(join(home, "runner", "runner.json"), JSON.stringify(lock));
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
});

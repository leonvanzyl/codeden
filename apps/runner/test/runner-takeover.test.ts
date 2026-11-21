import { type ChildProcess, spawn } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";
import { RUNNER_PROTOCOL_VERSION, type RunnerLock, type SessionOptions } from "@codeden/contracts";
import { FakeProvider, type ProviderSession } from "@codeden/providers";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { isAlive, type RunningRunner, readLock, startRunner } from "../src";
import { isLockOwner } from "../src/lock";
import type { ProcessRow } from "../src/process/inside";
import { removeDir, TestServer, tempDir, waitUntil } from "./helpers";

let home: string;
let runner: RunningRunner | undefined;
const children: ChildProcess[] = [];

beforeEach(() => {
  home = tempDir("codeden-takeover-");
});
afterEach(async () => {
  await runner?.close();
  runner = undefined;
  for (const child of children.splice(0)) child.kill("SIGKILL");
  removeDir(home);
});

const lockOf = (over: Partial<RunnerLock>): RunnerLock => ({
  pid: 1,
  port: 1,
  token: "n".repeat(64),
  version: "test",
  protocolVersion: RUNNER_PROTOCOL_VERSION,
  runnerId: "other",
  startedAt: new Date().toISOString(),
  providers: [],
  ...over,
});

/** A port nothing listens on, so a probe there fails at once. */
async function closedPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as { port: number };
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

function writeLockFile(lock: RunnerLock): void {
  mkdirSync(join(home, "runner"), { recursive: true });
  writeFileSync(join(home, "runner", "runner.json"), JSON.stringify(lock));
}

/** A live process that never answers, with `args` on its command line. */
function idleProcess(args: string[]): ChildProcess {
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)", "--", ...args], {
    stdio: "ignore",
  });
  children.push(child);
  return child;
}

describe("isLockOwner (#588)", () => {
  const lock = lockOf({ pid: 42, startedAt: "2026-11-21T10:00:05.000Z" });
  const row = (over: Partial<ProcessRow>): ProcessRow => ({
    pid: 42,
    ppid: 1,
    exe: null,
    commandLine: "node runner.js --home /home/me/.codeden",
    cwd: null,
    startedAt: Date.parse("2026-11-21T10:00:04.000Z"),
    ...over,
  });

  it("is the runner that started before its lock, for this home", () => {
    expect(isLockOwner(row({}), lock, "/home/me/.codeden")).toBe(true);
  });

  it("is never a process that reused the pid later, one for another home or an unknown one", () => {
    const later = row({ startedAt: Date.parse("2026-11-21T11:00:00.000Z") });
    expect(isLockOwner(later, lock, "/home/me/.codeden")).toBe(false);
    expect(isLockOwner(row({}), lock, "/home/other/.codeden")).toBe(false);
    expect(isLockOwner(row({}), lock, "/home/me/.code")).toBe(false);
    const sibling = row({ commandLine: "node runner.js --home /home/me/.codeden-dev" });
    expect(isLockOwner(sibling, lock, "/home/me/.codeden")).toBe(false);
    const quoted = row({ commandLine: 'node runner.js --home "C:\\Users\\Me Too\\.codeden"' });
    expect(isLockOwner(quoted, lock, "C:\\Users\\Me Too\\.codeden")).toBe(true);
    expect(isLockOwner(row({ commandLine: null }), lock, "/home/me/.codeden")).toBe(false);
    expect(isLockOwner(row({ startedAt: null }), lock, "/home/me/.codeden")).toBe(false);
    expect(isLockOwner(row({ pid: 43 }), lock, "/home/me/.codeden")).toBe(false);
    expect(isLockOwner(undefined, lock, "/home/me/.codeden")).toBe(false);
  });
});

describe("a runner replaced by another (#588)", () => {
  it("shuts down once its lock names another runner, leaving the new runner's files alone", async () => {
    let shutdown = false;
    runner = await startRunner({
      home,
      enableFakeProvider: true,
      lockCheckMs: 20,
      onShutdown: () => {
        shutdown = true;
      },
    });
    // The new runner owns the lock and the journal state now.
    const takeover = lockOf({ pid: process.pid + 1 });
    const stateFile = join(home, "runner", "state.json");
    const state = `${JSON.stringify({ runnerId: "kept", lastSeq: 42, ackedSeq: 40 })}\n`;
    writeFileSync(stateFile, state);
    writeFileSync(runner.lockFile, JSON.stringify(takeover));

    await waitUntil(() => shutdown);
    expect(readLock(runner.lockFile)?.token).toBe(takeover.token);
    expect(readFileSync(stateFile, "utf8")).toBe(state);
  });

  it("ends sessions whose provider never finishes closing", async () => {
    class StuckClose extends FakeProvider {
      override async openSession(opts: SessionOptions): Promise<ProviderSession> {
        const session = await super.openSession(opts);
        return Object.assign(session, { close: () => new Promise<void>(() => {}) });
      }
    }
    const logs: string[] = [];
    runner = await startRunner({
      home,
      adapters: [new StuckClose()],
      closeGraceMs: 100,
      log: (m) => logs.push(m),
    });
    const server = await TestServer.attach(runner);
    await server.request({
      name: "session.start",
      sessionId: "s1",
      providerId: "fake",
      options: {
        sessionId: "s1",
        role: "agent",
        cwd: home,
        autonomy: "auto",
        mcpServers: [],
        additionalDirectories: [],
        planMode: false,
      },
    });
    await runner.close();
    expect(logs.some((l) => l.includes("did not close within 100 ms"))).toBe(true);
    await server.close();
  });
});

describe("starting beside a runner that does not answer (#588)", () => {
  it("stops the lock's runner when it is alive but silent", async () => {
    const hung = idleProcess(["--home", home]);
    const exited = new Promise((resolve) => hung.once("exit", resolve));
    await waitUntil(() => hung.pid !== undefined && isAlive(hung.pid));
    const lock = lockOf({ pid: hung.pid, port: await closedPort() });
    writeLockFile(lock);

    runner = await startRunner({ home, enableFakeProvider: true });
    await exited;
    expect(readLock(runner.lockFile)?.token).toBe(runner.token);
  });

  it("leaves a process alone that only reused the lock's pid", async () => {
    const other = idleProcess(["--home", join(home, "elsewhere")]);
    await waitUntil(() => other.pid !== undefined && isAlive(other.pid));
    const lock = lockOf({ pid: other.pid, port: await closedPort() });
    writeLockFile(lock);

    runner = await startRunner({ home, enableFakeProvider: true });
    expect(isAlive(other.pid ?? 0)).toBe(true);
  });
});

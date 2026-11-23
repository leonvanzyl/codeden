import { type ChildProcess, spawn } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";
import { RUNNER_PROTOCOL_VERSION, type RunnerLock, type SessionOptions } from "@codeden/contracts";
import { FakeProvider, type ProviderSession } from "@codeden/providers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { isAlive, Journal, type RunningRunner, readLock, startRunner } from "../src";
import { assertSingleInstance, isLockOwner, removeOwnLock } from "../src/lock";
import type { ProcessRow } from "../src/process/inside";
import type { TreeOps } from "../src/process/tree";
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

/** A Fake provider whose sessions never finish closing. */
class StuckClose extends FakeProvider {
  override async openSession(opts: SessionOptions): Promise<ProviderSession> {
    const session = await super.openSession(opts);
    return Object.assign(session, { close: () => new Promise<void>(() => {}) });
  }
}

/** A Fake provider whose sessions finish closing only once `released` resolves. */
class HeldClose extends FakeProvider {
  constructor(private readonly released: Promise<void>) {
    super();
  }

  override async openSession(opts: SessionOptions): Promise<ProviderSession> {
    const session = await super.openSession(opts);
    const close = session.close.bind(session);
    return Object.assign(session, { close: () => this.released.then(close) });
  }
}

async function startSession(server: TestServer): Promise<void> {
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
}

const runnerFile = (name: string) => join(home, "runner", name);
const read = (file: string) => readFileSync(file, "utf8");

describe("a runner replaced by another (#588, #615)", () => {
  it("stops at once, writing nothing more to the new runner's journal or lock", async () => {
    let shutdown = false;
    runner = await startRunner({
      home,
      adapters: [new StuckClose()],
      lockCheckMs: 20,
      // A replaced runner doesn't wait for its sessions: this would hold the test up.
      closeGraceMs: 120_000,
      onShutdown: () => {
        shutdown = true;
      },
    });
    const server = await TestServer.attach(runner);
    await startSession(server);
    await waitUntil(() => server.events().length > 0);
    const seq = Math.max(...server.events().map((e) => e.seq));
    // Acked and saved: a save at close would now also compact the journal.
    server.send({ type: "ack", seq });
    await waitUntil(() => JSON.parse(read(runnerFile("state.json"))).ackedSeq === seq);
    const journal = read(runnerFile("journal.jsonl"));

    // The new runner owns the lock and the journal state now.
    const takeover = lockOf({ pid: process.pid + 1 });
    const state = `${JSON.stringify({ runnerId: "kept", lastSeq: 42, ackedSeq: 40 })}\n`;
    writeFileSync(runnerFile("state.json"), state);
    writeFileSync(runner.lockFile, JSON.stringify(takeover));

    await waitUntil(() => shutdown);
    expect(readLock(runner.lockFile)?.token).toBe(takeover.token);
    expect(read(runnerFile("state.json"))).toBe(state);
    expect(read(runnerFile("journal.jsonl"))).toBe(journal);
    await server.close();
  });

  it("writes no journal at close once another runner took over meanwhile", async () => {
    let release = () => {};
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    runner = await startRunner({ home, adapters: [new HeldClose(released)] });
    const server = await TestServer.attach(runner);
    await startSession(server);
    // Closing removes the lock at once; a new runner may start before the close ends.
    const closing = runner.close();
    const state = `${JSON.stringify({ runnerId: "kept", lastSeq: 42, ackedSeq: 40 })}\n`;
    writeFileSync(runnerFile("state.json"), state);
    writeFileSync(runner.lockFile, JSON.stringify(lockOf({ pid: process.pid + 1 })));
    const journal = read(runnerFile("journal.jsonl"));
    // The session ends after the takeover: neither its end nor the save at close is written.
    release();
    await closing;
    expect(read(runnerFile("state.json"))).toBe(state);
    expect(read(runnerFile("journal.jsonl"))).toBe(journal);
    await server.close();
  });

  it("ends sessions whose provider never finishes closing", async () => {
    const logs: string[] = [];
    runner = await startRunner({
      home,
      adapters: [new StuckClose()],
      closeGraceMs: 100,
      log: (m) => logs.push(m),
    });
    const server = await TestServer.attach(runner);
    await startSession(server);
    await runner.close();
    expect(logs.some((l) => l.includes("did not close within 100 ms"))).toBe(true);
    await server.close();
  });
});

describe("a journal another runner took over (#615)", () => {
  const event = { kind: "runner.draining", reason: "test" } as const;

  it("cancels a pending save and then ignores appends, acks and close", () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const dir = join(home, "j");
      const journal = new Journal(dir);
      journal.append(event);
      journal.append(event);
      journal.ack(1); // a save is now pending
      const files = [read(join(dir, "state.json")), read(join(dir, "journal.jsonl"))];
      journal.handOver();
      vi.advanceTimersByTime(60_000);
      journal.append(event);
      journal.ack(3);
      journal.close();
      expect([read(join(dir, "state.json")), read(join(dir, "journal.jsonl"))]).toEqual(files);
    } finally {
      vi.useRealTimers();
    }
  });

  it("saves nothing once `owned` says another runner has the files", () => {
    let owned = true;
    const dir = join(home, "j");
    const journal = new Journal(dir, { owned: () => owned });
    journal.append(event);
    journal.ack(1);
    const files = [read(join(dir, "state.json")), read(join(dir, "journal.jsonl"))];
    owned = false;
    journal.close();
    journal.ack(1);
    expect([read(join(dir, "state.json")), read(join(dir, "journal.jsonl"))]).toEqual(files);
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

  it("on Windows stops only what the silent runner started, by start time (#615)", async () => {
    const started = Date.parse("2026-11-21T10:00:00.000Z");
    writeLockFile(lockOf({ pid: 100, startedAt: new Date(started + 500).toISOString() }));
    let alive = true;
    const killed: number[] = [];
    const ops: TreeOps = {
      platform: "win32",
      table: async () => [
        { pid: 100, ppid: 1, startedAt: started },
        // An agent it started, and what that started.
        { pid: 101, ppid: 100, startedAt: started + 1_000 },
        { pid: 102, ppid: 101, startedAt: started + 2_000 },
        // Started by an earlier process that had pid 100: Windows keeps the dead parent's pid.
        { pid: 200, ppid: 100, startedAt: started - 3_600_000 },
        { pid: 201, ppid: 200, startedAt: started + 5_000 },
      ],
      isAlive: (pid) => pid === 100 && alive,
      now: () => started + 60_000,
      killTree: async () => {
        throw new Error("never taskkill /T on Windows");
      },
      killProcess: (pid) => {
        killed.push(pid);
        if (pid === 100) alive = false;
      },
      killGroup: () => {
        throw new Error("no process groups on Windows");
      },
    };
    const lockFile = runnerFile("runner.json");
    await assertSingleInstance(lockFile, {
      home,
      probe: async () => false,
      table: async () => [
        {
          pid: 100,
          ppid: 1,
          exe: null,
          commandLine: `node runner.js --home "${home}"`,
          cwd: null,
          startedAt: started,
        },
      ],
      ops,
    });
    removeOwnLock(lockFile);
    expect(killed).toEqual([100, 101, 102]);
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

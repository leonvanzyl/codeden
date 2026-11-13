import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HOME_RUNNER_ID, type RunnerRecord } from "@codeden/contracts";
import type { WSContext } from "hono/ws";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type Database, openDatabase } from "../src/db/client";
import { listRunnerRecords } from "../src/events/runner-projection";
import { EventStore } from "../src/events/store";
import { TerminalBridge } from "../src/realtime/terminals";
import { RunnerHub } from "../src/runner/hub";
import { BrowserService } from "../src/services/browser/browser-service";
import { type RunnerPort, type RunnerRouter, runnerUnavailable } from "../src/services/runner-port";
import type { SessionRepo } from "../src/services/sessions/repo";
import { sampleSession } from "./helpers";

let dir: string;
let database: Database;
let store: EventStore;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "codeden-runners-"));
  database = openDatabase(join(dir, "codeden.db"));
  store = new EventStore(database.db);
});

afterEach(() => {
  database.close();
  rmSync(dir, { recursive: true, force: true });
});

const ts = "2026-11-13T10:00:00.000Z";
const record = (over: Partial<RunnerRecord>): RunnerRecord => ({
  id: HOME_RUNNER_ID,
  backend: "local",
  home: true,
  runnerId: null,
  sandboxRef: null,
  projectId: null,
  sessionId: null,
  state: "starting",
  version: null,
  imageVersion: null,
  createdAt: ts,
  lastSeenAt: null,
  lastError: null,
  ...over,
});

const connected = (id: string | undefined, runnerId: string) =>
  store.append([
    {
      type: "runner.connected",
      sessionId: null,
      payload: { ...(id ? { id } : {}), runnerId, version: "1.0.0", protocolVersion: 1 },
    },
  ]);

const createSession = (id: string, runnerId: string | null) =>
  store.append([
    {
      type: "session.created",
      sessionId: id,
      payload: { session: { ...sampleSession, id, runnerId } },
    },
  ]);

describe("runners projection", () => {
  it("follows a runner through registered, connected, disconnected and deleted", () => {
    const sandbox = record({ id: "rn-1", backend: "docker", home: false, sandboxRef: "c1" });
    store.append([{ type: "runner.registered", sessionId: null, payload: { runner: sandbox } }]);
    connected("rn-1", "r-1");
    let [row] = listRunnerRecords(database.db);
    expect(row).toMatchObject({
      id: "rn-1",
      state: "connected",
      runnerId: "r-1",
      version: "1.0.0",
    });
    expect(row?.lastSeenAt).not.toBeNull();

    store.append([
      {
        type: "runner.disconnected",
        sessionId: null,
        payload: { id: "rn-1", runnerId: "r-1", reason: "connection closed" },
      },
    ]);
    [row] = listRunnerRecords(database.db);
    expect(row).toMatchObject({ state: "disconnected", lastError: "connection closed" });

    store.append([{ type: "runner.deleted", sessionId: null, payload: { id: "rn-1" } }]);
    [row] = listRunnerRecords(database.db);
    expect(row).toMatchObject({ state: "deleted", sandboxRef: "c1", runnerId: "r-1" });
  });

  it("applies runner events without a record id (older logs) to the home runner", () => {
    store.append([{ type: "runner.registered", sessionId: null, payload: { runner: record({}) } }]);
    connected(undefined, "r-home");
    expect(listRunnerRecords(database.db)).toMatchObject([
      { id: HOME_RUNNER_ID, home: true, state: "connected", runnerId: "r-home" },
    ]);
  });

  it("registers a runner only when it is new, deleted or changed (not on every restart)", async () => {
    const spec = {
      id: "rn-1",
      backend: "docker",
      dir,
      lockFile: join(dir, "none.json"),
      launch: null,
    } as const;
    const registered = () =>
      store.listAfter(0, 1_000).filter((e) => e.type === "runner.registered").length;
    const first = new RunnerHub({ db: database.db, store });
    first.add(spec);
    expect(registered()).toBe(1);
    // A server restart adds the same runner again.
    new RunnerHub({ db: database.db, store }).add(spec);
    expect(registered()).toBe(1);
    new RunnerHub({ db: database.db, store }).add({ ...spec, sandboxRef: "c2" });
    expect(registered()).toBe(2);
    await first.remove("rn-1", { deleted: true });
    new RunnerHub({ db: database.db, store }).add({ ...spec, sandboxRef: "c2" });
    expect(registered()).toBe(3);
    expect(listRunnerRecords(database.db)[0]).toMatchObject({
      state: "starting",
      sandboxRef: "c2",
    });
  });
});

describe("RunnerHub routing", () => {
  function hub() {
    const runners = new RunnerHub({ db: database.db, store });
    const lock = join(dir, "none.json");
    runners.add({
      id: HOME_RUNNER_ID,
      backend: "local",
      home: true,
      dir,
      lockFile: lock,
      launch: null,
    });
    runners.add({ id: "rn-1", backend: "docker", dir, lockFile: lock, launch: null });
    connected(HOME_RUNNER_ID, "r-home");
    connected("rn-1", "r-1");
    return runners;
  }

  it("routes by sessions.runnerId, and to the home runner when there is none or no record has it", () => {
    const runners = hub();
    createSession("unplaced", null);
    createSession("legacy", "r-from-a-reset-journal");
    createSession("at-home", "r-home");
    createSession("on-1", "r-1");
    for (const id of ["unplaced", "legacy", "at-home", "missing-session"]) {
      expect(runners.forSession(id)).toBe(runners.home());
    }
    const port = runners.forSession("on-1");
    expect(port).not.toBe(runners.home());
    expect(port.describe?.()).toBe("Runner rn-1 (docker, runner r-1)");
    expect(runners.forRunnerId("r-1")).toBe(port);
    expect(runners.list().map((r) => r.id)).toEqual([HOME_RUNNER_ID, "rn-1"]);
  });

  it("fails commands for a session whose runner is not connected, naming that runner", async () => {
    const runners = hub();
    createSession("on-1", "r-1");
    const live = runners.forSession("on-1");
    // The live client's errors name the runner's journal id, as the record's do.
    await expect(live.request({ name: "runner.status" })).rejects.toMatchObject({
      code: "runner_unavailable",
      message: "Runner rn-1 (docker, runner r-1) is not connected",
    });
    expect(runnerUnavailable(live).message).toBe(
      "Runner rn-1 (docker, runner r-1) is not connected",
    );
    await runners.remove("rn-1", { deleted: true });
    const gone = runners.forSession("on-1");
    expect(gone).not.toBe(runners.home());
    await expect(gone.request({ name: "runner.status" })).rejects.toMatchObject({
      code: "runner_unavailable",
      message: "Runner rn-1 (docker, runner r-1) is not available (deleted)",
    });
  });
});

/** A runner port that records the command names it was sent. */
function recording(tag: string, calls: string[]): RunnerPort {
  return {
    isConnected: () => true,
    runnerId: () => tag,
    providers: () => [],
    mcpProxyUrl: () => null,
    waitForConnection: async () => true,
    request: (async (command: { name: string }) => {
      calls.push(`${tag}:${command.name}`);
      if (command.name === "pty.open") return { pid: 1 };
      if (command.name === "browser.tabs.list") return { tabs: [], engine: "runner" };
      return {};
    }) as RunnerPort["request"],
  };
}

describe("terminal and browser routing", () => {
  const calls: string[] = [];
  const home = recording("home", calls);
  const remote = recording("rn-1", calls);
  const runners: RunnerRouter = {
    home: () => home,
    forSession: (id) => (id === "on-1" ? remote : home),
    forRunnerId: () => home,
  };
  const tick = () => new Promise((r) => setTimeout(r, 0));

  beforeEach(() => {
    calls.length = 0;
  });

  it("opens a session's terminal on its runner and keeps talking to that runner", async () => {
    const bridge = new TerminalBridge({ runner: home, runners, cwdFor: () => dir });
    const sent: string[] = [];
    const ws = { send: (d: string) => sent.push(d), close: () => {} } as unknown as WSContext;
    const events = bridge.handlers({ sessionId: "on-1", cols: 80, rows: 24 });
    events.onOpen?.(new Event("open"), ws);
    await tick();
    events.onMessage?.(
      new MessageEvent("message", { data: JSON.stringify({ type: "input", data: "ls\r" }) }),
      ws,
    );
    await tick();
    const plain = bridge.handlers({ cols: 80, rows: 24 });
    plain.onOpen?.(new Event("open"), ws);
    await tick();
    expect(calls).toEqual(["rn-1:pty.open", "rn-1:pty.input", "home:pty.open"]);
  });

  it("sends a session's browser commands to its runner", async () => {
    const repo = { get: () => sampleSession, find: () => ({ session: sampleSession }) };
    const browser = new BrowserService({
      runner: home,
      runners,
      repo: repo as unknown as SessionRepo,
    });
    await browser.tabs("on-1");
    await browser.tabs("other");
    expect(calls).toEqual(["rn-1:browser.tabs.list", "home:browser.tabs.list"]);
  });
});

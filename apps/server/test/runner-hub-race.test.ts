import { mkdtempSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Duplex } from "node:stream";
import { CODEDEN_VERSION, RUNNER_PROTOCOL_VERSION, type RunnerLock } from "@codeden/contracts";
import { type RunningRunner, startRunner } from "@codeden/runner";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import WebSocket from "ws";
import { type Database, openDatabase } from "../src/db/client";
import { EventStore } from "../src/events/store";
import { RunnerClient } from "../src/runner/client";
import { RunnerHub } from "../src/runner/hub";
import { removeTree } from "./support/remove-tree";

/**
 * A runner removed (or the hub closed) while its client is still finding and connecting to
 * it: the late handshake must not leave a connected client behind, record `runner.connected`
 * after `runner.deleted`, or keep answering commands once the hub is closed. One in-process
 * runner with the Fake provider; `start()` is called and the hub torn down in the same tick,
 * so the connection is always still in flight.
 */

let dir: string;
let database: Database;
let store: EventStore;
let runner: RunningRunner;
const clients: RunnerClient[] = [];

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "codeden-hub-race-"));
  database = openDatabase(join(dir, "codeden.db"));
  store = new EventStore(database.db);
  runner = await startRunner({ home: join(dir, "runner"), enableFakeProvider: true });
});

afterEach(async () => {
  vi.restoreAllMocks();
  for (const client of clients.splice(0)) await client.stop();
  await runner.close();
  database.close();
  await removeTree(dir);
});

function addRunner(hub: RunnerHub): RunnerClient {
  const client = hub.add({
    id: "rn-1",
    backend: "local",
    dir: join(dir, "runner"),
    lockFile: runner.lockFile,
    launch: null,
  });
  clients.push(client);
  return client;
}

const runnerEvents = () =>
  store
    .listAfter(0, 1_000)
    .map((e) => e.type)
    .filter((type) => type.startsWith("runner."));

/** Whether the runner still answers through this client. */
const answers = (client: RunnerClient) =>
  client.request({ name: "runner.status" }, 5_000).then(
    () => true,
    () => false,
  );

describe("RunnerHub while a runner connects", () => {
  it("removing a runner mid-connect leaves no connected client and nothing answering", async () => {
    const hub = new RunnerHub({ db: database.db, store });
    const client = addRunner(hub);
    const started = client.start().catch(() => undefined);
    await hub.remove("rn-1", { deleted: true });
    await started;

    expect(client.status.state).not.toBe("connected");
    expect(runnerEvents()).toEqual(["runner.registered", "runner.deleted"]);
    expect(hub.list().find((r) => r.id === "rn-1")?.state).toBe("deleted");

    await hub.close();
    expect(await answers(client)).toBe(false);
  });

  it("removing a runner during its handshake discards the connection", async () => {
    const hub = new RunnerHub({ db: database.db, store });
    const client = addRunner(hub);
    // Remove the runner the moment the client says hello, before the runner's welcome arrives.
    let removed: Promise<void> | undefined;
    const realSend = WebSocket.prototype.send as (this: WebSocket, ...args: unknown[]) => void;
    vi.spyOn(WebSocket.prototype, "send").mockImplementation(function (
      this: WebSocket,
      ...args: unknown[]
    ) {
      realSend.apply(this, args);
      const [data] = args;
      if (!removed && typeof data === "string" && data.includes('"type":"hello"')) {
        removed = hub.remove("rn-1", { deleted: true });
      }
    } as never);
    await client.start().catch(() => undefined);
    expect(removed).toBeDefined();
    await removed;

    expect(client.status.state).not.toBe("connected");
    expect(runnerEvents()).toEqual(["runner.registered", "runner.deleted"]);
    await hub.close();
    expect(await answers(client)).toBe(false);
  });

  it("closing the hub mid-connect leaves nothing answering", async () => {
    const hub = new RunnerHub({ db: database.db, store });
    const client = addRunner(hub);
    const started = client.start().catch(() => undefined);
    await hub.close();
    await started;

    expect(client.status.state).not.toBe("connected");
    expect(runnerEvents()).not.toContain("runner.connected");
    expect(await answers(client)).toBe(false);
  });
});

describe("RunnerClient stopped while the runner's WebSocket upgrade hangs", () => {
  it("drops the socket at once instead of waiting for the upgrade", async () => {
    // Answers `/health` like a live runner, but never answers the WebSocket upgrade.
    const token = "u".repeat(32);
    const upgrades: Duplex[] = [];
    let onUpgrade: () => void = () => undefined;
    const upgrading = new Promise<void>((resolve) => {
      onUpgrade = resolve;
    });
    const http = createServer((req, res) => {
      res.writeHead(req.headers.authorization === `Bearer ${token}` ? 200 : 401).end();
    });
    http.on("upgrade", (_req, socket: Duplex) => {
      socket.on("error", () => undefined);
      upgrades.push(socket);
      onUpgrade();
    });
    await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
    try {
      const lock: RunnerLock = {
        pid: process.pid,
        port: (http.address() as AddressInfo).port,
        token,
        version: CODEDEN_VERSION,
        protocolVersion: RUNNER_PROTOCOL_VERSION,
        runnerId: "r-hung",
        startedAt: new Date().toISOString(),
        providers: [],
      };
      const lockFile = join(dir, "hung-runner.json");
      writeFileSync(lockFile, JSON.stringify(lock));
      const client = new RunnerClient({
        db: database.db,
        store,
        home: dir,
        lockFile,
        launch: null,
      });
      clients.push(client);
      const started = client.start().then(
        () => null,
        (error: Error) => error,
      );
      await upgrading;
      const socket = upgrades[0] as Duplex;
      // The server keeps its side half-open: the client's end shows as `end`, not `close`.
      const dropped = new Promise<void>((resolve) => socket.once("end", () => resolve()));
      socket.resume();

      // Without cancellation this would wait for an upgrade that never comes.
      await client.stop();
      await dropped;
      expect((await started)?.message).toBe("Runner was stopped while connecting");
      expect(client.status.state).not.toBe("connected");
      expect(runnerEvents()).toEqual([]);
    } finally {
      for (const socket of upgrades) socket.destroy();
      await new Promise<void>((resolve) => http.close(() => resolve()));
    }
  });
});

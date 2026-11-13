import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type RunningRunner, startRunner } from "@codeden/runner";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import WebSocket from "ws";
import { type Database, openDatabase } from "../src/db/client";
import { EventStore } from "../src/events/store";
import type { RunnerClient } from "../src/runner/client";
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

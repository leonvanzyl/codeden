import { copyFileSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HOME_RUNNER_ID, type RunnerEvent, type RunnerStream } from "@codeden/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type Database, openDatabase } from "../src/db/client";
import { lastAckedSeq } from "../src/events/ingest";
import { findRunnerRecord } from "../src/events/runner-projection";
import { EventStore } from "../src/events/store";
import { RunnerHub } from "../src/runner/hub";
import { sampleSession } from "./helpers";
import { type FakeRunner, startFakeRunner } from "./support/fake-runner";
import { waitUntil } from "./support/harness";
import { type InProcessLink, startInProcessLink } from "./support/in-process-link";

/**
 * A sandbox runner reached through an exec link is as untrusted as one on loopback
 * (`runner-trust.test.ts`, `docs/remote-runners.md` §8): the same guard applies to what crosses
 * the link. A scripted runner sits behind `codeden runner-link`'s code, run in this process
 * over in-memory pipes, and sends what a compromised sandbox runner could.
 */

let dir: string;
let database: Database;
let store: EventStore;
let hub: RunnerHub | undefined;
let streams: RunnerStream[];
let links: InProcessLink[];
const runners: FakeRunner[] = [];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "codeden-exec-trust-"));
  database = openDatabase(join(dir, "codeden.db"));
  store = new EventStore(database.db);
  streams = [];
  links = [];
});

afterEach(async () => {
  await hub?.close();
  hub = undefined;
  for (const runner of runners.splice(0)) await runner.close();
  database.close();
  rmSync(dir, { recursive: true, force: true });
});

const createSession = (id: string, runnerId: string | null) =>
  store.append([
    {
      type: "session.created",
      sessionId: id,
      payload: { session: { ...sampleSession, id, runnerId } },
    },
  ]);

/**
 * The home runner (journal `r-home`, on loopback, connected) and a sandbox runner `rn-1` (not
 * started) that claims `sandboxClaims` and is reached only through exec links.
 */
async function homeAndLinkedSandbox(sandboxClaims: string) {
  const home = await startFakeRunner(dir, "r-home");
  const sandbox = await startFakeRunner(dir, sandboxClaims);
  runners.push(home, sandbox);
  // What the link reads next to the runner: `<home>/runner/runner.json`.
  const sandboxHome = join(dir, "sandbox");
  mkdirSync(join(sandboxHome, "runner"), { recursive: true });
  const lockFile = join(sandboxHome, "runner", "runner.json");
  copyFileSync(sandbox.lockFile, lockFile);

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
    dir: sandboxHome,
    lockFile,
    launch: null,
    sessionId: "sbx-s",
    link: {
      kind: "exec",
      start: () => {
        const link = startInProcessLink(sandboxHome);
        links.push(link);
        return link;
      },
    },
  });
  await homeClient.start();
  return { home, sandbox, sandboxClient };
}

const thread = (sessionId: string, id: string): RunnerEvent => ({
  kind: "agent",
  sessionId,
  event: { type: "thread.started", thread: { id } },
});

const eventsFor = (sessionId: string, after: number) =>
  store.listAfter(after, 10_000).filter((e) => e.sessionId === sessionId);

const linkExit = (link: InProcessLink | undefined) =>
  new Promise<number | null>((resolve) => link?.onExit(resolve));

describe("a sandbox runner over an exec link", () => {
  it("gets its own sessions' events and streams through; others are dropped, events acked", async () => {
    createSession("home-s", "r-home");
    const { sandbox, sandboxClient } = await homeAndLinkedSandbox("r-1");
    await sandboxClient.start();
    createSession("sbx-s", "r-1");
    expect(sandboxClient.linkPid).toBeUndefined(); // in-process: no child process
    expect(links).toHaveLength(1);
    const before = store.headSeq();

    await sandbox.send(1, thread("sbx-s", "t-sbx"));
    await sandbox.send(2, thread("home-s", "t-evil"));
    await sandbox.send(3, {
      kind: "session.process",
      sessionId: "home-s",
      state: "crashed",
      error: { message: "forged crash" },
    });
    expect(eventsFor("sbx-s", before).map((e) => e.type)).toContain("agent.thread.started");
    expect(eventsFor("home-s", before)).toEqual([]);
    expect(sandbox.acked).toEqual([1, 2, 3]);
    expect(lastAckedSeq(database.db, "r-1")).toBe(3);

    await sandboxClient.request({ name: "pty.open", ptyId: "p-sbx", cwd: "/", cols: 80, rows: 24 });
    sandbox.stream({ kind: "pty.output", ptyId: "p-home", data: "forged prompt$ " });
    sandbox.stream({ kind: "browser.tabs", sessionId: "home-s", tabs: [] });
    sandbox.stream({ kind: "pty.output", ptyId: "p-sbx", data: "$ " });
    sandbox.stream({ kind: "browser.tabs", sessionId: "sbx-s", tabs: [] });
    await waitUntil(() => streams.length >= 2, 15_000);
    expect(streams).toEqual([
      { kind: "pty.output", ptyId: "p-sbx", data: "$ " },
      { kind: "browser.tabs", sessionId: "sbx-s", tabs: [] },
    ]);
    expect(sandboxClient.status.state).toBe("connected");
    expect(links).toHaveLength(1);
  });

  it("is refused under another runner's journal id, and each refused link is closed", async () => {
    createSession("home-s", "r-home");
    const { home, sandbox, sandboxClient } = await homeAndLinkedSandbox("r-home");
    await home.send(1, thread("home-s", "t-1"));
    const before = store.headSeq();

    void sandboxClient.start().catch(() => undefined);
    await waitUntil(() => sandboxClient.status.lastError?.includes("refused"), 15_000);
    expect(sandboxClient.status.lastError).toBe(
      "Runner rn-1 (docker) was refused: journal id r-home belongs to runner home",
    );
    // The link that carried the refused welcome was let go: its stdin ended, so it said
    // goodbye to the runner and exited as closed (0), leaving no link behind.
    expect(await linkExit(links[0])).toBe(0);

    // Events it sends meanwhile count for nothing.
    await sandbox.send(1_000, thread("home-s", "t-evil"));
    await home.send(2, {
      kind: "agent",
      sessionId: "home-s",
      event: { type: "turn.started", threadId: "t-1", turnId: "u-1" },
    });
    const stored = eventsFor("home-s", before);
    expect(stored.map((e) => e.type)).toContain("agent.turn.started");
    expect(JSON.stringify(stored)).not.toContain("t-evil");
    expect(sandbox.acked).toEqual([]);
    expect(lastAckedSeq(database.db, "r-home")).toBe(2);
    expect(sandboxClient.status.state).not.toBe("connected");
    expect(findRunnerRecord(database.db, "rn-1")?.runnerId).toBeNull();
    expect(hub?.forSession("home-s")).toBe(hub?.home());
  });
});

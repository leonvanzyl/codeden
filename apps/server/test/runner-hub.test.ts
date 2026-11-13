import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Session, Snapshot } from "@codeden/contracts";
import { type RunningRunner, startRunner } from "@codeden/runner";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type RunningServer, startServer } from "../src";
import { runnerState } from "../src/db/schema";
import type { RunnerClient } from "../src/runner/client";
import type { Exec } from "../src/services/exec";
import { sampleSession } from "./helpers";
import { waitUntil } from "./support/harness";
import { removeTree } from "./support/remove-tree";

/**
 * Two in-process runners with the Fake provider (`docs/remote-runners.md` §18, phase 1): the
 * home runner A at the server's data directory, and runner B elsewhere, added to the hub.
 * Commands for a session go to the runner in `sessions.runnerId`.
 */

const TOKEN = "f".repeat(64);
const auth = { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" };

/** No CLI is installed (setup checks never reach the machine's real tools). */
const nothingInstalled: Exec = async () => ({
  code: null,
  stdout: "",
  stderr: "",
  notFound: true,
  timedOut: false,
  path: null,
});

let home: string;
let dirB: string;
let runnerA: RunningRunner;
let runnerB: RunningRunner | undefined;
let server: RunningServer;
let clientB: RunnerClient;
let runnerIdA: string;
let runnerIdB: string;

beforeEach(async () => {
  home = mkdtempSync(join(tmpdir(), "codeden-hub-a-"));
  dirB = mkdtempSync(join(tmpdir(), "codeden-hub-b-"));
  runnerA = await startRunner({ home, enableFakeProvider: true });
  runnerB = await startRunner({ home: dirB, enableFakeProvider: true });
  server = await startServer({
    port: 0,
    dataDir: home,
    token: TOKEN,
    waitForRunner: true,
    secrets: "memory",
    checkSetupOnStart: false,
    userHome: home,
    exec: nothingInstalled,
    github: { sync: false },
  });
  clientB = server.runners.add({
    id: "rn-b",
    backend: "local",
    dir: dirB,
    lockFile: runnerB.lockFile,
    launch: null,
  });
  await clientB.start();
  runnerIdA = server.runner?.status.runnerId as string;
  runnerIdB = clientB.status.runnerId as string;
});

afterEach(async () => {
  await server.close();
  await runnerA.close();
  await runnerB?.close();
  await removeTree(home);
  await removeTree(dirB);
});

/** Start a Fake session placed on `runnerId` (null: not placed, so the home runner). */
async function startSession(id: string, runnerId: string | null, text: string): Promise<void> {
  const { sessionRepo, sessions } = server.services;
  const session: Session = { ...sampleSession, id, status: "queued", runnerId };
  sessionRepo.create(session, {
    workspaceMode: "worktree",
    workspaceFallback: null,
    forced: null,
    queuedBehind: [],
    pending: { input: { text, attachments: [] }, workspace: { mode: "worktree" } },
  });
  sessions.startQueued(session);
  await sessions.launching.get(id);
  await waitUntil(() =>
    server.store
      .listAfter(0, 10_000, [id])
      .some((e) => e.type === "agent.turn.completed" && e.sessionId === id),
  );
}

const hosted = async (client: Pick<RunnerClient, "request">) =>
  (await client.request({ name: "runner.status" })).sessions.map((s) => s.sessionId);

describe("several runners", () => {
  it("sends a session's commands to its own runner and stores both runners' events", async () => {
    expect(runnerIdA).toBeTruthy();
    expect(runnerIdB).toBeTruthy();
    expect(runnerIdB).not.toBe(runnerIdA);

    await startSession("s-b", runnerIdB, "hello B");
    await startSession("s-a", null, "hello A");

    const homeClient = server.runner as RunnerClient;
    expect(await hosted(clientB)).toEqual(["s-b"]);
    expect(await hosted(homeClient)).toEqual(["s-a"]);
    expect(server.services.sessionRepo.get("s-b").runnerId).toBe(runnerIdB);
    expect(server.services.sessionRepo.get("s-a").runnerId).toBe(runnerIdA);

    // Both runners' events are stored, and acked per runner id.
    for (const [client, runnerId] of [
      [clientB, runnerIdB],
      [homeClient, runnerIdA],
    ] as const) {
      const journal = await waitUntil(async () => {
        const status = await client.request({ name: "runner.status" });
        return status.journal.unacked === 0 ? status.journal : undefined;
      });
      const acked = server.database.db
        .select()
        .from(runnerState)
        .all()
        .find((r) => r.runnerId === runnerId);
      expect(acked?.lastAckedSeq).toBe(journal.lastSeq);
    }

    // The UI hears about both runners; the single-runner view is still the home runner.
    const res = await fetch(`${server.url}/api/snapshot`, { headers: auth });
    const snapshot = Snapshot.parse(await res.json());
    expect(snapshot.runner.runnerId).toBe(runnerIdA);
    expect(snapshot.runners.map((r) => [r.id, r.backend, r.home, r.state, r.runnerId])).toEqual([
      ["home", "local", true, "connected", runnerIdA],
      ["rn-b", "local", false, "connected", runnerIdB],
    ]);

    // A later message goes to the same runner, and only that runner.
    await server.services.sessions.send("s-b", {
      input: { text: "again B", attachments: [] },
      whenBusy: "queue",
    });
    await waitUntil(
      () =>
        server.store.listAfter(0, 10_000, ["s-b"]).filter((e) => e.type === "agent.turn.completed")
          .length === 2,
    );
    expect(await hosted(homeClient)).toEqual(["s-a"]);
  }, 60_000);

  it("fails a session whose runner is gone with runner_unavailable naming that runner", async () => {
    await startSession("s-b", runnerIdB, "hello B");
    await runnerB?.close();
    runnerB = undefined;
    await waitUntil(() => clientB.status.state !== "connected");

    const send = () =>
      fetch(`${server.url}/api/sessions/s-b/messages`, {
        method: "POST",
        headers: auth,
        body: JSON.stringify({ input: { text: "anyone there?", attachments: [] } }),
      });
    const disconnected = await send();
    expect(disconnected.status).toBe(503);
    const lost = (await disconnected.json()) as { error: { code: string; message: string } };
    expect(lost.error.code).toBe("runner_unavailable");
    expect(lost.error.message).toContain("rn-b");
    expect(lost.error.message).not.toMatch(/\bhome\b/);

    // Its sandbox deleted: the record stays, so the session still names the runner it lost.
    await server.runners.remove("rn-b", { deleted: true });
    const deleted = await send();
    expect(deleted.status).toBe(503);
    const gone = (await deleted.json()) as { error: { code: string; message: string } };
    expect(gone.error.code).toBe("runner_unavailable");
    expect(gone.error.message).toContain("rn-b");
    expect(gone.error.message).toContain("deleted");
    expect(server.runners.list().find((r) => r.id === "rn-b")?.state).toBe("deleted");

    // The home runner's sessions are unaffected.
    await startSession("s-a", null, "hello A");
    expect(server.services.sessionRepo.get("s-a").runnerId).toBe(runnerIdA);
  }, 60_000);
});

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { type RunningRunner, startRunner } from "@codeden/runner";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type RunningServer, startServer } from "../src";
import { runnerState } from "../src/db/schema";
import type { RunnerClient } from "../src/runner/client";
import type { Exec } from "../src/services/exec";
import { waitUntil } from "./support/harness";
import { type InProcessLink, startInProcessLink } from "./support/in-process-link";
import { countEvents, startStreamingTurn, storedReply } from "./support/link-turn";
import { removeTree } from "./support/remove-tree";

/**
 * The `exec` transport (`docs/remote-runners.md` §18, phase 2) against an in-process runner with
 * the Fake provider: the server reaches it only through a link (`codeden runner-link`'s code,
 * run in this process over in-memory pipes, so no child process is started here). The same
 * path with the real CLI process is `runner-link-process.test.ts` (`pnpm test:slow`).
 */

const TOKEN = "f".repeat(64);

const nothingInstalled: Exec = async () => ({
  code: null,
  stdout: "",
  stderr: "",
  notFound: true,
  timedOut: false,
  path: null,
});

let home: string;
let runnerHome: string;
let runner: RunningRunner;
let server: RunningServer;
let client: RunnerClient;
let links: InProcessLink[];

beforeEach(async () => {
  home = mkdtempSync(join(tmpdir(), "codeden-link-server-"));
  runnerHome = mkdtempSync(join(tmpdir(), "codeden-link-runner-"));
  runner = await startRunner({ home: runnerHome, enableFakeProvider: true });
  server = await startServer({
    port: 0,
    dataDir: home,
    token: TOKEN,
    runner: false,
    secrets: "memory",
    checkSetupOnStart: false,
    userHome: home,
    exec: nothingInstalled,
    github: { sync: false },
  });
  links = [];
  client = server.runners.add({
    id: "rn-link",
    backend: "local",
    dir: runnerHome,
    lockFile: runner.lockFile,
    launch: null,
    link: {
      kind: "exec",
      start: () => {
        const link = startInProcessLink(runnerHome);
        links.push(link);
        return link;
      },
    },
  });
  await client.start();
});

afterEach(async () => {
  await server.close();
  await runner.close();
  await removeTree(home);
  await removeTree(runnerHome);
});

const count = (sessionId: string, type: string) => countEvents(server, sessionId, type);

describe("exec link transport", () => {
  it("handshakes over the link and learns where the runner runs", async () => {
    expect(client.status.state).toBe("connected");
    expect(client.hostInfo).toEqual({
      platform: process.platform,
      arch: process.arch,
      home: resolve(runnerHome),
      backend: "local",
    });
    const status = await client.request({ name: "runner.status" });
    expect(status.journal.unacked).toBe(0);
    expect(links).toHaveLength(1);
    expect(links[0]?.log()).toContain("linked to runner");
  });

  it("survives the link being killed mid-turn: re-links, resumes by seq, stores no duplicates", async () => {
    const runnerId = client.status.runnerId as string;
    const id = "s-link";
    await startStreamingTurn(server, id, runnerId);

    // Kill the link while the turn streams.
    await waitUntil(() => count(id, "agent.item.delta") >= 3);
    expect(count(id, "agent.turn.completed")).toBe(0);
    links[0]?.kill();

    // The server opens a new link and the runner replays what was not acked.
    await waitUntil(() => links.length === 2 && client.status.state === "connected");
    await waitUntil(() => count(id, "agent.turn.completed") === 1, 30_000);
    expect(count(id, "agent.turn.started")).toBe(1);

    // Every word exactly once: nothing replayed twice, nothing lost.
    const reply = storedReply(server, id);
    expect(reply.streamed).toBe(reply.completed);
    expect(reply.streamed).toContain("w299");

    // Everything the runner journaled is stored and acked.
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

    // The drop is on record, with why the link ended.
    const disconnected = server.store
      .listAfter(0, 100_000)
      .filter((e) => e.type === "runner.disconnected");
    expect(disconnected).toHaveLength(1);
    expect(disconnected[0]?.payload).toMatchObject({ id: "rn-link", runnerId });
    expect(JSON.stringify(disconnected[0]?.payload)).toContain("killed");
  }, 60_000);

  it("closes the link cleanly when the server lets go, and the runner keeps running", async () => {
    const exit = new Promise<number | null>((done) => links[0]?.onExit(done));
    await server.runners.remove("rn-link");
    expect(await exit).toBe(0); // RunnerLinkExit.closed: stdin ended
    const health = await fetch(`http://127.0.0.1:${runner.port}/health`, {
      headers: { authorization: `Bearer ${runner.token}` },
    });
    expect(health.ok).toBe(true);
  });
});

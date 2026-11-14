import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  encodeLinkFrame,
  RUNNER_PROTOCOL_VERSION,
  RunnerLinkExit,
  RunnerToServerMessage,
} from "@codeden/contracts";
import { type RunningRunner, startRunner } from "@codeden/runner";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type RunningServer, startServer } from "../src";
import { runnerState } from "../src/db/schema";
import type { RunnerClient } from "../src/runner/client";
import { type LinkProcess, spawnLinkProcess } from "../src/runner/transport-exec";
import type { Exec } from "../src/services/exec";
import { waitUntil } from "./support/harness";
import { countEvents, startStreamingTurn, storedReply } from "./support/link-turn";
import { removeTree } from "./support/remove-tree";

/**
 * The real `codeden runner-link` process (`docs/remote-runners.md` §18, phase 2), started from
 * the CLI source through tsx, against an in-process Fake runner. Slow suite (`pnpm test:slow`):
 * each link is a Node.js process that loads the CLI. The in-process twin is
 * `runner-exec-link.test.ts`.
 */

const TOKEN = "f".repeat(64);
const CLI = join(import.meta.dirname, "..", "..", "cli", "src", "cli.ts");
const TSX = import.meta.resolve("tsx");
const linkArgs = (home: string) => ["--import", TSX, CLI, "runner-link", "--home", home];

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
let server: RunningServer | undefined;

beforeEach(async () => {
  home = mkdtempSync(join(tmpdir(), "codeden-linkp-server-"));
  runnerHome = mkdtempSync(join(tmpdir(), "codeden-linkp-runner-"));
  runner = await startRunner({ home: runnerHome, enableFakeProvider: true });
});

afterEach(async () => {
  await server?.close();
  server = undefined;
  await runner.close();
  await removeTree(home);
  await removeTree(runnerHome);
});

/** Spawn `codeden runner-link` and collect its stdout and stderr. */
function spawnLink(linkHome: string) {
  const child = spawn(process.execPath, linkArgs(linkHome), {
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8").on("data", (text: string) => {
    stdout += text;
  });
  child.stderr.setEncoding("utf8").on("data", (text: string) => {
    stderr += text;
  });
  const exit = new Promise<number | null>((resolve) => child.once("close", resolve));
  return { child, exit, stdout: () => stdout, stderr: () => stderr };
}

describe("codeden runner-link (real process)", () => {
  it("writes only protocol frames to stdout, and exits 0 when stdin ends", async () => {
    const link = spawnLink(runnerHome);
    link.child.stdin.write(
      encodeLinkFrame({
        type: "hello",
        protocolVersion: RUNNER_PROTOCOL_VERSION,
        serverVersion: "test",
      }),
    );
    // Starting Node.js with tsx on the CLI source is slow on a busy machine.
    await waitUntil(() => link.stdout().includes("\n"), 240_000);
    link.child.stdin.write(encodeLinkFrame({ type: "resume", lastAckedSeq: 0 }));
    link.child.stdin.write(
      encodeLinkFrame({ type: "command", id: "c1", command: { name: "runner.status" } }),
    );
    await waitUntil(() => link.stdout().includes('"id":"c1"'), 30_000);
    link.child.stdin.end();
    expect(await link.exit).toBe(RunnerLinkExit.closed);

    const lines = link.stdout().split("\n");
    expect(lines.pop()).toBe("");
    expect(lines.length).toBeGreaterThanOrEqual(3);
    for (const line of lines) {
      expect(RunnerToServerMessage.safeParse(JSON.parse(line)).success).toBe(true);
    }
    expect(link.stderr()).not.toContain(runner.token);
  }, 300_000);

  it("exits 3 when no runner is running", async () => {
    const empty = mkdtempSync(join(tmpdir(), "codeden-linkp-empty-"));
    try {
      const link = spawnLink(empty);
      expect(await link.exit).toBe(RunnerLinkExit.noRunner);
      expect(link.stdout()).toBe("");
      expect(link.stderr()).toContain("no runner is running");
    } finally {
      await removeTree(empty);
    }
  }, 300_000);

  it("carries a turn for the server, and survives the link process being killed", async () => {
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
    const links: LinkProcess[] = [];
    const client: RunnerClient = server.runners.add({
      id: "rn-proc",
      backend: "local",
      dir: runnerHome,
      lockFile: runner.lockFile,
      launch: null,
      link: {
        kind: "exec",
        start: () => {
          const link = spawnLinkProcess(process.execPath, linkArgs(runnerHome));
          links.push(link);
          return link;
        },
      },
    });
    await client.start();
    const runnerId = client.status.runnerId as string;
    expect(client.linkPid).toBe(links[0]?.pid);

    const id = "s-proc";
    await startStreamingTurn(server, id, runnerId, 600);
    await waitUntil(() => countEvents(server as RunningServer, id, "agent.item.delta") >= 3);
    expect(countEvents(server, id, "agent.turn.completed")).toBe(0);
    process.kill(links[0]?.pid as number);

    await waitUntil(() => links.length === 2 && client.status.state === "connected", 240_000);
    await waitUntil(
      () => countEvents(server as RunningServer, id, "agent.turn.completed") === 1,
      60_000,
    );
    expect(countEvents(server, id, "agent.turn.started")).toBe(1);
    const reply = storedReply(server, id);
    expect(reply.streamed).toBe(reply.completed);
    expect(reply.streamed).toContain("w599");

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
  }, 600_000);
});

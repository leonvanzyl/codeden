import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CreateProjectResponse,
  type SessionOptions,
  StartSessionResponse,
} from "@codeden/contracts";
import { FakeProvider, type ProviderAdapter, type ProviderSession } from "@codeden/providers";
import { type RunningRunner, startRunner } from "@codeden/runner";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type RunningServer, type StartServerOptions, startServer } from "../src";
import { waitUntil } from "./support/harness";
import { removeTree } from "./support/remove-tree";

/**
 * #208: an agent keeps the MCP bearer token its provider process was opened with, and the
 * runner's proxy forwards it. A session that outlives a CodeDen restart, or is reopened after
 * one, must still have that token accepted; a stopped session's token stays revoked.
 */

const TOKEN = "f".repeat(64);
/** A turn long enough to still be running across a restart (one Fake delta per word). */
const LONG = Array.from({ length: 600 }, (_, i) => `w${i}`).join(" ");

/** One provider process the runner opened (a start or a resume) and the token it was given. */
interface Open {
  sessionId: string;
  token: string;
  release(): void;
  refuse(error: Error): void;
}

/**
 * The Fake provider, whose opens can be held until the test releases them: a real provider
 * takes seconds to start its CLI and reopen the conversation. Records every open's token.
 */
function heldFake(opts: { hold: boolean }) {
  const inner = new FakeProvider({ delayMs: 15 });
  const opens: Open[] = [];
  const adapter: ProviderAdapter = {
    id: inner.id,
    displayName: inner.displayName,
    detect: () => inner.detect(),
    capabilities: () => inner.capabilities(),
    models: () => inner.models(),
    openSession: (options: SessionOptions) =>
      new Promise<ProviderSession>((resolve, reject) => {
        const open: Open = {
          sessionId: options.sessionId,
          token: bearerOf(options),
          release: () => resolve(inner.openSession(options)),
          refuse: reject,
        };
        opens.push(open);
        if (!opts.hold) open.release();
      }),
  };
  const last = (sessionId: string) => opens.filter((o) => o.sessionId === sessionId).at(-1);
  return { adapter, opens, last };
}

function bearerOf(options: SessionOptions): string {
  const http = options.mcpServers.find((s) => s.transport === "http");
  const auth = http?.transport === "http" ? http.headers?.Authorization : undefined;
  if (!auth) throw new Error("the session was opened without CodeDen's MCP server");
  return auth.replace(/^Bearer\s+/i, "");
}

let home: string;
let runner: RunningRunner | undefined;
let server: RunningServer | undefined;
let projectId: string;

const options = (): StartServerOptions => ({
  port: 0,
  dataDir: home,
  token: TOKEN,
  waitForRunner: true,
  secrets: "memory",
  checkSetupOnStart: false,
  userHome: home,
  realtimeFlushMs: 10,
});

function current(): RunningServer {
  if (!server) throw new Error("no server");
  return server;
}

async function startServerOnHome(): Promise<void> {
  server = await startServer(options());
  await waitUntil(() => server?.runner?.mcpProxyUrl ?? undefined);
}

/** An in-process runner on the home (it outlives server restarts), then a server on it. */
async function boot(fake: ReturnType<typeof heldFake>): Promise<void> {
  runner = await startRunner({ home, adapters: [fake.adapter] });
  await startServerOnHome();
}

/** Stop the server, then its runner: an upgrade or a reboot, where both restart. */
async function stopAll(): Promise<void> {
  await server?.close();
  server = undefined;
  await runner?.close();
  runner = undefined;
}

async function api(method: string, path: string, body?: unknown): Promise<unknown> {
  const res = await fetch(`${current().url}/api${path}`, {
    method,
    headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return res.json();
}

async function addProject(): Promise<void> {
  const repo = join(home, "repo");
  mkdirSync(repo);
  const git = (...args: string[]) => execFileSync("git", ["-C", repo, ...args], { stdio: "pipe" });
  git("init", "-q", "-b", "main");
  git("config", "user.email", "test@example.com");
  git("config", "user.name", "Test");
  writeFileSync(join(repo, "README.md"), "# test\n");
  git("add", ".");
  git("commit", "-q", "-m", "init");
  const created = CreateProjectResponse.parse(
    await api("POST", "/projects", { source: { type: "local", path: repo } }),
  );
  projectId = created.project.id;
}

const status = (id: string) => current().services.sessionRepo.get(id).status;

async function startSession(text: string): Promise<string> {
  const started = StartSessionResponse.parse(
    await api("POST", "/sessions", {
      projectId,
      provider: "fake",
      purpose: `Restart ${Math.random()}`,
      input: { text },
    }),
  );
  if (started.status !== "started") throw new Error(`not started: ${started.status}`);
  return started.sessionId;
}

/** HTTP status of an MCP `initialize` through the runner's proxy, as the agent sends it. */
async function initializeStatus(bearer: string): Promise<number> {
  const url = current().runner?.mcpProxyUrl;
  if (!url) throw new Error("no proxy url");
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      authorization: `Bearer ${bearer}`,
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "t", version: "0" },
      },
    }),
  });
  await res.body?.cancel();
  return res.status;
}

/** A `report_progress` call through the runner's proxy with the agent's token. */
async function reportProgress(bearer: string, text: string): Promise<string> {
  const url = current().runner?.mcpProxyUrl;
  if (!url) throw new Error("no proxy url");
  const client = new Client({ name: "test", version: "0.0.0" });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(url), {
      requestInit: { headers: { Authorization: `Bearer ${bearer}` } },
    }),
  );
  try {
    const result = await client.callTool({ name: "report_progress", arguments: { text } });
    expect(result.isError).toBeFalsy();
    return (result.content as Array<{ text: string }>)[0]?.text ?? "";
  } finally {
    await client.close();
  }
}

/** Whether the runner hosts a provider process for the session right now. */
async function hosted(sessionId: string): Promise<boolean> {
  const runnerStatus = await current().runner?.request({ name: "runner.status" });
  return runnerStatus?.sessions.some((s) => s.sessionId === sessionId) ?? false;
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "codeden-mcp-restart-"));
});

afterEach(async () => {
  await stopAll();
  await removeTree(home);
});

describe("MCP tokens across restarts (#208)", () => {
  it("a running session keeps its token through a server restart; a stopped one doesn't", async () => {
    const fake = heldFake({ hold: false });
    await boot(fake);
    await addProject();
    const live = await startSession(LONG);
    await waitUntil(() => status(live) === "running");
    const stopped = await startSession("hello");
    await waitUntil(() => status(stopped) === "idle");
    await api("POST", `/sessions/${stopped}/stop`);
    const liveToken = fake.last(live)?.token as string;
    const stoppedToken = fake.last(stopped)?.token as string;
    expect(await initializeStatus(liveToken)).toBe(200);
    expect(await initializeStatus(stoppedToken)).toBe(401);

    // Only the server restarts (the app): the runner keeps the agent's turn going.
    await current().close();
    await startServerOnHome();
    expect(await hosted(live)).toBe(true);
    expect(fake.opens.filter((o) => o.sessionId === live)).toHaveLength(1);
    expect(await reportProgress(liveToken, "after a server restart")).toBeTruthy();
    expect(await initializeStatus(stoppedToken)).toBe(401);
  }, 60_000);

  it("a session cut off by an upgrade is reopened with a token CodeDen accepts", async () => {
    const before = heldFake({ hold: false });
    await boot(before);
    await addProject();
    const id = await startSession(LONG);
    await waitUntil(() => status(id) === "running");
    const oldToken = before.last(id)?.token as string;

    await stopAll();
    const after = heldFake({ hold: false });
    await boot(after);
    // Recovery reopens the cut-off turn with a "continue" message and a fresh token.
    const reopened = await waitUntil(() => after.last(id));
    await waitUntil(() => status(id) === "idle", 30_000);
    expect(await reportProgress(reopened.token, "after an upgrade")).toBeTruthy();
    // The old provider process is gone, and its token with it.
    expect(await initializeStatus(oldToken)).toBe(401);
  }, 60_000);

  it("a session reopened by a message while recovery is busy keeps a valid token", async () => {
    await boot(heldFake({ hold: false }));
    await addProject();
    const a = await startSession(LONG);
    const b = await startSession(LONG);
    await waitUntil(() => status(a) === "running" && status(b) === "running");

    // An upgrade: both restart. Reopening a conversation takes a real provider a while.
    await stopAll();
    const fake = heldFake({ hold: true });
    await boot(fake);
    // Recovery reopens the cut-off sessions one at a time; the first is still opening.
    const recovering = await waitUntil(() => fake.opens[0]);
    const other = recovering.sessionId === a ? b : a;
    // Meanwhile the factory messages the other session's agent (say, to re-review a pull
    // request's new head), which reopens it.
    void current()
      .services.sessions.send(
        other,
        {
          input: { text: "Re-review the pull request's head.", attachments: [] },
          whenBusy: "queue",
        },
        "factory",
      )
      .catch(() => undefined);
    const live = await waitUntil(() => fake.opens.find((o) => o.sessionId === other));

    // Recovery moves on to the other session, which the runner doesn't host yet. Wait for the
    // pass to end, or for it to open the conversation a second time.
    recovering.release();
    let recovered = false;
    const runnerId = current().runner?.status.runnerId ?? undefined;
    void current()
      .services.recovery.onRunnerReady(runnerId)
      .then(() => {
        recovered = true;
      });
    const duplicate = await waitUntil(() =>
      recovered ? null : fake.opens.filter((o) => o.sessionId === other)[1],
    );
    live.release();
    // A conversation has one writer at a time (Codex refuses a second app-server on a thread).
    duplicate?.refuse(new Error("thread already has an active writer"));
    await waitUntil(() => hosted(other));

    // The agent working on the factory's message calls CodeDen's tools with its token.
    expect(await initializeStatus(live.token)).toBe(200);
    expect(await reportProgress(live.token, "verdict ready")).toBeTruthy();
    // It was opened once: the message reopened it, and recovery left it to that.
    expect(duplicate).toBeNull();
    await waitUntil(() => status(other) === "idle", 30_000);
  }, 60_000);
});

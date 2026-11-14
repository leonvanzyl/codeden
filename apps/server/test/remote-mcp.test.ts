import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import type { Session } from "@codeden/contracts";
import { type RunningRunner, startRunner } from "@codeden/runner";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type RunningServer, startServer } from "../src";
import type { RunnerClient } from "../src/runner/client";
import type { Exec } from "../src/services/exec";
import { sampleSession } from "./helpers";
import { waitUntil } from "./support/harness";
import { type InProcessLink, startInProcessLink } from "./support/in-process-link";
import { removeTree } from "./support/remove-tree";

/**
 * Remote runners phase 3b (`docs/remote-runners.md` §11): a runner with its own home and
 * backend `docker`, reached only through an exec link (`codeden runner-link`'s code, in
 * process), stands in for a sandbox. Its agents' MCP calls go to the runner's own proxy and
 * cross the link as `mcp.request`/`mcp.response` frames, answered by the server's MCP handler
 * in-process: nothing goes to the server's loopback `/mcp`.
 */

const TOKEN = "f".repeat(64);
/** A made-up MCP token: it must be refused, and reach no log, journal or event. */
const SENTINEL = "cdm_SENTINEL_never_logged_5c1e0b";

const nothingInstalled: Exec = async () => ({
  code: null,
  stdout: "",
  stderr: "",
  notFound: true,
  timedOut: false,
  path: null,
});

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", args, { cwd, encoding: "utf8", windowsHide: true }).trim();

/** Every file under `dir` (but `skip`), for the token grep. */
function filesUnder(dir: string, skip: string[] = []): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (skip.includes(path)) return [];
    return statSync(path).isDirectory() ? filesUnder(path, skip) : [path];
  });
}

interface Answer {
  status: number;
  body: string;
  contentType: string | null;
  wwwAuthenticate: string | null;
}

/** An agent's raw MCP request, reduced to what the agent sees. */
async function call(url: string, token: string, method = "POST"): Promise<Answer> {
  const res = await fetch(url, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
    },
    body:
      method === "POST"
        ? JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} })
        : undefined,
  });
  return {
    status: res.status,
    body: await res.text(),
    contentType: res.headers.get("content-type"),
    wwwAuthenticate: res.headers.get("www-authenticate"),
  };
}

const text = (result: unknown) =>
  ((result as { content: Array<{ text?: string }> }).content[0]?.text ?? "") as string;

let base: string;
let serverHome: string;
let runnerHome: string;
let bare: string;
let work: string;
let runner: RunningRunner;
let server: RunningServer;
let client: RunnerClient;
/** Every line the server sent into the link. */
let frames: string[];
let logs: string[];

beforeEach(async () => {
  base = mkdtempSync(join(tmpdir(), "codeden-remote-mcp-"));
  serverHome = mkdtempSync(join(base, "server-"));
  runnerHome = mkdtempSync(join(base, "sandbox-"));
  bare = mkdtempSync(join(base, "origin-"));
  work = mkdtempSync(join(base, "project-"));
  git(bare, "init", "-q", "--bare", "-b", "main");
  git(work, "init", "-q", "-b", "main");
  git(work, "config", "user.name", "Test");
  git(work, "config", "user.email", "test@example.com");
  writeFileSync(join(work, "README.md"), "# remote\n");
  git(work, "add", "-A");
  git(work, "commit", "-q", "-m", "initial");
  git(work, "remote", "add", "origin", bare);
  git(work, "push", "-q", "origin", "main");

  logs = [];
  frames = [];
  runner = await startRunner({
    home: runnerHome,
    enableFakeProvider: true,
    backend: "docker",
    log: (message) => logs.push(message),
  });
  server = await startServer({
    port: 0,
    dataDir: serverHome,
    token: TOKEN,
    runner: false,
    secrets: "memory",
    checkSetupOnStart: false,
    userHome: serverHome,
    exec: nothingInstalled,
    github: { sync: false },
    gitBroker: {
      cloneUrl: async () => bare,
      credentialFor: async () => undefined,
      credentialForProject: async () => undefined,
    },
    askUserWaitMs: 60_000,
    log: (message) => logs.push(message),
  });
  client = server.runners.add({
    id: "rn-sandbox",
    backend: "docker",
    dir: runnerHome,
    lockFile: runner.lockFile,
    launch: null,
    link: {
      kind: "exec",
      start: () => {
        const link: InProcessLink = startInProcessLink(runnerHome);
        // What the server sends the runner, on its way into the link.
        const tap = new PassThrough();
        tap.on("data", (chunk: Buffer) => {
          frames.push(...chunk.toString().split("\n").filter(Boolean));
          link.stdin.write(chunk);
        });
        tap.on("end", () => link.stdin.end());
        return { ...link, stdin: tap };
      },
    },
  });
  await client.start();
});

afterEach(async () => {
  vi.restoreAllMocks();
  await server.close();
  await runner.close();
  await removeTree(base);
});

/** The command the server sent with `name`, as the runner received it. */
function sentCommand(name: string): Record<string, unknown> | undefined {
  for (const line of frames) {
    const msg = JSON.parse(line) as { type: string; command?: { name: string } };
    if (msg.type === "command" && msg.command?.name === name) return msg.command;
  }
  return undefined;
}

describe("MCP from a sandbox runner, over its link", () => {
  it("serves tool calls, a streamed answer and DELETE, and refuses others' tokens as /mcp does", async () => {
    await waitUntil(() => client.mcpProxyUrl !== null);
    // The runner was told to tunnel, and was never given the server's address.
    const configure = sentCommand("runner.configure");
    expect(configure).toEqual({ name: "runner.configure", mcpUpstreamUrl: null, mcpLink: true });
    expect(client.mcpProxyUrl).toBe(runner.mcpUrl);

    const fetches: string[] = [];
    const realFetch = globalThis.fetch;
    vi.spyOn(globalThis, "fetch").mockImplementation((input, init) => {
      fetches.push(input instanceof Request ? input.url : String(input));
      return realFetch(input, init);
    });

    // A Fake session on the sandbox runner, started with its own MCP token.
    const { project } = await server.services.projects.create({
      source: { type: "local", path: work },
    });
    const id = "s-remote";
    const session: Session = {
      ...sampleSession,
      id,
      projectId: project.id,
      scope: { projectId: project.id },
      status: "queued",
      runnerId: client.status.runnerId,
    };
    const { sessionRepo, sessions } = server.services;
    sessionRepo.create(session, {
      workspaceMode: "worktree",
      workspaceFallback: null,
      forced: null,
      queuedBehind: [],
      pending: { input: { text: "hello", attachments: [] }, workspace: { mode: "worktree" } },
    });
    sessions.startQueued(session);
    await sessions.launching.get(id);
    await waitUntil(() => sessionRepo.get(id).status === "idle");
    const start = sentCommand("session.start") as {
      options: { mcpServers: Array<{ url: string; headers: { Authorization: string } }> };
    };
    const [mcpServer] = start.options.mcpServers;
    expect(mcpServer?.url).toBe(runner.mcpUrl);
    const sessionToken = mcpServer?.headers.Authorization.replace(/^Bearer /, "") as string;
    expect(sessionToken).toMatch(/^cdm_/);

    // The agent: a plain tool call, then one whose answer streams in later.
    const agent = new Client({ name: "agent", version: "0.0.0" });
    await agent.connect(
      new StreamableHTTPClientTransport(new URL(runner.mcpUrl), {
        requestInit: { headers: { Authorization: `Bearer ${sessionToken}` } },
      }),
    );
    const progress = await agent.callTool({
      name: "report_progress",
      arguments: { text: "Working in the sandbox" },
    });
    expect(text(progress)).toBe("Progress recorded.");
    expect(sessionRepo.get(id).progress?.text).toBe("Working in the sandbox");

    const asked = agent.callTool({
      name: "ask_user",
      arguments: { question: "Which colour?", options: [{ label: "Red" }, { label: "Blue" }] },
    });
    const question = await waitUntil(() =>
      server.services.inbox
        .list({ sessionId: id })
        .find((i) => i.kind === "question" && i.status === "open"),
    );
    await sessions.respond(id, {
      requestId: question.requestId as string,
      response: { kind: "answer", answers: { q1: ["Blue"] } },
    });
    expect(text(await asked)).toContain("A: Blue");
    await agent.close();

    // DELETE crosses the link and gets what `/mcp` answers (a stateless endpoint: 405).
    const deleted = await call(runner.mcpUrl, sessionToken, "DELETE");

    // A made-up token, and another session's live token, are refused the same way.
    const other = "s-other";
    sessionRepo.create(
      { ...sampleSession, id: other, projectId: project.id, status: "idle" },
      { workspaceMode: "worktree", workspaceFallback: null, forced: null, queuedBehind: [] },
    );
    const otherToken = server.services.mcpTokens.mint({
      role: "agent",
      sessionId: other,
      projectId: project.id,
    });
    const bad = await call(runner.mcpUrl, SENTINEL);
    const borrowed = await call(runner.mcpUrl, otherToken);

    // Nothing above went to the server's loopback `/mcp`.
    expect(fetches.length).toBeGreaterThan(0);
    expect(fetches.filter((url) => url.startsWith(server.url))).toEqual([]);
    vi.restoreAllMocks();

    // What `/mcp` itself answers, for comparison.
    const direct = `${server.url}/mcp`;
    expect(deleted).toEqual(await call(direct, sessionToken, "DELETE"));
    expect(deleted.status).toBe(405);
    const refused = await call(direct, SENTINEL);
    expect(refused.status).toBe(401);
    expect(refused.wwwAuthenticate).toBe('Bearer realm="codeden"');
    expect(bad).toEqual(refused);
    expect(borrowed).toEqual(refused);
    // The borrowed token is live: `/mcp` accepts it from its own session's runner.
    expect((await call(direct, otherToken)).status).toBe(200);

    // No MCP token reached a log, the runner's journal or files, or the stored events.
    const runnerFiles = filesUnder(runnerHome, [join(runnerHome, "ws")]);
    expect(runnerFiles.length).toBeGreaterThan(0);
    for (const file of runnerFiles) {
      const content = readFileSync(file, "latin1");
      for (const secret of [sessionToken, otherToken, SENTINEL]) {
        expect(content.includes(secret), file).toBe(false);
      }
    }
    const stored = JSON.stringify(server.store.listAfter(0, 100_000));
    for (const secret of [sessionToken, otherToken, SENTINEL]) {
      expect(logs.join("\n")).not.toContain(secret);
      expect(stored).not.toContain(secret);
    }
  });
});

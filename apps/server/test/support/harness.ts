import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { CreateProjectResponse, SessionDetail, StartSessionResponse } from "@codeden/contracts";
import {
  isProcessAlive,
  type RunningServer,
  readLiveRunnerLock,
  type StartServerOptions,
  startServer,
} from "../../src";
import { removeTree } from "./remove-tree";

export const TOKEN = "d".repeat(64);

/** A server with a real runner (Fake provider) and a local git repo as a project. */
export interface Harness {
  home: string;
  repo: string;
  server: RunningServer;
  projectId: string;
  api: (method: string, path: string, body?: unknown) => Promise<{ status: number; body: unknown }>;
  detail: (id: string) => Promise<SessionDetail>;
  /** Start a Fake session in a new worktree and wait for its first turn to finish. */
  startFakeSession: (text?: string) => Promise<string>;
  close: () => Promise<void>;
}

/**
 * Poll `probe` until it returns a value (not `undefined` or `false`). The default deadline is
 * generous for a busy machine and half the runner project's 60 s test timeout
 * (`vitest.config.ts`), so a slow wait reports itself before Vitest stops the test.
 */
export async function waitUntil<T>(
  probe: () => Promise<T | undefined> | T | undefined,
  timeoutMs = 30_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await probe();
    if (value !== undefined && value !== false) return value;
    if (Date.now() > deadline) throw new Error(`timed out after ${timeoutMs} ms`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

export async function startHarness(
  extra: Partial<StartServerOptions> = {},
  /** Extra files committed to the repo before it becomes a project. */
  files: Record<string, string> = {},
): Promise<Harness> {
  const home = mkdtempSync(join(tmpdir(), "codeden-h-"));
  const repo = join(home, "repo");
  mkdirSync(repo);
  const git = (...args: string[]) => execFileSync("git", ["-C", repo, ...args], { stdio: "pipe" });
  git("init", "-q", "-b", "main");
  git("config", "user.email", "test@example.com");
  git("config", "user.name", "Test");
  writeFileSync(join(repo, "README.md"), "# test\n");
  for (const [path, contents] of Object.entries(files)) {
    mkdirSync(dirname(join(repo, path)), { recursive: true });
    writeFileSync(join(repo, path), contents);
  }
  git("add", ".");
  git("commit", "-q", "-m", "init");

  const server = await startServer({
    port: 0,
    dataDir: join(home, "data"),
    token: TOKEN,
    enableFakeProvider: true,
    waitForRunner: true,
    secrets: "memory",
    checkSetupOnStart: false,
    userHome: home,
    realtimeFlushMs: 10,
    ...extra,
  });
  const api = async (method: string, path: string, body?: unknown) => {
    const res = await fetch(`${server.url}/api${path}`, {
      method,
      headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: res.status, body: (await res.json()) as unknown };
  };
  const detail = async (id: string) =>
    SessionDetail.parse((await api("GET", `/sessions/${id}`)).body);
  const created = CreateProjectResponse.parse(
    (await api("POST", "/projects", { source: { type: "local", path: repo } })).body,
  );
  const projectId = created.project.id;
  // The runner proxy is configured right after the handshake.
  await waitUntil(() => server.runner?.mcpProxyUrl ?? undefined);

  return {
    home,
    repo,
    server,
    projectId,
    api,
    detail,
    startFakeSession: async (text = "hello") => {
      const res = await api("POST", "/sessions", {
        projectId,
        provider: "fake",
        purpose: `Fake ${Math.random()}`,
        input: { text },
      });
      const started = StartSessionResponse.parse(res.body);
      if (started.status !== "started") throw new Error(`not started: ${started.status}`);
      await waitUntil(async () =>
        (await detail(started.sessionId)).session.status === "idle" ? true : undefined,
      );
      return started.sessionId;
    },
    close: async () => {
      const lock = readLiveRunnerLock(server.paths.runnerLock);
      await server.close({ stopRunner: true });
      const deadline = Date.now() + 10_000;
      while (lock && isProcessAlive(lock.pid) && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 50));
      }
      await removeTree(home);
    },
  };
}

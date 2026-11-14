import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { PassThrough } from "node:stream";
import type { Session } from "@codeden/contracts";
import { type RunningRunner, startRunner } from "@codeden/runner";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type RunningServer, startServer } from "../src";
import { browserScreenshot } from "../src/mcp/tools/browser-screenshot";
import { shareToChat } from "../src/mcp/tools/share-to-chat";
import type { RunnerClient } from "../src/runner/client";
import type { Exec } from "../src/services/exec";
import { listSessionFiles, readSessionFile } from "../src/services/files/session-files";
import type { GitBroker } from "../src/services/git-broker";
import { isRemoteRunner } from "../src/services/runner-port";
import { sampleSession } from "./helpers";
import { waitUntil } from "./support/harness";
import { type InProcessLink, startInProcessLink } from "./support/in-process-link";
import { storedReply } from "./support/link-turn";
import { removeTree } from "./support/remove-tree";

/**
 * Remote runners phase 3a (`docs/remote-runners.md` §9, §10, §18): a runner whose home is a
 * different folder from the server's and whose backend isn't `local`, reached only through an
 * exec link (`codeden runner-link`'s code, in process), stands in for a sandbox. Its session
 * clones the project, runs a Fake turn, and everything the server does with its files goes
 * through `fs.*`/`transfer.*` on the link, never the server's own disk.
 */

/** Every root the server opened on its own disk (`LocalWorkspaceFs`): a tripwire. */
const localRoots = vi.hoisted(() => [] as string[]);
vi.mock("../src/services/workspace-fs/local", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/services/workspace-fs/local")>();
  class Tripwire extends actual.LocalWorkspaceFs {
    constructor(root: string, home: string) {
      super(root, home);
      localRoots.push(root);
    }
  }
  return { ...actual, LocalWorkspaceFs: Tripwire };
});

const TOKEN = "f".repeat(64);
/** A brokered GitHub token: it must reach no journal, log, event or git config. */
const SENTINEL = "ghs_SENTINEL_never_stored_7f3a9c";
/** A 1x1 PNG. */
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
  "base64",
);

const nothingInstalled: Exec = async () => ({
  code: null,
  stdout: "",
  stderr: "",
  notFound: true,
  timedOut: false,
  path: null,
});

/** A browser engine with one tab whose screenshot is `PNG`; everything else does nothing. */
function fakeBrowser() {
  const session = {
    tabId: () => "t1",
    dialogs: { assertNone: () => undefined },
    page: () => ({ screenshot: async () => PNG }),
  };
  const engine: Record<string, unknown> = { get: () => session };
  return new Proxy(engine, {
    get: (target, key) =>
      key in target ? target[key as string] : key === "then" ? undefined : async () => undefined,
  }) as never;
}

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

let base: string;
let serverHome: string;
let runnerHome: string;
let bare: string;
let work: string;
let runner: RunningRunner;
let server: RunningServer;
let client: RunnerClient;
let commands: string[];
let logs: string[];

beforeEach(async () => {
  localRoots.length = 0;
  base = mkdtempSync(join(tmpdir(), "codeden-remote-ws-"));
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
  commands = [];
  runner = await startRunner({
    home: runnerHome,
    enableFakeProvider: true,
    backend: "docker",
    browser: fakeBrowser(),
    log: (message) => logs.push(message),
  });
  const credential = { username: "x-access-token", password: SENTINEL };
  const gitBroker: GitBroker = {
    cloneUrl: async () => bare,
    credentialFor: async (port) => (isRemoteRunner(port) ? credential : undefined),
    credentialForProject: async (port) => (isRemoteRunner(port) ? credential : undefined),
  };
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
    gitBroker,
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
        // What the server asks the runner, by command name, on its way into the link.
        const tap = new PassThrough();
        tap.on("data", (chunk: Buffer) => {
          for (const line of chunk.toString().split("\n")) {
            const name = line.match(/"command":\{"name":"([a-z.]+)"/)?.[1];
            if (name) commands.push(name);
          }
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
  await server.close();
  await runner.close();
  await removeTree(base);
});

describe("a session on a sandbox runner (clone, files over the link)", () => {
  it("clones, runs a turn, reads files, diffs, shares and pushes without the server's disk", async () => {
    await waitUntil(() => client.status.runnerId !== null);
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
      pending: {
        input: { text: "hello over the link", attachments: [] },
        workspace: { mode: "worktree" },
      },
    });
    sessions.startQueued(session);
    await sessions.launching.get(id);

    // Prepared: a clone at a path the runner chose, inside its own home.
    const started = sessionRepo.get(id);
    const cwd = started.cwd;
    expect(relative(join(runnerHome, "ws"), cwd)).not.toMatch(/^\.\./);
    expect(started.worktreePath).toBeNull();
    expect(started.branch).toMatch(/^codeden\//);
    expect(git(cwd, "remote", "get-url", "origin")).toBe(bare);
    expect(commands).toContain("workspace.prepare");

    // Ran a turn.
    await waitUntil(() => sessionRepo.get(id).status === "idle");
    expect(storedReply(server, id).completed).toContain("hello over the link");

    // Lists and reads files.
    const files = server.services.workspaceFs(sessionRepo.get(id));
    expect(files.remote).toBe(true);
    const list = await listSessionFiles(files);
    expect(list.entries.map((e) => e.path)).toContain("README.md");
    // The clone may check files out with CRLF (core.autocrlf on Windows).
    expect((await readSessionFile(files, "README.md")).content).toMatch(/^# remote\r?\n$/);
    expect(commands).toEqual(expect.arrayContaining(["fs.list", "fs.read"]));

    // Shows a checkpoint diff of what the agent changed.
    writeFileSync(join(cwd, "notes.md"), "found it\n");
    await waitUntil(() => server.services.workbench.checkpoints(id).length > 0);
    const diff = await server.services.workbench.diff(id, { kind: "session" });
    expect(diff.files.map((f) => f.path)).toContain("notes.md");

    // Shares an artifact by path, and a browser screenshot.
    const ctx = { services: server.services, sessionId: id } as never;
    await shareToChat.handler({ path: "notes.md" }, ctx);
    const shot = await browserScreenshot.handler({ share: true }, ctx);
    const artifacts = server.services.artifacts.list({ sessionId: id });
    const shared = artifacts.find((a) => a.name === "notes.md");
    expect(shared && readFileSync(server.services.artifacts.filePath(shared), "utf8")).toBe(
      "found it\n",
    );
    const screenshot = artifacts.find((a) => a.kind === "screenshot");
    expect(screenshot && readFileSync(server.services.artifacts.filePath(screenshot))).toEqual(PNG);
    expect(JSON.stringify(shot)).not.toContain(serverHome);
    expect(commands).toEqual(expect.arrayContaining(["fs.stat", "browser.screenshot"]));

    // Pushes its branch, with the brokered credential.
    git(cwd, "config", "user.name", "Test");
    git(cwd, "config", "user.email", "test@example.com");
    await server.services.workbench.commit(id, { message: "notes" });
    await server.services.workbench.push(id, {});
    const branch = sessionRepo.get(id).branch as string;
    expect(git(bare, "rev-parse", branch)).toBe(git(cwd, "rev-parse", "HEAD"));

    // Nothing of the workspace was opened on the server's own disk...
    expect(localRoots.filter((root) => !relative(runnerHome, root).startsWith(".."))).toEqual([]);
    // Agent config is discovered in the project folder here, not at the runner's path.
    expect(server.services.agentConfig.loaded(id).cwd).toBe(project.path);
    // ...while a home-runner session's folder is (the tripwire works).
    const home = server.services.workspaceFs({ ...sampleSession, id: "s-home", cwd: work });
    expect(home.remote).toBe(false);
    expect(localRoots).toContain(work);

    // The brokered token is in no journal, log, event or git config.
    const runnerFiles = filesUnder(runnerHome, [join(runnerHome, "ws")]);
    expect(runnerFiles.length).toBeGreaterThan(0);
    for (const file of [...runnerFiles, join(cwd, ".git", "config")]) {
      expect(readFileSync(file, "latin1"), file).not.toContain(SENTINEL);
    }
    expect(logs.join("\n")).not.toContain(SENTINEL);
    expect(JSON.stringify(server.store.listAfter(0, 100_000))).not.toContain(SENTINEL);
  });
});

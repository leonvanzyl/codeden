import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { RunnerCommand } from "@codeden/contracts";
import { WorkspaceFsHost } from "@codeden/runner";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ServiceError } from "../src/services/errors";
import type { RunnerPort } from "../src/services/runner-port";
import { LocalWorkspaceFs } from "../src/services/workspace-fs/local";
import { readOutgoingFile } from "../src/services/workspace-fs/outgoing";
import { RunnerWorkspaceFs } from "../src/services/workspace-fs/runner";
import type { WorkspaceFs } from "../src/services/workspace-fs/workspace-fs";
import { workspaceFsFor } from "../src/services/workspace-fs/workspace-fs";
import { sampleSession } from "./helpers";

/**
 * Workspace file access refuses the same paths with the same codes whether the workspace is on
 * the server's disk (`LocalWorkspaceFs`) or on a runner's (`RunnerWorkspaceFs` over `fs.*`,
 * answered here by the runner's own handlers, in process): `docs/remote-runners.md` §10.
 */

let base: string;
let root: string;
let home: string;
let outside: string;
let sent: RunnerCommand[];

/** A runner port that isn't the home runner, answering with the runner's `fs.*` handlers. */
function runnerPort(files: WorkspaceFsHost, backend: "docker" | "local" = "docker"): RunnerPort {
  return {
    remote: () => ({ platform: process.platform, backend }),
    isConnected: () => true,
    runnerId: () => "rn-sandbox",
    providers: () => [],
    mcpProxyUrl: () => null,
    waitForConnection: async () => true,
    request: async (command) => {
      sent.push(command);
      return files.execute(command as never) as never;
    },
  };
}

function write(path: string, content = "x") {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), "codeden-parity-"));
  root = join(base, "ws");
  // CodeDen's data folder inside the workspace: its credential files must still be refused.
  home = join(root, ".codeden-home");
  outside = join(base, "outside");
  sent = [];
  write(join(root, "src", "a.ts"), "export const a = 1;\n");
  write(join(root, ".env"), "SECRET=1\n");
  write(join(home, "install-token"), "token");
  write(join(home, "runner", "runner.json"), "{}");
  write(join(home, "runner", "runner.json.invalid-1700000000000"), "{}");
  write(join(home, "runner", "journal", "000001.jsonl"), '{"seq":1}');
  write(join(outside, "secret.txt"), "outside");
  // A folder link out of the workspace (a junction needs no privilege on Windows).
  symlinkSync(outside, join(root, "escape"), "junction");
});

afterEach(() => rmSync(base, { recursive: true, force: true }));

/** The code a call fails with, or "ok". */
async function codeOf(run: () => Promise<unknown>): Promise<string> {
  return run().then(
    () => "ok",
    (error: unknown) => (error as { code?: string }).code ?? String(error),
  );
}

describe("WorkspaceFs guards (local and runner alike)", () => {
  const cases: Array<[string, (fs: WorkspaceFs) => Promise<unknown>, string]> = [
    ["reads a file inside", (fs) => fs.read("src/a.ts"), "ok"],
    [
      "writes a file inside",
      (fs) => fs.writeFile("out/b.txt", Buffer.from("b"), { createDirs: true }),
      "ok",
    ],
    ["`..` escapes", (fs) => fs.read("../outside/secret.txt"), "path_outside_root"],
    ["an absolute path outside", (fs) => fs.read(join(outside, "secret.txt")), "path_outside_root"],
    ["a link pointing outside", (fs) => fs.read("escape/secret.txt"), "path_outside_root"],
    ["a NUL byte", (fs) => fs.read("src/a.ts\0.png"), "path_outside_root"],
    ["CodeDen's install token", (fs) => fs.read(".codeden-home/install-token"), "credential_file"],
    [
      "the runner lock",
      (fs) => fs.readFile(".codeden-home/runner/runner.json", 1000),
      "credential_file",
    ],
    [
      "a damaged lock's `.invalid-*` copy",
      (fs) => fs.read(".codeden-home/runner/runner.json.invalid-1700000000000"),
      "credential_file",
    ],
    [
      "Cursor's allow-list",
      (fs) => fs.writeFile(".cursor/cli.json", Buffer.from("{}"), { createDirs: true }),
      "agent_permission_file",
    ],
    [
      "Gemini's settings",
      (fs) => fs.writeFile(".gemini/settings.json", Buffer.from("{}"), { createDirs: true }),
      "agent_permission_file",
    ],
    [
      "inside .git",
      (fs) => fs.writeFile(".git/config", Buffer.from("x"), { createDirs: true }),
      "protected_path",
    ],
    [
      "the runner journal, in a root that holds the data folder",
      (fs) => fs.read(".codeden-home/runner/journal/000001.jsonl"),
      "protected_path",
    ],
    [
      "a look at the runner state folder",
      (fs) => fs.stat(".codeden-home/runner/journal"),
      "protected_path",
    ],
    [
      "a write into the runner state folder",
      (fs) => fs.writeFile(".codeden-home/runner/new.txt", Buffer.from("x")),
      "protected_path",
    ],
    ["a missing file", (fs) => fs.read("nope.txt"), "not_found"],
    ["a folder as a file", (fs) => fs.read("src"), "not_a_file"],
  ];

  it.each(cases)("%s", async (_label, run, expected) => {
    const local = new LocalWorkspaceFs(root, home);
    const remote = new RunnerWorkspaceFs(runnerPort(new WorkspaceFsHost(home)), root);
    expect(await codeOf(() => run(local))).toBe(expected);
    expect(await codeOf(() => run(remote))).toBe(expected);
  });

  it("refuses CodeDen's runner state folder as a root on both", async () => {
    const state = join(home, "runner");
    const local = new LocalWorkspaceFs(state, home);
    const remote = new RunnerWorkspaceFs(runnerPort(new WorkspaceFsHost(home)), state);
    expect(await codeOf(() => local.list())).toBe("root_invalid");
    expect(await codeOf(() => remote.list())).toBe("root_invalid");
  });

  it("leaves the runner state folder out of listings on both", async () => {
    const local = new LocalWorkspaceFs(root, home);
    const remote = new RunnerWorkspaceFs(runnerPort(new WorkspaceFsHost(home)), root);
    for (const fs of [local, remote]) {
      const paths = (await fs.list()).entries.map((e) => e.path);
      expect(paths).toContain(".codeden-home/install-token");
      expect(paths.filter((p) => p.startsWith(".codeden-home/runner"))).toEqual([]);
    }
  });

  it("refuses an escaping path before asking the runner", async () => {
    const remote = new RunnerWorkspaceFs(runnerPort(new WorkspaceFsHost(home)), root);
    expect(await codeOf(() => remote.read("../outside/secret.txt"))).toBe("path_outside_root");
    expect(await codeOf(() => remote.read(join(outside, "secret.txt")))).toBe("path_outside_root");
    expect(sent).toEqual([]);
  });
});

describe("sharing and attaching from a runner's workspace", () => {
  it("refuses a secrets file, and a link to one, by its real name", async () => {
    const remote = new RunnerWorkspaceFs(runnerPort(new WorkspaceFsHost(home)), root);
    const refused = { status: 403, code: "secret_file" };
    await expect(readOutgoingFile(remote, ".env", { home })).rejects.toMatchObject(refused);
    // A file link needs a privilege on Windows; a folder junction shows the same thing.
    write(join(root, "config", ".env"), "SECRET=2\n");
    symlinkSync(join(root, "config"), join(root, "harmless"), "junction");
    await expect(
      readOutgoingFile(remote, "harmless/.env", { home, name: "notes.txt" }),
    ).rejects.toMatchObject(refused);
    try {
      symlinkSync(join(root, ".env"), join(root, "notes.txt"), "file");
    } catch {
      return; // No file symlinks without Developer Mode on Windows.
    }
    await expect(readOutgoingFile(remote, "notes.txt", { home })).rejects.toMatchObject(refused);
  });

  it("reads a file inside, and names an escape plainly", async () => {
    const remote = new RunnerWorkspaceFs(runnerPort(new WorkspaceFsHost(home)), root);
    const read = await readOutgoingFile(remote, "src/a.ts", { home });
    expect(read).toMatchObject({ name: "a.ts" });
    expect(read.bytes.toString()).toBe("export const a = 1;\n");
    const escaped = await readOutgoingFile(remote, "../outside/secret.txt", { home }).catch(
      (error: unknown) => error,
    );
    expect(escaped).toBeInstanceOf(ServiceError);
    expect(escaped).toMatchObject({ status: 403, code: "path_outside_root" });
  });
});

describe("which files a session gets", () => {
  it("reads through the runner for every runner but the home runner, whatever it reports", () => {
    const session = { ...sampleSession, cwd: root };
    const host = new WorkspaceFsHost(home);
    const homeRunner = { ...runnerPort(host), remote: undefined };
    // A runner on this machine that says it is `local` is still not trusted with this disk.
    const other = runnerPort(host, "local");
    const local = workspaceFsFor({ runner: homeRunner, home }, session);
    const remote = workspaceFsFor(
      {
        runner: homeRunner,
        runners: { home: () => homeRunner, forSession: () => other, forRunnerId: () => other },
        home,
      },
      session,
    );
    expect(local).toBeInstanceOf(LocalWorkspaceFs);
    expect(remote).toBeInstanceOf(RunnerWorkspaceFs);
  });
});

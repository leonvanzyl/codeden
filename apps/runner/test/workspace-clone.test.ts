import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { credentialArgs, credentialEnv } from "../src/git/credentials";
import { git } from "../src/git/exec";
import { push } from "../src/git/ops";
import { ProcessSupervisor } from "../src/process/supervisor";
import { prepareWorkspace } from "../src/workspace/worktree";
import { makeRepo, removeDir, sh, tempDir, write } from "./helpers";

/**
 * `workspace.prepare` with `clone` (`docs/remote-runners.md` §9.1): a runner that doesn't share
 * the server's disk clones the project into a folder it chooses, and git credentials are
 * brokered per operation without being stored (§9.2).
 */

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0).reverse()) removeDir(dir);
});

const TOKEN = "ghs_sentinelTOKEN0123456789";
const credential = { username: "x-access-token", password: TOKEN };

/** A bare "remote" with one commit on main, and a runner home. */
function setup() {
  const work = makeRepo({ "README.md": "# demo\n", "src/a.ts": "export const a = 1;\n" });
  const bare = tempDir("codeden-bare-");
  const home = tempDir("codeden-runner-home-");
  dirs.push(work, bare, home);
  sh(bare, "init", "-q", "--bare", "-b", "main");
  sh(work, "remote", "add", "origin", bare);
  sh(work, "push", "-q", "origin", "main");
  const ctx = { home, supervisor: new ProcessSupervisor(), emit: () => undefined };
  return { work, bare, home, ctx };
}

const clone = (sessionId: string, remoteUrl: string, extra: Record<string, unknown> = {}) => ({
  name: "workspace.prepare" as const,
  sessionId,
  strategy: "clone" as const,
  remoteUrl,
  setupCommands: [],
  ...extra,
});

describe("workspace.prepare clone", () => {
  it("clones into <home>/ws/<short> on a new branch from the default branch", async () => {
    const { bare, home, ctx } = setup();
    const result = await prepareWorkspace(
      clone("sess-clone-1", bare, { branch: "codeden/one", credential }),
      ctx,
    );
    expect(result.cwd).toBe(join(home, "ws", "sessclon"));
    expect(result).toMatchObject({ branch: "codeden/one", created: true });
    expect(readFileSync(join(result.cwd, "src", "a.ts"), "utf8")).toContain("a = 1");
    expect(sh(result.cwd, "rev-parse", "--abbrev-ref", "HEAD")).toBe("codeden/one");
    // Nothing of the credential is kept: not in the config, not in the remote URL.
    const config = readFileSync(join(result.cwd, ".git", "config"), "utf8");
    expect(config).not.toContain(TOKEN);
    expect(sh(result.cwd, "remote", "get-url", "origin")).toBe(bare);
  });

  it("reuses its clone, and checks out the remote's branch when it exists", async () => {
    const { work, bare, ctx } = setup();
    sh(work, "checkout", "-q", "-b", "codeden/pushed");
    write(work, "pushed.txt", "from an earlier sandbox\n");
    sh(work, "add", "-A");
    sh(work, "commit", "-q", "-m", "pushed");
    sh(work, "push", "-q", "origin", "codeden/pushed");

    const first = await prepareWorkspace(
      clone("sess-clone-2", bare, { branch: "codeden/pushed" }),
      ctx,
    );
    expect(existsSync(join(first.cwd, "pushed.txt"))).toBe(true);
    expect(sh(first.cwd, "rev-parse", "--abbrev-ref", "@{upstream}")).toBe("origin/codeden/pushed");

    const again = await prepareWorkspace(
      clone("sess-clone-2", bare, { branch: "codeden/pushed", fetch: true }),
      ctx,
    );
    expect(again).toMatchObject({ cwd: first.cwd, created: false, branch: "codeden/pushed" });
  });

  it("refuses a folder that is a clone of something else, and a fork's checkpoint", async () => {
    const { bare, ctx } = setup();
    const other = makeRepo();
    dirs.push(other);
    await prepareWorkspace(clone("sess-clone-3", bare), ctx);
    await expect(prepareWorkspace(clone("sess-clone-3", other), ctx)).rejects.toMatchObject({
      code: "path_exists",
    });
    await expect(
      prepareWorkspace(
        clone("sess-clone-4", bare, { restoreCheckpoint: { sessionId: "src", index: 1 } }),
        ctx,
      ),
    ).rejects.toMatchObject({ code: "unsupported" });
  });

  it("pushes the session's branch with a brokered credential", async () => {
    const { bare, ctx } = setup();
    const ws = await prepareWorkspace(clone("sess-clone-5", bare, { branch: "codeden/five" }), ctx);
    sh(ws.cwd, "config", "user.name", "Test");
    sh(ws.cwd, "config", "user.email", "test@example.com");
    write(ws.cwd, "five.txt", "5\n");
    sh(ws.cwd, "add", "-A");
    sh(ws.cwd, "commit", "-q", "-m", "five");
    await push({ name: "git.push", cwd: ws.cwd, credential });
    expect(sh(bare, "rev-parse", "codeden/five")).toBe(sh(ws.cwd, "rev-parse", "HEAD"));
    expect(readFileSync(join(ws.cwd, ".git", "config"), "utf8")).not.toContain(TOKEN);
  });
});

describe("brokered git credentials", () => {
  it("answer git's credential request from the git process's own environment", () => {
    const repo = makeRepo();
    dirs.push(repo);
    // `git credential fill` asks the configured helpers, as a clone or push over https would.
    const out = execFileSync("git", [...credentialArgs(), "credential", "fill"], {
      cwd: repo,
      input: "protocol=https\nhost=github.com\npath=acme/app.git\n\n",
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0", ...credentialEnv(credential) },
      encoding: "utf8",
      windowsHide: true,
    });
    expect(out).toContain("username=x-access-token");
    expect(out).toContain(`password=${TOKEN}`);
  });

  it("are scrubbed from git's error messages", async () => {
    const repo = makeRepo();
    dirs.push(repo);
    const error = await git(repo, ["rev-parse", "--verify", TOKEN], { credential }).catch(
      (e: unknown) => e as Error,
    );
    expect(error).toMatchObject({ code: "git_failed" });
    expect((error as Error).message).not.toContain(TOKEN);
  });

  it("a git command in a folder that is gone fails with cwd_missing", async () => {
    const home = tempDir("codeden-gone-");
    dirs.push(home);
    await expect(git(join(home, "missing"), ["status"])).rejects.toMatchObject({
      code: "cwd_missing",
    });
  });
});

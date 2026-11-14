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
const credential = { scope: "https://github.com", username: "x-access-token", password: TOKEN };

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

  it("never reuses a clone whose checkout failed, on whatever branch it was left", async () => {
    const { bare, home, ctx } = setup();
    // The clone succeeds, then making the session's branch fails (no such base).
    await expect(
      prepareWorkspace(clone("sess-clone-6", bare, { baseRef: "no-such-ref" }), ctx),
    ).rejects.toMatchObject({ code: "git_failed" });
    const path = join(home, "ws", "sessclon");
    expect.soft(existsSync(path), "the partial clone is removed").toBe(false);

    const again = await prepareWorkspace(clone("sess-clone-6", bare), ctx);
    expect(again).toMatchObject({ cwd: path, created: true, branch: "codeden/sessclon" });
    expect(sh(path, "rev-parse", "--abbrev-ref", "HEAD")).toBe("codeden/sessclon");
  });

  it("clones again over a clone left unfinished (the runner stopped mid-prepare)", async () => {
    const { bare, home, ctx } = setup();
    // What a runner killed between the clone and the checkout leaves: the default branch.
    const path = join(home, "ws", "sessclon");
    sh(home, "clone", "-q", "--", bare, path);
    const result = await prepareWorkspace(
      clone("sess-clone-7", bare, { branch: "codeden/seven" }),
      ctx,
    );
    expect(result).toMatchObject({ cwd: path, created: true, branch: "codeden/seven" });
    expect(sh(path, "rev-parse", "--abbrev-ref", "HEAD")).toBe("codeden/seven");

    // A finished clone is reused as it is, on the branch it was given.
    const reused = await prepareWorkspace(clone("sess-clone-7", bare), ctx);
    expect(reused).toMatchObject({ cwd: path, created: false, branch: "codeden/seven" });
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
  /**
   * What `git credential fill` gets for a request, as a clone or push would ask the helpers
   * under the brokered credential's options: its output, or "" when no helper answered.
   */
  function fill(repo: string, request: string): string {
    try {
      return execFileSync("git", [...credentialArgs(credential), "credential", "fill"], {
        cwd: repo,
        input: `${request}\n\n`,
        env: {
          ...process.env,
          GIT_TERMINAL_PROMPT: "0",
          GCM_INTERACTIVE: "never",
          GIT_ASKPASS: "",
          SSH_ASKPASS: "",
          ...credentialEnv(credential),
        },
        encoding: "utf8",
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
      });
    } catch {
      return ""; // No helper answered, and prompts are off.
    }
  }

  it("answer git's credential request for their scope from the process's environment", () => {
    const repo = makeRepo();
    dirs.push(repo);
    // A helper the repository's own config adds is emptied out first.
    sh(repo, "config", "credential.helper", "!f() { echo password=from-the-repo; }; f");
    const out = fill(repo, "protocol=https\nhost=github.com\npath=acme/app.git");
    expect(out).toContain("username=x-access-token");
    expect(out).toContain(`password=${TOKEN}`);
    expect(out).not.toContain("from-the-repo");
  });

  it("are given to no other host or scheme (a rewritten remote, push URL or insteadOf)", () => {
    const repo = makeRepo();
    dirs.push(repo);
    for (const request of [
      "protocol=https\nhost=evil.example\npath=acme/app.git",
      "protocol=https\nhost=github.com.evil.example",
      "protocol=http\nhost=github.com\npath=acme/app.git",
    ]) {
      expect(fill(repo, request), request).not.toContain(TOKEN);
    }
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

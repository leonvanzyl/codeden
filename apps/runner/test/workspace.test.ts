import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { RunnerEvent } from "@codeden/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { branches, commit, push, status } from "../src/git/ops";
import { ProcessSupervisor } from "../src/process/supervisor";
import { assertRemovable, removeWorkspace } from "../src/workspace/removal";
import { prepareWorkspace, sessionShort, slugFromPath } from "../src/workspace/worktree";
import { makeRepo, removeDir, sh, tempDir, write } from "./helpers";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0).reverse()) removeDir(dir);
});

function setup(files?: Record<string, string>) {
  const repo = makeRepo(files);
  const home = tempDir("codeden-home-");
  dirs.push(repo, home);
  const events: RunnerEvent[] = [];
  const ctx = {
    home,
    supervisor: new ProcessSupervisor(),
    emit: (e: RunnerEvent) => events.push(e),
  };
  return { repo, home, events, ctx };
}

const prepare = (sessionId: string, repoPath: string, extra: Record<string, unknown> = {}) => ({
  name: "workspace.prepare" as const,
  sessionId,
  repoPath,
  strategy: "worktree" as const,
  setupCommands: [],
  ...extra,
});

// Git-heavy (clones, worktrees, fetches): slow on loaded Windows runners.
describe("workspace.prepare", () => {
  it("creates a worktree under <home>/wt/<slug>/<short> on codeden/<short> from the default branch", async () => {
    const { repo, home, ctx } = setup();
    sh(repo, "checkout", "-q", "-b", "other");
    write(repo, "other.txt", "o\n");
    sh(repo, "add", "-A");
    sh(repo, "commit", "-q", "-m", "other");

    const result = await prepareWorkspace(
      prepare("3f2a9c1e-7b4d-4e2a-9c1e-000000000001", repo, { projectSlug: "demo" }),
      ctx,
    );
    expect(result.cwd).toBe(resolve(join(home, "wt", "demo", "3f2a9c1e")));
    expect(result.branch).toBe("codeden/3f2a9c1e");
    expect(result.created).toBe(true);
    expect(sh(result.cwd, "symbolic-ref", "--short", "HEAD")).toBe("codeden/3f2a9c1e");
    // Based on main (the default branch), not the currently checked-out `other`.
    expect(existsSync(join(result.cwd, "other.txt"))).toBe(false);
    expect(sh(repo, "symbolic-ref", "--short", "HEAD")).toBe("other");

    // Idempotent: preparing again reuses the worktree.
    const again = await prepareWorkspace(
      prepare("3f2a9c1e-7b4d-4e2a-9c1e-000000000001", repo, { projectSlug: "demo" }),
      ctx,
    );
    expect(again).toMatchObject({ cwd: result.cwd, created: false, branch: "codeden/3f2a9c1e" });
  });

  it("respects a provided branch and base ref, and avoids taken default names", async () => {
    const { repo, ctx } = setup();
    const base = sh(repo, "rev-parse", "HEAD");
    write(repo, "second.txt", "2\n");
    sh(repo, "add", "-A");
    sh(repo, "commit", "-q", "-m", "second");

    const named = await prepareWorkspace(
      prepare("sess-a", repo, { branch: "feat/login", baseRef: base }),
      ctx,
    );
    expect(named.branch).toBe("feat/login");
    expect(sh(named.cwd, "rev-parse", "HEAD")).toBe(base);

    sh(repo, "branch", "codeden/sessb");
    const fallback = await prepareWorkspace(prepare("sess-b", repo), ctx);
    expect(fallback.branch).toBe("codeden/sessb-2");
    expect(fallback.cwd).toContain(join("wt", slugFromPath(repo), "sessb"));
  });

  it("runs .codeden/project.json setup in new worktrees and streams the output", async () => {
    const config = {
      setup: [
        "node -e \"console.log('installing'); require('fs').writeFileSync('setup.done', 'ok')\"",
      ],
      devServer: { command: "pnpm dev", port: 5173 },
      defaultProvider: "fake",
    };
    const { repo, events, ctx } = setup({ ".codeden/project.json": JSON.stringify(config) });
    const failing = "node -e \"console.error('lockfile missing'); process.exit(3)\"";
    const result = await prepareWorkspace(
      prepare("sess-setup", repo, { setupCommands: [failing, "echo never"] }),
      ctx,
    );
    expect(result.config).toMatchObject({ devServer: config.devServer, defaultProvider: "fake" });
    expect(readFileSync(join(result.cwd, "setup.done"), "utf8")).toBe("ok");
    // The failed step carries the end of its output, so the agent can be told why.
    expect(result.setup).toEqual([
      { command: config.setup[0], exitCode: 0, ok: true },
      { command: failing, exitCode: 3, ok: false, outputTail: "lockfile missing" },
    ]);
    const setupEvents = events.filter((e) => e.kind === "workspace.setup");
    const output = setupEvents
      .map((e) => (e.kind === "workspace.setup" ? (e.output ?? "") : ""))
      .join("");
    expect(output).toContain("installing");
    expect(setupEvents.map((e) => e.kind === "workspace.setup" && e.status)).toEqual([
      "running",
      "running",
      "succeeded",
      "running",
      "running",
      "failed",
    ]);
  });

  it("supports repo_root and existing strategies", async () => {
    const { repo, ctx } = setup();
    const root = await prepareWorkspace(
      { ...prepare("s", repo), strategy: "repo_root", setupCommands: ["echo hi"] },
      ctx,
    );
    expect(root).toMatchObject({ cwd: resolve(repo), branch: "main", created: false });
    expect(root.setup).toEqual([{ command: "echo hi", exitCode: 0, ok: true }]);

    const wt = `${repo}-existing`;
    dirs.push(wt);
    sh(repo, "worktree", "add", "-q", "-b", "ex", wt);
    const existing = await prepareWorkspace(
      { ...prepare("s", repo), strategy: "existing", path: wt },
      ctx,
    );
    expect(existing).toMatchObject({ cwd: resolve(wt), branch: "ex", created: false });
    await expect(
      prepareWorkspace(
        { ...prepare("s", repo), strategy: "existing", path: join(wt, "nope") },
        ctx,
      ),
    ).rejects.toMatchObject({ code: "not_found" });
  });

  it("fetches origin and branches from origin/<default> when asked", async () => {
    const { repo: upstream, ctx } = setup();
    const clone = tempDir("codeden-clone-");
    dirs.push(clone);
    sh(clone, "clone", "-q", upstream, ".");
    write(upstream, "fresh.txt", "new upstream work\n");
    sh(upstream, "add", "-A");
    sh(upstream, "commit", "-q", "-m", "upstream");

    const result = await prepareWorkspace(prepare("sess-f", clone, { fetch: true }), ctx);
    expect(existsSync(join(result.cwd, "fresh.txt"))).toBe(true);
  });

  it("removes a worktree and its branch", async () => {
    const { repo, home, ctx } = setup();
    const result = await prepareWorkspace(prepare("sess-rm", repo), ctx);
    write(result.cwd, "dirty.txt", "x\n");
    await expect(
      removeWorkspace({ name: "workspace.remove", repoPath: repo, path: result.cwd }, home),
    ).rejects.toMatchObject({ code: "worktree_dirty" });
    expect(existsSync(join(result.cwd, "dirty.txt"))).toBe(true);
    const removed = await removeWorkspace(
      {
        name: "workspace.remove",
        repoPath: repo,
        path: result.cwd,
        force: true,
        deleteBranch: result.branch ?? undefined,
      },
      home,
    );
    expect(removed.removed).toBe(true);
    expect(existsSync(result.cwd)).toBe(false);
    expect(sh(repo, "worktree", "list")).not.toContain("sess");
    expect(sh(repo, "branch", "--list", "codeden/*")).toBe("");
  });

  it("refuses a dirty worktree before touching it, but ignores ignored files", async () => {
    const { repo, home, ctx } = setup();
    write(repo, ".gitignore", "build/\n");
    sh(repo, "add", "-A");
    sh(repo, "commit", "-q", "-m", "ignore build");
    const result = await prepareWorkspace(prepare("sess-dirty", repo), ctx);
    const cmd = { name: "workspace.remove" as const, repoPath: repo, path: result.cwd };
    write(result.cwd, "build/out.js", "ignored\n");
    await expect(assertRemovable(cmd, home)).resolves.toMatchObject({ state: "registered" });
    write(result.cwd, "notes.txt", "uncommitted\n");
    await expect(assertRemovable(cmd, home)).rejects.toMatchObject({ code: "worktree_dirty" });
    await expect(assertRemovable({ ...cmd, force: true }, home)).resolves.toMatchObject({
      state: "registered",
    });
    expect(existsSync(join(result.cwd, "notes.txt"))).toBe(true);
  });

  it("recreates a removed worktree from its branch", async () => {
    const { repo, home, ctx } = setup();
    const first = await prepareWorkspace(prepare("sess-back", repo), ctx);
    write(first.cwd, "work.txt", "committed\n");
    sh(first.cwd, "add", "-A");
    sh(first.cwd, "commit", "-q", "-m", "work");
    await removeWorkspace({ name: "workspace.remove", repoPath: repo, path: first.cwd }, home);
    expect(existsSync(first.cwd)).toBe(false);
    const again = await prepareWorkspace(
      prepare("sess-back", repo, { path: first.cwd, branch: first.branch ?? undefined }),
      ctx,
    );
    expect(again.cwd).toBe(first.cwd);
    expect(again.branch).toBe(first.branch);
    expect(existsSync(join(again.cwd, "work.txt"))).toBe(true);
  });
});

describe("git operations", () => {
  it("lists branches, commits and pushes to a remote", async () => {
    const { repo, ctx } = setup();
    const remote = tempDir("codeden-remote-");
    dirs.push(remote);
    sh(remote, "init", "-q", "--bare");
    sh(repo, "remote", "add", "origin", remote);

    const ws = await prepareWorkspace(prepare("sess-git", repo), ctx);
    expect(await commit({ name: "git.commit", cwd: ws.cwd, message: "noop" })).toEqual({
      commit: null,
    });
    write(ws.cwd, "feature.ts", "export {};\n");
    write(ws.cwd, "other.ts", "export {};\n");
    const made = await commit({
      name: "git.commit",
      cwd: ws.cwd,
      message: "feat: add",
      paths: ["feature.ts"],
    });
    expect(made.commit).toBe(sh(ws.cwd, "rev-parse", "HEAD"));
    expect(sh(ws.cwd, "show", "--name-only", "--format=", "HEAD")).toBe("feature.ts");
    expect((await status(ws.cwd)).files).toEqual([{ path: "other.ts", status: "??" }]);

    const pushed = await push({ name: "git.push", cwd: ws.cwd });
    expect(pushed).toEqual({ remote: "origin", branch: ws.branch });
    expect(sh(remote, "rev-parse", `refs/heads/${ws.branch}`)).toBe(made.commit);
    const st = await status(ws.cwd);
    expect(st).toMatchObject({ branch: ws.branch, ahead: 0, behind: 0 });

    const list = await branches({ name: "git.branches", cwd: ws.cwd, includeRemote: true });
    expect(list.current).toBe(ws.branch);
    expect(list.defaultBranch).toBe("main");
    const local = list.branches.find((b) => b.name === ws.branch);
    expect(local).toMatchObject({ remote: false, upstream: `origin/${ws.branch}` });
    expect(list.branches.some((b) => b.remote && b.name === `origin/${ws.branch}`)).toBe(true);
  });

  it("derives short session names", () => {
    expect(sessionShort("ABCD-1234-ef")).toBe("abcd1234");
    expect(sessionShort("x")).toMatch(/^[0-9a-f]{8}$/);
  });
});

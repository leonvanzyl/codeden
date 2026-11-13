import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ProcessSupervisor } from "../src/process/supervisor";
import { removeWorkspace, worktreeState } from "../src/workspace/removal";
import { emptyTrash, isManagedWorktreePath, trashDir } from "../src/workspace/trash";
import { prepareWorkspace } from "../src/workspace/worktree";
import { makeRepo, removeDir, sh, tempDir, waitUntil, write } from "./helpers";

const homes: string[] = [];
const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(homes.splice(0).map((home) => emptyTrash(home)));
  for (const dir of dirs.splice(0).reverse()) removeDir(dir);
});

function setup() {
  const repo = makeRepo({ "README.md": "# demo\n", ".gitignore": "node_modules/\n" });
  const home = tempDir("codeden-home-");
  dirs.push(repo, home);
  homes.push(home);
  const ctx = { home, supervisor: new ProcessSupervisor(), emit: () => undefined };
  return { repo, home, ctx };
}

const prepare = (sessionId: string, repoPath: string, extra: Record<string, unknown> = {}) => ({
  name: "workspace.prepare" as const,
  sessionId,
  repoPath,
  strategy: "worktree" as const,
  projectSlug: "demo",
  setupCommands: [],
  ...extra,
});

const remove = (repoPath: string, path: string, extra: Record<string, unknown> = {}) => ({
  name: "workspace.remove" as const,
  repoPath,
  path,
  ...extra,
});

const listed = (repo: string) => sh(repo, "worktree", "list", "--porcelain");
const trashEntries = (home: string) =>
  existsSync(trashDir(home)) ? readdirSync(trashDir(home)) : [];
const outsideDir = (contents: Record<string, string>) => {
  const dir = tempDir("codeden-outside-");
  dirs.push(dir);
  for (const [path, text] of Object.entries(contents)) write(dir, path, text);
  return dir;
};

/** What an interrupted `git worktree remove` leaves: no `.git`, some files gone, the rest kept. */
function halfDelete(cwd: string): void {
  write(cwd, "node_modules/pkg/index.js", "left over\n");
  rmSync(join(cwd, ".git"));
  rmSync(join(cwd, ".gitignore"));
}

// Git-heavy (worktrees, removals): slow on loaded Windows runners.
describe("workspace.remove", () => {
  it("removes a pnpm-style node_modules without following links out of the worktree", async () => {
    const { repo, home, ctx } = setup();
    const wt = await prepareWorkspace(prepare("sess-links", repo), ctx);
    const outside = outsideDir({ "keep.txt": "precious\n", "deep/keep.txt": "precious\n" });
    const store = join(wt.cwd, "node_modules", ".pnpm");
    write(store, "a@1/node_modules/a/index.js", "a\n");
    write(store, "b@1/node_modules/b/index.js", "b\n");
    // A package linked to its store folder, a dependency link inside the store, a link out of
    // the worktree, and a link whose target is already gone.
    symlinkSync(join(store, "a@1/node_modules/a"), join(wt.cwd, "node_modules/a"), "junction");
    symlinkSync(join(store, "a@1/node_modules/a"), join(store, "b@1/node_modules/a"), "junction");
    symlinkSync(outside, join(wt.cwd, "node_modules/linked"), "junction");
    symlinkSync(join(store, "gone@1"), join(store, "b@1/node_modules/gone"), "junction");

    const result = await removeWorkspace(remove(repo, wt.cwd), home);
    expect(result).toEqual({ removed: true });
    expect(existsSync(wt.cwd)).toBe(false);
    expect(listed(repo)).not.toContain("sess");
    expect(sh(repo, "branch", "--list", wt.branch ?? "")).toContain(wt.branch);

    // The folder went to the trash and is deleted in the background.
    await emptyTrash(home);
    expect(trashEntries(home)).toEqual([]);
    expect(readFileSync(join(outside, "keep.txt"), "utf8")).toBe("precious\n");
    expect(readFileSync(join(outside, "deep/keep.txt"), "utf8")).toBe("precious\n");
  });

  it("never follows a trashed link into the worktree now living at the old path", async () => {
    const { repo, home, ctx } = setup();
    const wt = await prepareWorkspace(prepare("sess-again", repo), ctx);
    const pkg = join(wt.cwd, "node_modules/.pnpm/a@1/node_modules/a");
    write(pkg, "index.js", "live\n");
    // Links keep their absolute targets, so a trashed install points back at the old path,
    // where the session's recreated worktree lives now.
    const trashed = join(trashDir(home), "demo-sess-old");
    mkdirSync(join(trashed, "node_modules"), { recursive: true });
    symlinkSync(pkg, join(trashed, "node_modules/a"), "junction");
    symlinkSync(wt.cwd, join(trashed, "worktree"), "junction");

    await emptyTrash(home);
    expect(trashEntries(home)).toEqual([]);
    expect(readFileSync(join(pkg, "index.js"), "utf8")).toBe("live\n");
    expect(await worktreeState(repo, wt.cwd)).toMatchObject({ state: "registered" });
  });

  it("reports discarded uncommitted changes on a forced removal", async () => {
    const { repo, home, ctx } = setup();
    const wt = await prepareWorkspace(prepare("sess-force", repo), ctx);
    write(wt.cwd, "draft.txt", "not committed\n");
    await expect(removeWorkspace(remove(repo, wt.cwd), home)).rejects.toMatchObject({
      code: "worktree_dirty",
    });
    await expect(removeWorkspace(remove(repo, wt.cwd, { force: true }), home)).resolves.toEqual({
      removed: true,
      discardedChanges: true,
    });
    expect(existsSync(wt.cwd)).toBe(false);
  });

  it("cleans up a half-deleted worktree instead of reporting it kept", async () => {
    const { repo, home, ctx } = setup();
    const wt = await prepareWorkspace(prepare("sess-half", repo), ctx);
    halfDelete(wt.cwd);
    expect(await worktreeState(repo, wt.cwd)).toMatchObject({ state: "orphan", registered: true });

    const cmd = remove(repo, wt.cwd, { deleteBranch: wt.branch });
    await expect(removeWorkspace(cmd, home)).resolves.toEqual({ removed: true });
    expect(existsSync(wt.cwd)).toBe(false);
    expect(listed(repo)).not.toContain("sess");
    // The branch goes only when asked for, also after the fallback.
    expect(sh(repo, "branch", "--list", "codeden/*")).toBe("");
    // Idempotent: removing what is already gone succeeds.
    await expect(removeWorkspace(cmd, home)).resolves.toEqual({ removed: true });
  });

  it("cleans up an orphan folder git has already forgotten", async () => {
    const { repo, home, ctx } = setup();
    const wt = await prepareWorkspace(prepare("sess-pruned", repo), ctx);
    halfDelete(wt.cwd);
    sh(repo, "worktree", "prune");
    expect(await worktreeState(repo, wt.cwd)).toMatchObject({ state: "orphan", registered: false });

    await expect(removeWorkspace(remove(repo, wt.cwd), home)).resolves.toEqual({ removed: true });
    expect(existsSync(wt.cwd)).toBe(false);
    expect(sh(repo, "branch", "--list", wt.branch ?? "")).toContain(wt.branch);
  });

  it("never deletes a folder outside <home>/wt/<project>/<session> that isn't a worktree", async () => {
    const { repo, home } = setup();
    const stray = outsideDir({ "important.txt": "keep\n" });
    for (const force of [false, true]) {
      await expect(removeWorkspace(remove(repo, stray, { force }), home)).rejects.toMatchObject({
        code: "not_a_worktree",
      });
    }
    expect(readFileSync(join(stray, "important.txt"), "utf8")).toBe("keep\n");

    // A whole project's folder inside <home>/wt is not a session folder either.
    const project = join(home, "wt", "demo");
    write(project, "other-session/keep.txt", "keep\n");
    await expect(
      removeWorkspace(remove(repo, project, { force: true }), home),
    ).rejects.toMatchObject({ code: "not_a_worktree" });
    expect(existsSync(join(project, "other-session/keep.txt"))).toBe(true);
  });

  it("leaves the repository, another clone and a folder holding a worktree alone", async () => {
    const { repo, home, ctx } = setup();
    await expect(removeWorkspace(remove(repo, repo, { force: true }), home)).rejects.toMatchObject({
      code: "not_a_worktree",
    });
    expect(existsSync(join(repo, ".git"))).toBe(true);

    const clone = join(home, "wt", "demo", "clone");
    mkdirSync(dirname(clone), { recursive: true });
    sh(home, "clone", "-q", repo, clone);
    await expect(removeWorkspace(remove(repo, clone, { force: true }), home)).rejects.toMatchObject(
      { code: "not_a_worktree" },
    );
    expect(existsSync(join(clone, ".git"))).toBe(true);

    // An orphan session folder that a live worktree sits inside.
    const holder = join(home, "wt", "demo", "holder");
    const nested = await prepareWorkspace(
      prepare("sess-nested", repo, { path: join(holder, "inner") }),
      ctx,
    );
    await expect(
      removeWorkspace(remove(repo, holder, { force: true }), home),
    ).rejects.toMatchObject({ code: "not_a_worktree" });
    expect(existsSync(join(nested.cwd, ".git"))).toBe(true);
  });

  it.runIf(process.platform === "win32")(
    "leaves a worktree that is in use untouched, then removes it on the next attempt",
    async () => {
      const { repo, home, ctx } = setup();
      const wt = await prepareWorkspace(prepare("sess-locked", repo), ctx);
      const busy = join(wt.cwd, "node_modules", "busy");
      mkdirSync(busy, { recursive: true });
      // Windows won't move a folder that holds some process's working directory.
      const holder = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], {
        cwd: busy,
        stdio: "ignore",
      });
      let exited = false;
      holder.once("exit", () => {
        exited = true;
      });
      try {
        await expect(removeWorkspace(remove(repo, wt.cwd), home)).rejects.toMatchObject({
          code: "worktree_in_use",
        });
        // All or nothing: still a healthy, registered worktree.
        expect(await worktreeState(repo, wt.cwd)).toMatchObject({ state: "registered" });
        expect(existsSync(join(wt.cwd, "README.md"))).toBe(true);
      } finally {
        holder.kill();
        await waitUntil(() => exited);
      }
      await expect(removeWorkspace(remove(repo, wt.cwd), home)).resolves.toEqual({
        removed: true,
      });
      expect(existsSync(wt.cwd)).toBe(false);
    },
  );
});

describe("workspace.prepare after an interrupted removal", () => {
  it("replaces a half-deleted leftover at the target path with the worktree from its branch", async () => {
    const { repo, ctx } = setup();
    const first = await prepareWorkspace(prepare("sess-redo", repo), ctx);
    write(first.cwd, "work.txt", "committed\n");
    sh(first.cwd, "add", "-A");
    sh(first.cwd, "commit", "-q", "-m", "work");
    halfDelete(first.cwd);
    rmSync(join(first.cwd, "work.txt"));

    const again = await prepareWorkspace(
      prepare("sess-redo", repo, { path: first.cwd, branch: first.branch }),
      ctx,
    );
    expect(again).toMatchObject({ cwd: first.cwd, branch: first.branch, created: true });
    expect(readFileSync(join(again.cwd, "work.txt"), "utf8")).toBe("committed\n");
    expect(existsSync(join(again.cwd, "node_modules"))).toBe(false);
    expect(await worktreeState(repo, again.cwd)).toMatchObject({ state: "registered" });
  });

  it("still refuses a non-empty folder outside <home>/wt that isn't a worktree", async () => {
    const { repo, ctx } = setup();
    const stray = outsideDir({ "a.txt": "mine\n" });
    await expect(
      prepareWorkspace(prepare("sess-stray", repo, { path: stray }), ctx),
    ).rejects.toMatchObject({ code: "path_exists" });
    expect(readFileSync(join(stray, "a.txt"), "utf8")).toBe("mine\n");
  });
});

describe("isManagedWorktreePath", () => {
  it("only matches <home>/wt/<project>/<session>", () => {
    const home = resolve("/data/codeden");
    expect(isManagedWorktreePath(home, join(home, "wt", "app", "s1"))).toBe(true);
    expect(isManagedWorktreePath(home, join(home, "wt"))).toBe(false);
    expect(isManagedWorktreePath(home, join(home, "wt", "app"))).toBe(false);
    expect(isManagedWorktreePath(home, join(home, "wt", "app", "s1", "src"))).toBe(false);
    expect(isManagedWorktreePath(home, join(home, "wt", "app", "..", "..", "x", "y"))).toBe(false);
    expect(isManagedWorktreePath(home, join(home, "wt", ".trash", "s1"))).toBe(false);
    expect(isManagedWorktreePath(home, join(home, "repos", "app", "s1"))).toBe(false);
    expect(isManagedWorktreePath(home, resolve("/elsewhere/wt/app/s1"))).toBe(false);
  });
});

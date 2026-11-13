import { existsSync, readFileSync, statSync, utimesSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createCheckpoint,
  deleteCheckpoints,
  diffCheckpoints,
  listCheckpoints,
  nextCheckpointIndex,
  refComponent,
  restoreFiles,
} from "../src/git/checkpoints";
import { diff as gitDiff, status as gitStatus } from "../src/git/ops";
import { makeRepo, removeDir, sh, write } from "./helpers";

const repos: string[] = [];
function repo(files?: Record<string, string>): string {
  const dir = makeRepo(files);
  repos.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of repos.splice(0)) removeDir(dir);
});

const BINARY = Buffer.from([0, 1, 2, 3, 255, 254, 0, 10, 13, 0]);

/** Everything that identifies the user's state: index content, HEAD, branch, status. */
function userState(dir: string) {
  return {
    head: sh(dir, "rev-parse", "HEAD"),
    branch: sh(dir, "symbolic-ref", "HEAD"),
    index: sh(dir, "ls-files", "--stage"),
    status: sh(dir, "status", "--porcelain"),
  };
}

// Each test runs several git commands; on loaded Windows runners that alone can take over 5 s.
describe("turn checkpoints", () => {
  it("snapshots tracked, untracked, deleted and binary files but not ignored ones", async () => {
    const dir = repo({
      "README.md": "# demo\n",
      "src/keep.ts": "export const a = 1;\n",
      "src/gone.ts": "export const b = 2;\n",
      ".gitignore": "node_modules/\n*.log\n",
    });
    sh(dir, "add", "-A"); // staged state the user may have
    const base = await createCheckpoint(dir, "s1", 0);
    expect(base.ref).toBe("refs/codeden/checkpoints/s1/0");

    write(dir, "src/keep.ts", "export const a = 42;\n");
    write(dir, "src/new.ts", "export const c = 3;\n"); // untracked
    write(dir, "assets/logo.bin", BINARY);
    write(dir, "node_modules/pkg/index.js", "ignored\n");
    write(dir, "debug.log", "ignored\n");
    sh(dir, "rm", "-q", "--cached", "src/gone.ts"); // a staged deletion the user made
    const before = userState(dir);
    await createCheckpoint(dir, "s1", 1, "turn-1");
    expect(userState(dir)).toEqual(before);

    const tree = sh(dir, "ls-tree", "-r", "--name-only", "refs/codeden/checkpoints/s1/1");
    expect(tree.split("\n").sort()).toEqual(
      [
        ".gitignore",
        "README.md",
        "assets/logo.bin",
        "src/gone.ts",
        "src/keep.ts",
        "src/new.ts",
      ].sort(),
    );

    const { diff, files } = await diffCheckpoints(dir, "s1", 0, 1);
    expect(files).toEqual(
      expect.arrayContaining([
        { path: "src/keep.ts", status: "modified", additions: 1, deletions: 1, binary: false },
        { path: "src/new.ts", status: "added", additions: 1, deletions: 0, binary: false },
        { path: "assets/logo.bin", status: "added", additions: 0, deletions: 0, binary: true },
      ]),
    );
    expect(files).toHaveLength(3);
    expect(diff).toContain("+export const a = 42;");
    expect(diff).toContain("Binary files");
    expect(diff).not.toContain("node_modules");
  });

  it("records file deletions in the working tree and chains checkpoints", async () => {
    const dir = repo({ "a.txt": "a\n", "b.txt": "b\n" });
    await createCheckpoint(dir, "s1", 0);
    await import("node:fs/promises").then((fs) => fs.rm(join(dir, "b.txt")));
    const cp1 = await createCheckpoint(dir, "s1", 1, "t1");
    const { files } = await diffCheckpoints(dir, "s1", 0, 1);
    expect(files).toEqual([
      { path: "b.txt", status: "deleted", additions: 0, deletions: 1, binary: false },
    ]);
    expect(sh(dir, "rev-parse", `${cp1.commit}^`)).toBe(
      sh(dir, "rev-parse", "refs/codeden/checkpoints/s1/0"),
    );
    expect(sh(dir, "log", "-1", "--format=%B", cp1.commit)).toContain("Turn: t1");
    const list = await listCheckpoints(dir, "s1");
    expect(list.map((c) => c.index)).toEqual([0, 1]);
    expect(await nextCheckpointIndex(dir, "s1")).toBe(2);
    expect(await nextCheckpointIndex(dir, "other")).toBe(0);
  });

  it("diffs a checkpoint against the live working tree", async () => {
    const dir = repo();
    await createCheckpoint(dir, "s1", 0);
    write(dir, "later.txt", "x\n");
    const { files } = await diffCheckpoints(dir, "s1", 0);
    expect(files.map((f) => f.path)).toEqual(["later.txt"]);
    await expect(diffCheckpoints(dir, "s1", 7)).rejects.toMatchObject({
      code: "unknown_checkpoint",
    });
  });

  it("restores all files to a checkpoint without touching the index", async () => {
    const dir = repo({ "a.txt": "a\n", "b.txt": "b\n", ".gitignore": "*.log\n" });
    write(dir, "untracked-at-start.txt", "u\n");
    write(dir, "img.bin", BINARY);
    await createCheckpoint(dir, "s1", 0);
    const indexBefore = sh(dir, "ls-files", "--stage");

    write(dir, "a.txt", "changed\n");
    await import("node:fs/promises").then((fs) => fs.rm(join(dir, "b.txt")));
    await import("node:fs/promises").then((fs) => fs.rm(join(dir, "img.bin")));
    write(dir, "created.txt", "new\n");
    write(dir, "keep.log", "ignored stays\n");

    const result = await restoreFiles(dir, "s1", 0);
    expect(result.restored.sort()).toEqual(["a.txt", "b.txt", "img.bin"]);
    expect(result.deleted).toEqual(["created.txt"]);
    expect(readFileSync(join(dir, "a.txt"), "utf8")).toBe("a\n");
    expect(readFileSync(join(dir, "b.txt"), "utf8")).toBe("b\n");
    expect(readFileSync(join(dir, "img.bin")).equals(BINARY)).toBe(true);
    expect(readFileSync(join(dir, "untracked-at-start.txt"), "utf8")).toBe("u\n");
    expect(existsSync(join(dir, "created.txt"))).toBe(false);
    expect(existsSync(join(dir, "keep.log"))).toBe(true);
    expect(sh(dir, "ls-files", "--stage")).toBe(indexBefore);
  });

  it("restores only the requested paths", async () => {
    const dir = repo({ "a.txt": "a\n", "dir/b.txt": "b\n", "dir/c.txt": "c\n" });
    await createCheckpoint(dir, "s1", 0);
    write(dir, "a.txt", "A\n");
    write(dir, "dir/b.txt", "B\n");
    write(dir, "dir/c.txt", "C\n");
    write(dir, "dir/new.txt", "N\n");
    const result = await restoreFiles(dir, "s1", 0, ["dir"]);
    expect(result.restored.sort()).toEqual(["dir/b.txt", "dir/c.txt"]);
    expect(result.deleted).toEqual(["dir/new.txt"]);
    expect(readFileSync(join(dir, "a.txt"), "utf8")).toBe("A\n");
    expect(readFileSync(join(dir, "dir/b.txt"), "utf8")).toBe("b\n");
  });

  it("works in a fresh repo without commits and in linked worktrees", async () => {
    const dir = repo();
    const fresh = join(dir, "..", `${refComponent("fresh")}-${Date.now()}`);
    repos.push(fresh);
    sh(dir, "init", "-q", fresh);
    write(fresh, "x.txt", "x\n");
    const cp = await createCheckpoint(fresh, "s1", 0);
    expect(sh(fresh, "ls-tree", "--name-only", cp.commit)).toBe("x.txt");

    const wt = `${dir}-wt`;
    repos.push(wt);
    sh(dir, "worktree", "add", "-q", "-b", "feature", wt);
    write(wt, "feature.txt", "f\n");
    await createCheckpoint(wt, "s2", 0);
    // Checkpoint refs are shared by all worktrees of the repo.
    expect(sh(dir, "for-each-ref", "--format=%(refname)", "refs/codeden/")).toContain("s2/0");
    expect(sh(wt, "status", "--porcelain")).toBe("?? feature.txt");
  });

  it("sanitizes session ids in ref names and deletes a session's refs", async () => {
    const dir = repo();
    const cp = await createCheckpoint(dir, "weird id/../x", 0);
    expect(cp.ref).toBe("refs/codeden/checkpoints/weird_id____x/0");
    await deleteCheckpoints(dir, "weird id/../x");
    expect(await listCheckpoints(dir, "weird id/../x")).toEqual([]);
  });

  it("keeps file modes (executable bit) through snapshot and restore", async () => {
    if (process.platform === "win32") return; // no exec bit on NTFS
    const dir = repo({ "run.sh": "#!/bin/sh\n" });
    await import("node:fs/promises").then((fs) => fs.chmod(join(dir, "run.sh"), 0o755));
    await createCheckpoint(dir, "s1", 0);
    await import("node:fs/promises").then((fs) => fs.rm(join(dir, "run.sh")));
    await restoreFiles(dir, "s1", 0);
    expect(statSync(join(dir, "run.sh")).mode & 0o111).not.toBe(0);
  });
});

describe("git.diff and git.status", () => {
  it("diffs HEAD against the working tree including untracked files", async () => {
    const dir = repo({ "a.txt": "a\n" });
    write(dir, "a.txt", "b\n");
    write(dir, "new.txt", "n\n");
    const result = await gitDiff({ name: "git.diff", cwd: dir, fromRef: "HEAD" });
    expect(result.files?.map((f) => `${f.status}:${f.path}`).sort()).toEqual([
      "added:new.txt",
      "modified:a.txt",
    ]);
    const st = await gitStatus(dir);
    expect(st.branch).toBe("main");
    expect(st.files).toEqual(
      expect.arrayContaining([
        { path: "a.txt", status: " M" },
        { path: "new.txt", status: "??" },
      ]),
    );
  });

  it("sees a same-size rewrite in the same timestamp tick as the index (racy git)", async () => {
    // Pin every timestamp git compares to one second, as when an agent rewrites a file in the
    // same second the index was written. The stat data then matches the index entry, and only
    // git's racy-clean check (index mtime <= entry mtime: re-read the content) catches it. The
    // temporary index must keep the real one's mtime for that check to work: on Linux a plain
    // copy is stamped "now" and this rewrite went missing (issue #8).
    const tick = new Date(Math.floor(Date.now() / 1000) * 1000 - 60_000);
    const dir = repo({ "README.md": "# demo\n" });
    sh(dir, "config", "core.trustctime", "false"); // a rewrite changes ctime; pin it out
    write(dir, "a.txt", "a\n");
    utimesSync(join(dir, "a.txt"), tick, tick);
    sh(dir, "add", "a.txt");
    sh(dir, "commit", "-q", "-m", "add a");
    utimesSync(join(dir, ".git", "index"), tick, tick);
    write(dir, "a.txt", "b\n");
    utimesSync(join(dir, "a.txt"), tick, tick);

    const result = await gitDiff({ name: "git.diff", cwd: dir, fromRef: "HEAD" });
    expect(result.files?.map((f) => `${f.status}:${f.path}`)).toEqual(["modified:a.txt"]);
    await createCheckpoint(dir, "s1", 0);
    expect(sh(dir, "show", `${refComponentRef("s1", 0)}:a.txt`)).toBe("b");
  });
});

const refComponentRef = (sessionId: string, index: number) =>
  `refs/codeden/checkpoints/${refComponent(sessionId)}/${index}`;

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { RunnerEvent } from "@codeden/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { createCheckpoint } from "../src/git/checkpoints";
import { ProcessSupervisor } from "../src/process/supervisor";
import { prepareWorkspace } from "../src/workspace/worktree";
import { makeRepo, removeDir, sh, tempDir, write } from "./helpers";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0).reverse()) removeDir(dir);
});

const prepare = (sessionId: string, repoPath: string, extra: Record<string, unknown> = {}) => ({
  name: "workspace.prepare" as const,
  sessionId,
  repoPath,
  strategy: "worktree" as const,
  setupCommands: [],
  ...extra,
});

/**
 * A source session with committed work on its branch, then uncommitted edits (a change, an
 * untracked file and a deletion) snapshotted as its latest checkpoint.
 */
async function sourceSession() {
  const repo = makeRepo({ "README.md": "# demo\n", "a.txt": "a\n", "gone.txt": "bye\n" });
  const home = tempDir("codeden-home-");
  dirs.push(repo, home);
  const events: RunnerEvent[] = [];
  const ctx = {
    home,
    supervisor: new ProcessSupervisor(),
    emit: (e: RunnerEvent) => events.push(e),
  };
  const source = await prepareWorkspace(prepare("src-session", repo), ctx);
  await createCheckpoint(source.cwd, "src-session", 0);
  write(source.cwd, "b.txt", "committed by the agent\n");
  sh(source.cwd, "add", "-A");
  sh(source.cwd, "commit", "-q", "-m", "agent work");
  write(source.cwd, "a.txt", "changed in the last turn\n");
  write(source.cwd, "new.txt", "untracked\n");
  sh(source.cwd, "rm", "-q", "gone.txt");
  await createCheckpoint(source.cwd, "src-session", 1);
  return { repo, ctx, source: { cwd: source.cwd, branch: source.branch as string } };
}

// Git-heavy (worktrees, checkpoints): slow on loaded Windows runners.
describe("workspace.prepare for a fork", { timeout: 30_000 }, () => {
  it("branches from the source branch and restores its latest checkpoint before setup", async () => {
    const { repo, ctx, source } = await sourceSession();
    const sourceStatus = sh(source.cwd, "status", "--porcelain");
    // Setup sees the restored files: it copies a.txt as it is when setup runs.
    const copy = "node -e \"require('fs').copyFileSync('a.txt', 'seen-by-setup.txt')\"";
    const fork = await prepareWorkspace(
      prepare("fork-session", repo, {
        baseRef: source.branch,
        restoreCheckpoint: { sessionId: "src-session", index: 1 },
        setupCommands: [copy],
      }),
      ctx,
    );
    expect(fork.created).toBe(true);
    expect(fork.branch).not.toBe(source.branch);
    expect(fork.setup).toEqual([{ command: copy, exitCode: 0, ok: true }]);

    // The branch is the source's real history: no checkpoint commits.
    expect(sh(fork.cwd, "rev-parse", "HEAD")).toBe(sh(repo, "rev-parse", source.branch));
    expect(sh(fork.cwd, "log", "--format=%s")).not.toMatch(/CodeDen checkpoint/);

    // The checkpoint's files, as uncommitted changes on top of it.
    const read = (path: string) => readFileSync(join(fork.cwd, path), "utf8");
    expect(read("a.txt")).toBe("changed in the last turn\n");
    expect(read("b.txt")).toBe("committed by the agent\n");
    expect(read("new.txt")).toBe("untracked\n");
    expect(existsSync(join(fork.cwd, "gone.txt"))).toBe(false);
    expect(read("seen-by-setup.txt")).toBe("changed in the last turn\n");
    expect(sh(fork.cwd, "diff", "--cached", "--name-only")).toBe("");
    expect(sh(fork.cwd, "diff", "--name-status").split("\n").sort()).toEqual([
      "D\tgone.txt",
      "M\ta.txt",
    ]);
    expect(sh(fork.cwd, "ls-files", "--others", "--exclude-standard")).toContain("new.txt");

    // The source is untouched.
    expect(sh(source.cwd, "status", "--porcelain")).toBe(sourceStatus);
    expect(sh(source.cwd, "symbolic-ref", "--short", "HEAD")).toBe(source.branch);
  });

  it("never restores over a fork's own work when its worktree already exists", async () => {
    const { repo, ctx, source } = await sourceSession();
    const cmd = prepare("fork-session", repo, {
      baseRef: source.branch,
      restoreCheckpoint: { sessionId: "src-session", index: 1 },
    });
    const fork = await prepareWorkspace(cmd, ctx);
    write(fork.cwd, "a.txt", "the fork's own work\n");
    const again = await prepareWorkspace(cmd, ctx);
    expect(again).toMatchObject({ cwd: fork.cwd, created: false });
    expect(readFileSync(join(fork.cwd, "a.txt"), "utf8")).toBe("the fork's own work\n");
  });

  it("fails when the checkpoint does not exist", async () => {
    const { repo, ctx, source } = await sourceSession();
    await expect(
      prepareWorkspace(
        prepare("fork-missing", repo, {
          baseRef: source.branch,
          restoreCheckpoint: { sessionId: "src-session", index: 9 },
        }),
        ctx,
      ),
    ).rejects.toMatchObject({ code: "unknown_checkpoint" });
  });
});

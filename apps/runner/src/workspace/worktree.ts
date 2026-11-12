import { createHash } from "node:crypto";
import { existsSync, readdirSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import type { RunnerCommandOf, RunnerCommandResult, RunnerEvent } from "@codeden/contracts";
import { CommandError } from "../errors";
import { restoreFiles, topLevel } from "../git/checkpoints";
import { git, gitOk, isWorkTree } from "../git/exec";
import { currentBranch, defaultBranch } from "../git/ops";
import type { ProcessSupervisor } from "../process/supervisor";
import { endProcessesInside } from "../process/worktree-processes";
import { readProjectConfig } from "./project-config";
import { pruneWorktrees, worktreeState } from "./removal";
import { runSetup, type SetupStep } from "./setup";
import { discardFolder, isManagedWorktreePath } from "./trash";

export interface WorkspaceContext {
  home: string;
  supervisor: ProcessSupervisor;
  emit: (event: RunnerEvent) => void;
}

/** Short, path-safe form of a session id (worktree directory and default branch name). */
export function sessionShort(sessionId: string): string {
  const cleaned = sessionId.toLowerCase().replace(/[^a-z0-9]/g, "");
  if (cleaned.length >= 4) return cleaned.slice(0, 8);
  return createHash("sha256").update(sessionId).digest("hex").slice(0, 8);
}

/** Project slug from a repo path when the server didn't send one. */
export function slugFromPath(repoPath: string): string {
  const slug = basename(resolve(repoPath))
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  return slug || "project";
}

function branchExists(cwd: string, branch: string): Promise<boolean> {
  return gitOk(cwd, ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`]);
}

async function uniqueBranch(cwd: string, wanted: string): Promise<string> {
  if (!(await branchExists(cwd, wanted))) return wanted;
  for (let i = 2; i < 100; i++) {
    const candidate = `${wanted}-${i}`;
    if (!(await branchExists(cwd, candidate))) return candidate;
  }
  throw new CommandError("branch_exists", `No free branch name for ${wanted}`);
}

/**
 * The ref a new worktree branches from: `cmd.baseRef`, else the repository's default branch.
 * After a successful `fetch`, a local branch with nothing of its own is swapped for its freshly
 * fetched `origin/` copy (see `freshestBase`). A failed fetch (offline) keeps the local ref.
 */
async function resolveBase(
  repo: string,
  cmd: RunnerCommandOf<"workspace.prepare">,
): Promise<string> {
  let fetched = false;
  const hasOrigin = await gitOk(repo, ["remote", "get-url", "origin"]);
  if (cmd.fetch && hasOrigin) {
    fetched = await git(repo, ["fetch", "--prune", "origin"], { timeoutMs: 120_000 }).then(
      () => true,
      () => false,
    );
  }
  const base = cmd.baseRef ?? (await defaultBranch(repo)) ?? "HEAD";
  return fetched ? freshestBase(repo, base) : base;
}

/**
 * `origin/<base>` when the local branch `<base>` is behind it or equal (an ancestor), or
 * missing; otherwise `base`. A local branch that is ahead or has diverged is kept: its own
 * commits are the user's. Refs that aren't plain branch names (`origin/x`, a commit, `HEAD`)
 * are returned as they are.
 */
export async function freshestBase(repo: string, base: string): Promise<string> {
  if (base === "HEAD" || base.startsWith("origin/")) return base;
  const remote = `refs/remotes/origin/${base}`;
  if (!(await gitOk(repo, ["rev-parse", "--verify", "--quiet", remote]))) return base;
  if (!(await branchExists(repo, base))) return `origin/${base}`;
  const behind = await gitOk(repo, ["merge-base", "--is-ancestor", `refs/heads/${base}`, remote]);
  return behind ? `origin/${base}` : base;
}

function isEmptyDir(path: string): boolean {
  try {
    return readdirSync(path).length === 0;
  } catch {
    return false;
  }
}

/**
 * Make `path` ready for `git worktree add`: reuse a worktree of this repository, delete the
 * orphan folder an interrupted removal left inside `<home>/wt` (stopping processes in it
 * first), and drop git's stale record of it. Returns the worktree to reuse, if any.
 */
async function clearTarget(
  repo: string,
  path: string,
  ctx: WorkspaceContext,
): Promise<{ cwd: string; branch: string | null; created: boolean } | null> {
  const info = await worktreeState(repo, path);
  if (info.state === "registered") {
    return { cwd: path, branch: await currentBranch(path), created: false };
  }
  if (info.state === "orphan" && isManagedWorktreePath(ctx.home, path) && !info.containsOther) {
    await ctx.supervisor.killUnder(path);
    await endProcessesInside(path, { home: ctx.home });
    await discardFolder(ctx.home, path);
  } else if (info.state !== "missing" && !isEmptyDir(path)) {
    throw new CommandError("path_exists", `${path} exists and is not a worktree`);
  }
  if (info.registered) await pruneWorktrees(repo);
  return null;
}

async function createWorktree(
  cmd: RunnerCommandOf<"workspace.prepare">,
  ctx: WorkspaceContext,
): Promise<{ cwd: string; branch: string | null; created: boolean }> {
  const repo = await topLevel(cmd.repoPath).catch(() => {
    throw new CommandError("not_a_repo", `${cmd.repoPath} is not a git repository`);
  });
  const short = sessionShort(cmd.sessionId);
  const slug = cmd.projectSlug ?? slugFromPath(repo);
  const path = resolve(cmd.path ?? join(ctx.home, "wt", slug, short));
  const reuse = await clearTarget(repo, path, ctx);
  if (reuse) return reuse;
  await mkdir(dirname(path), { recursive: true });
  const base = await resolveBase(repo, cmd);
  if (cmd.branch && (await branchExists(repo, cmd.branch))) {
    await git(repo, ["worktree", "add", path, cmd.branch], { timeoutMs: 10 * 60_000 });
    return { cwd: path, branch: cmd.branch, created: true };
  }
  const branch = cmd.branch ?? (await uniqueBranch(repo, `codeden/${short}`));
  await git(repo, ["worktree", "add", "--no-track", "-b", branch, path, base], {
    timeoutMs: 10 * 60_000,
  });
  return { cwd: path, branch, created: true };
}

/**
 * `workspace.prepare` (§9): resolve the session's working directory (repo root, an existing
 * worktree, or a new worktree under `<home>/wt/<slug>/<short>` on a new branch), restore a
 * forked session's starting checkpoint into a new one, then run `.codeden/project.json` setup
 * (new worktrees only) and the explicit setup commands.
 */
export async function prepareWorkspace(
  cmd: RunnerCommandOf<"workspace.prepare">,
  ctx: WorkspaceContext,
): Promise<RunnerCommandResult<"workspace.prepare">> {
  let target: { cwd: string; branch: string | null; created: boolean };
  switch (cmd.strategy) {
    case "repo_root": {
      if (!existsSync(cmd.repoPath))
        throw new CommandError("not_found", `${cmd.repoPath} not found`);
      const isRepo = await isWorkTree(cmd.repoPath);
      const cwd = isRepo ? await topLevel(cmd.repoPath) : resolve(cmd.repoPath);
      target = { cwd, branch: isRepo ? await currentBranch(cwd) : null, created: false };
      break;
    }
    case "existing": {
      if (!cmd.path || !existsSync(cmd.path)) {
        throw new CommandError("not_found", `Existing worktree ${cmd.path ?? "(none)"} not found`);
      }
      if (!(await isWorkTree(cmd.path))) {
        throw new CommandError("not_a_repo", `${cmd.path} is not a git worktree`);
      }
      target = { cwd: resolve(cmd.path), branch: await currentBranch(cmd.path), created: false };
      break;
    }
    case "worktree":
      target = await createWorktree(cmd, ctx);
      break;
  }
  // A fork starts where its source left off: that checkpoint's files, uncommitted, on top of
  // the branch. Only on creation, so a retried start never overwrites the fork's own work.
  if (target.created && cmd.restoreCheckpoint) {
    const from = cmd.restoreCheckpoint;
    await restoreFiles(target.cwd, from.sessionId, from.index);
  }

  const { config, error } = await readProjectConfig(target.cwd);
  if (error) {
    ctx.emit({
      kind: "workspace.setup",
      sessionId: cmd.sessionId,
      status: "failed",
      command: ".codeden/project.json",
      output: error,
    });
  }
  const commands = [
    ...(target.created && cmd.runProjectSetup !== false ? (config?.setup ?? []) : []),
    ...cmd.setupCommands,
  ];
  let setup: SetupStep[] = [];
  if (commands.length > 0) {
    setup = await runSetup({
      sessionId: cmd.sessionId,
      cwd: target.cwd,
      commands,
      supervisor: ctx.supervisor,
      emit: ctx.emit,
    });
  }
  return { ...target, config, setup };
}

import { existsSync, readdirSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { RunnerCommandOf } from "@codeden/contracts";
import { CommandError } from "../errors";
import { type GitOptions, git, gitOk, gitText } from "../git/exec";
import { currentBranch, defaultBranch } from "../git/ops";

/** Where a session's clone lives on this runner (`docs/remote-runners.md` §9.1). */
export function clonePath(home: string, short: string): string {
  return resolve(join(home, "ws", short));
}

/** Clone and fetch never run the `ext::` transport, whatever the user's git config allows. */
const SAFE = ["-c", "protocol.ext.allow=never"];

/**
 * Written into a clone's `.git` once the session's branch is checked out. A clone without it
 * never finished (its checkout failed, or the runner stopped half way), was never handed to a
 * session, and is cloned again rather than reused on whatever branch it was left.
 */
const READY_FILE = "codeden-clone-ready";

function isReady(path: string): boolean {
  return existsSync(join(path, ".git", READY_FILE));
}

/**
 * Delete a clone that never finished. Its setup never ran (no installs, no links made by one),
 * so a plain recursive delete is enough; it never follows a link out of the folder.
 */
function removeUnfinished(path: string): Promise<void> {
  return rm(path, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}

function hasEntries(path: string): boolean {
  try {
    return readdirSync(path).length > 0;
  } catch {
    return false;
  }
}

function hasRef(cwd: string, ref: string): Promise<boolean> {
  return gitOk(cwd, ["rev-parse", "--verify", "--quiet", ref]);
}

/**
 * The ref a new branch starts from: the remote's copy of a branch name (`origin/<base>`), else
 * `base` as given (a commit, `origin/x`, a tag).
 */
async function startPoint(cwd: string, base: string): Promise<string> {
  if (base.startsWith("origin/")) return base;
  return (await hasRef(cwd, `refs/remotes/origin/${base}`)) ? `origin/${base}` : base;
}

/**
 * `workspace.prepare` with `clone` (§9.1): the runner doesn't share the server's disk, so it
 * clones `remoteUrl` into `<home>/ws/<short>`, a path it chooses, and checks out the session's
 * branch: the remote's branch of that name when it exists (a session resumed in a new sandbox),
 * else a new branch from `baseRef` (default: the remote's default branch). An existing clone of
 * the same remote is reused (fetched first when `fetch` is set; offline keeps it as it is) once
 * it has its branch; a clone that never got it is cloned again, and one whose checkout fails is
 * removed. The brokered credential goes to the clone and fetch only (`git/credentials.ts`).
 */
export async function prepareClone(
  cmd: RunnerCommandOf<"workspace.prepare">,
  home: string,
  short: string,
): Promise<{ cwd: string; branch: string | null; created: boolean }> {
  if (cmd.restoreCheckpoint) {
    throw new CommandError("unsupported", "A cloned workspace can't start from a checkpoint yet");
  }
  const remoteUrl = cmd.remoteUrl as string;
  const path = clonePath(home, short);
  const auth: GitOptions = { timeoutMs: 10 * 60_000, credential: cmd.credential };
  if (existsSync(path) && hasEntries(path)) {
    // The folder itself must be the clone's top level (not a folder inside another repository).
    const cdup = await gitText(path, ["rev-parse", "--show-cdup"]).catch(() => null);
    const origin =
      cdup === "" ? await gitText(path, ["remote", "get-url", "origin"]).catch(() => "") : "";
    if (cdup !== "" || origin !== remoteUrl) {
      throw new CommandError("path_exists", `${path} exists and is not a clone of the project`);
    }
    if (isReady(path)) {
      if (cmd.fetch) {
        await git(path, [...SAFE, "fetch", "--prune", "origin"], auth).catch(() => undefined);
      }
      return { cwd: path, branch: await currentBranch(path), created: false };
    }
    await removeUnfinished(path);
  }
  await mkdir(join(home, "ws"), { recursive: true });
  const fresh = !existsSync(path);
  try {
    const depth = cmd.depth ? ["--depth", String(cmd.depth), "--no-single-branch"] : [];
    await git(join(home, "ws"), [...SAFE, "clone", "-q", ...depth, "--", remoteUrl, path], auth);
    const branch = await checkoutBranch(cmd, path, short);
    await writeFile(join(path, ".git", READY_FILE), `${branch}\n`);
    return { cwd: path, branch, created: true };
  } catch (error) {
    // Nothing half made is left behind; a clone that can't be removed now (or went into a
    // folder that was already there) is cloned again next time, as it isn't marked ready.
    if (fresh) await removeUnfinished(path).catch(() => undefined);
    throw error;
  }
}

/** Check out the session's branch in a fresh clone; returns its name. */
async function checkoutBranch(
  cmd: RunnerCommandOf<"workspace.prepare">,
  path: string,
  short: string,
): Promise<string> {
  const branch = cmd.branch ?? `codeden/${short}`;
  if (await hasRef(path, `refs/remotes/origin/${branch}`)) {
    await git(path, ["checkout", "-q", "-B", branch, "--track", `origin/${branch}`]);
  } else {
    const base = cmd.baseRef ?? (await defaultBranch(path)) ?? "HEAD";
    const from = await startPoint(path, base);
    await git(path, ["checkout", "-q", "--no-track", "-B", branch, from]);
  }
  return branch;
}

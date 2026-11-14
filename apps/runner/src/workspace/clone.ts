import { existsSync, readdirSync } from "node:fs";
import { mkdir } from "node:fs/promises";
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
 * the same remote is reused (fetched first when `fetch` is set; offline keeps it as it is). The
 * brokered credential goes to the clone and fetch only (`git/credentials.ts`).
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
    if (cmd.fetch) {
      await git(path, [...SAFE, "fetch", "--prune", "origin"], auth).catch(() => undefined);
    }
    return { cwd: path, branch: await currentBranch(path), created: false };
  }
  await mkdir(join(home, "ws"), { recursive: true });
  const depth = cmd.depth ? ["--depth", String(cmd.depth), "--no-single-branch"] : [];
  await git(join(home, "ws"), [...SAFE, "clone", "-q", ...depth, "--", remoteUrl, path], auth);

  const branch = cmd.branch ?? `codeden/${short}`;
  if (await hasRef(path, `refs/remotes/origin/${branch}`)) {
    await git(path, ["checkout", "-q", "-B", branch, "--track", `origin/${branch}`]);
  } else {
    const base = cmd.baseRef ?? (await defaultBranch(path)) ?? "HEAD";
    const from = await startPoint(path, base);
    await git(path, ["checkout", "-q", "--no-track", "-B", branch, from]);
  }
  return { cwd: path, branch, created: true };
}

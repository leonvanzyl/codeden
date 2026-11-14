import type { RunnerCommandOf, RunnerCommandResult } from "@codeden/contracts";
import { CommandError } from "../errors";
import { snapshotTree } from "./checkpoints";
import { diffTrees } from "./diff";
import { git, gitOk, gitText, splitNul } from "./exec";

/** Parse `git status --porcelain=v2 --branch -z`. */
export function parseStatus(out: Buffer | string): RunnerCommandResult<"git.status"> {
  const fields = splitNul(out);
  let branch: string | null = null;
  let ahead = 0;
  let behind = 0;
  const files: Array<{ path: string; status: string }> = [];
  const xy = (code: string) => code.replace(/\./g, " ");
  for (let i = 0; i < fields.length; i++) {
    const line = fields[i] ?? "";
    if (line.startsWith("# branch.head ")) {
      const head = line.slice("# branch.head ".length);
      branch = head === "(detached)" ? null : head;
    } else if (line.startsWith("# branch.ab ")) {
      const match = /\+(\d+) -(\d+)/.exec(line);
      ahead = Number(match?.[1] ?? 0);
      behind = Number(match?.[2] ?? 0);
    } else if (line.startsWith("1 ")) {
      const parts = line.split(" ");
      files.push({ status: xy(parts[1] ?? ""), path: parts.slice(8).join(" ") });
    } else if (line.startsWith("2 ")) {
      const parts = line.split(" ");
      files.push({ status: xy(parts[1] ?? ""), path: parts.slice(9).join(" ") });
      i++; // original path follows as its own field
    } else if (line.startsWith("u ")) {
      const parts = line.split(" ");
      files.push({ status: xy(parts[1] ?? ""), path: parts.slice(10).join(" ") });
    } else if (line.startsWith("? ")) {
      files.push({ status: "??", path: line.slice(2) });
    }
  }
  return { branch, ahead, behind, files };
}

export async function status(cwd: string): Promise<RunnerCommandResult<"git.status">> {
  const out = await git(cwd, [
    "status",
    "--porcelain=v2",
    "--branch",
    "-z",
    "--untracked-files=all",
  ]);
  return parseStatus(out.stdout);
}

/** The repository's default branch: `origin/HEAD`, else `main`/`master`, else the current branch. */
export async function defaultBranch(cwd: string): Promise<string | null> {
  try {
    const remoteHead = await gitText(cwd, [
      "symbolic-ref",
      "--quiet",
      "--short",
      "refs/remotes/origin/HEAD",
    ]);
    if (remoteHead) return remoteHead.replace(/^origin\//, "");
  } catch {
    // no origin/HEAD
  }
  for (const name of ["main", "master"]) {
    if (await gitOk(cwd, ["show-ref", "--verify", "--quiet", `refs/heads/${name}`])) return name;
  }
  return currentBranch(cwd);
}

export async function currentBranch(cwd: string): Promise<string | null> {
  try {
    return (await gitText(cwd, ["symbolic-ref", "--quiet", "--short", "HEAD"])) || null;
  } catch {
    return null; // detached
  }
}

export async function branches(
  cmd: RunnerCommandOf<"git.branches">,
): Promise<RunnerCommandResult<"git.branches">> {
  const refs = cmd.includeRemote ? ["refs/heads", "refs/remotes"] : ["refs/heads"];
  const out = await gitText(cmd.cwd, [
    "for-each-ref",
    "--format=%(refname)%00%(objectname)%00%(upstream:short)",
    ...refs,
  ]);
  const list: RunnerCommandResult<"git.branches">["branches"] = [];
  for (const line of out.split("\n")) {
    if (!line) continue;
    const [ref = "", commit = "", upstream = ""] = line.split("\0");
    if (ref.startsWith("refs/remotes/") && ref.endsWith("/HEAD")) continue;
    const remote = ref.startsWith("refs/remotes/");
    const name = ref.replace(remote ? /^refs\/remotes\// : /^refs\/heads\//, "");
    list.push({ name, remote, commit, upstream: upstream || null });
  }
  return {
    current: await currentBranch(cmd.cwd),
    defaultBranch: await defaultBranch(cmd.cwd),
    branches: list,
  };
}

/** Stage all changes (or `paths`) and commit. Returns null when nothing was staged. */
export async function commit(
  cmd: RunnerCommandOf<"git.commit">,
): Promise<RunnerCommandResult<"git.commit">> {
  const spec = cmd.paths && cmd.paths.length > 0 ? cmd.paths : ["."];
  await git(cmd.cwd, ["add", "-A", "--", ...spec]);
  const staged = await git(cmd.cwd, ["diff", "--cached", "--quiet"], { okCodes: [0, 1] });
  if (staged.code === 0) return { commit: null };
  await git(cmd.cwd, ["commit", "-q", "-F", "-"], { input: cmd.message, timeoutMs: 5 * 60_000 });
  return { commit: await gitText(cmd.cwd, ["rev-parse", "HEAD"]) };
}

export async function push(
  cmd: RunnerCommandOf<"git.push">,
): Promise<RunnerCommandResult<"git.push">> {
  const remote = cmd.remote ?? "origin";
  const current = await currentBranch(cmd.cwd);
  const branch = cmd.branch ?? current;
  if (!branch) throw new CommandError("detached_head", "Cannot push a detached HEAD");
  const args = ["push"];
  if (cmd.setUpstream !== false) args.push("-u");
  if (cmd.forceWithLease) args.push("--force-with-lease");
  args.push(remote, branch === current ? branch : `HEAD:refs/heads/${branch}`);
  await git(cmd.cwd, args, { timeoutMs: 5 * 60_000, credential: cmd.credential });
  return { remote, branch };
}

/** `fromRef..toRef`, or `fromRef` against the working tree (incl. untracked files). */
export async function diff(
  cmd: RunnerCommandOf<"git.diff">,
): Promise<RunnerCommandResult<"git.diff">> {
  const to = cmd.toRef ?? (await snapshotTree(cmd.cwd));
  return diffTrees(cmd.cwd, cmd.fromRef, to);
}

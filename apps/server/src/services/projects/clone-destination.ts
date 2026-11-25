import { readdirSync } from "node:fs";
import { conflict } from "../errors";
import type { Exec } from "../exec";
import { parseGitHubRemote, redactUrls, sameRealPath } from "./detect";

/**
 * A comparable form of a git URL: `github.com/owner/repo` in lower case for any GitHub form
 * (https, ssh, scp-style, with or without `.git`); otherwise the URL without credentials, a
 * `file://` prefix, trailing slashes or `.git`.
 */
export function repositoryKey(url: string): string {
  const gh = parseGitHubRemote(url);
  if (gh) return `github.com/${gh.owner}/${gh.repo}`.toLowerCase();
  return url
    .trim()
    .replace(/^(\w+:\/\/)[^@\s/]+@/, "$1")
    .replace(/^file:\/\//i, "")
    .replace(/\/+$/, "")
    .replace(/\.git$/i, "");
}

/** `owner/repo` for a GitHub URL, else the URL without credentials. */
function describeRemote(url: string): string {
  const gh = parseGitHubRemote(url);
  return gh ? `${gh.owner}/${gh.repo}` : redactUrls(url);
}

async function git(exec: Exec, cwd: string, args: string[]): Promise<string | null> {
  const result = await exec("git", ["-C", cwd, ...args], { timeoutMs: 10_000 });
  return result.code === 0 ? result.stdout.trim() : null;
}

/** The remote URLs of the checkout whose root is `dir`; null when `dir` is not a checkout's root. */
async function checkoutRemotes(exec: Exec, dir: string): Promise<string[] | null> {
  const root = await git(exec, dir, ["rev-parse", "--show-toplevel"]);
  if (!root || !sameRealPath(root, dir)) return null;
  const config = await git(exec, dir, ["config", "--get-regexp", "^remote\\..*\\.url$"]);
  return (config ?? "")
    .split("\n")
    .map((line) => line.split(/\s+/, 2)[1])
    .filter((url): url is string => Boolean(url));
}

/**
 * What a clone into `dest` should do: `"clone"` when the folder is missing or empty, `"reuse"`
 * when it is already a checkout of `url` (https and ssh forms of a GitHub repository match).
 * Any other non-empty folder is refused (409 `destination_exists`), naming the repository it
 * holds when it is a checkout.
 */
export async function cloneDestination(
  exec: Exec,
  dest: string,
  url: string,
): Promise<"clone" | "reuse"> {
  let entries: string[];
  try {
    entries = readdirSync(dest);
  } catch {
    return "clone";
  }
  if (entries.length === 0) return "clone";
  const remotes = await checkoutRemotes(exec, dest);
  const wanted = repositoryKey(url);
  if (remotes?.some((remote) => repositoryKey(remote) === wanted)) return "reuse";
  const holds = remotes?.[0] ? `holds a clone of ${describeRemote(remotes[0])}` : "is not empty";
  throw conflict(
    `${dest} already exists and ${holds}. Choose another folder, or add it as a local folder.`,
    "destination_exists",
  );
}

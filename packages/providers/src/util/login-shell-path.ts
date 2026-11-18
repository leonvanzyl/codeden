import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";

/**
 * An app started from the macOS Dock or Finder (or a Linux desktop launcher) gets the system's
 * minimal PATH (`/usr/bin:/bin:/usr/sbin:/sbin`), not the one the user's shell builds, so CLIs
 * installed with Homebrew, nvm, Bun, pnpm or Volta are not found (§14). The fix is to ask the
 * user's login shell once for its PATH and merge it into this process's PATH, so everything
 * started afterwards (checks, the runner, agents, terminals, git) sees the same tools as a
 * terminal. Windows keeps its PATH in the registry instead (`refreshProcessPath`).
 */

/** Reads the login shell's PATH; `null` when it could not be read. */
export type LoginShellPathReader = () => Promise<string | null>;

export interface LoginShellPathOptions {
  /** Defaults to `process.platform`. */
  platform?: NodeJS.Platform;
  /** The environment to read `SHELL` from and to update (defaults to `process.env`). */
  env?: NodeJS.ProcessEnv;
  /** Defaults to running `$SHELL -i -l -c` (tests pass a fake). */
  read?: LoginShellPathReader;
  /** How long the shell gets to answer (default 5 s). */
  timeoutMs?: number;
}

/** How long a read is reused by `refreshLoginShellPath` before the shell is asked again. */
const REREAD_AFTER_MS = 60_000;

/** True on the platforms whose GUI apps start with the minimal PATH. */
export function usesLoginShellPath(platform: NodeJS.Platform = process.platform): boolean {
  return platform === "darwin" || platform === "linux";
}

/**
 * Run the user's shell as an interactive login shell (so `.zprofile`, `.zshrc`,
 * `.bash_profile` and the like run, as in a terminal) and read the PATH it ends up with,
 * printed between two random markers so anything the startup files print is ignored. Gives
 * up after `timeoutMs` (stopping the shell it started) and never throws: `null` means "keep
 * the PATH as it is".
 */
export function readLoginShellPath(
  opts: { env?: NodeJS.ProcessEnv; timeoutMs?: number } = {},
): Promise<string | null> {
  const env = opts.env ?? process.env;
  const shell = env.SHELL?.startsWith("/") ? env.SHELL : "/bin/sh";
  const mark = `_CODEDEN_PATH_${randomBytes(8).toString("hex")}_`;
  // `echo`, `;` and an absolute `printenv` work the same in sh, bash, zsh and fish.
  const script = `echo ${mark}; /usr/bin/printenv PATH; echo ${mark}`;
  return new Promise((resolve) => {
    let out = "";
    let settled = false;
    const finish = (value: string | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(shell, ["-i", "-l", "-c", script], {
        // Its own process group, so a timeout stops whatever the startup files started too.
        detached: true,
        stdio: ["ignore", "pipe", "ignore"],
        env: {
          ...env,
          // Keep common shell frameworks from prompting or attaching a terminal multiplexer.
          DISABLE_AUTO_UPDATE: "true",
          ZSH_TMUX_AUTOSTARTED: "true",
          ZSH_TMUX_AUTOSTART: "false",
        },
      });
    } catch {
      resolve(null);
      return;
    }
    const timer = setTimeout(() => {
      stopGroup(child.pid);
      finish(null);
    }, opts.timeoutMs ?? 5_000);
    timer.unref?.();
    child.stdout?.setEncoding("utf8").on("data", (chunk: string) => {
      if (out.length < 256 * 1024) out += chunk;
      // Done once the second marker is in: a background job the startup files left holding
      // the pipe open must not keep this waiting.
      const value = parseMarkedPath(out, mark);
      if (value) {
        child.stdout?.destroy();
        child.unref();
        finish(value);
      }
    });
    child.on("error", () => finish(null));
    child.on("close", () => finish(parseMarkedPath(out, mark)));
  });
}

function stopGroup(pid: number | undefined): void {
  if (!pid) return;
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    // Already gone.
  }
}

/** The PATH printed between two `mark` lines; `null` when the markers are missing or empty. */
export function parseMarkedPath(output: string, mark: string): string | null {
  const start = output.indexOf(mark);
  if (start < 0) return null;
  const end = output.indexOf(mark, start + mark.length);
  if (end < 0) return null;
  const value = output.slice(start + mark.length, end).trim();
  return value.includes("/") ? value : null;
}

/**
 * Merge the login shell's PATH into `current`. Folders only `current` has (added on purpose
 * by whatever started this process, such as a package manager's `node_modules/.bin`) stay in
 * front; then the shell's folders follow in the shell's order, so the user's tools win over
 * the system's exactly as in a terminal. Duplicates are dropped.
 */
export function mergeShellPath(current: string, fromShell: string): string {
  const shellDirs = splitPosixPath(fromShell);
  const inShell = new Set(shellDirs.map(normalizeDir));
  const ownDirs = splitPosixPath(current).filter((dir) => !inShell.has(normalizeDir(dir)));
  const seen = new Set<string>();
  const merged: string[] = [];
  for (const dir of [...ownDirs, ...shellDirs]) {
    const key = normalizeDir(dir);
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(dir);
  }
  return merged.join(":");
}

function splitPosixPath(value: string): string[] {
  return value
    .split(":")
    .map((d) => d.trim())
    .filter(Boolean);
}

function normalizeDir(dir: string): string {
  return dir.length > 1 ? dir.replace(/\/+$/, "") : dir;
}

let enabled = false;
let lastRead: { at: number; value: Promise<string | null> } | undefined;

/**
 * Process start-up (the CLI, the desktop app's server, the runner): merge the login shell's
 * PATH into this process's PATH, on macOS and Linux only, and let later re-checks
 * (`refreshProcessPath`) read it again. Waits at most `timeoutMs`; on any failure PATH stays as
 * it was. Never throws. Returns the folders that were added.
 */
export async function applyLoginShellPath(opts: LoginShellPathOptions = {}): Promise<string[]> {
  if (!usesLoginShellPath(opts.platform)) return [];
  // An escape hatch for a shell whose startup files misbehave without a terminal.
  if ((opts.env ?? process.env).CODEDEN_LOGIN_SHELL === "0") return [];
  enabled = true;
  return mergeInto(opts, true);
}

/**
 * Read the login shell's PATH again and merge in what is new, e.g. a CLI installed while
 * CodeDen runs. Only after `applyLoginShellPath` turned it on for this process (tests and
 * library users are left alone), and at most once a minute. Never throws.
 */
export async function refreshLoginShellPath(opts: LoginShellPathOptions = {}): Promise<string[]> {
  if (!enabled || !usesLoginShellPath(opts.platform)) return [];
  return mergeInto(opts, false);
}

async function mergeInto(opts: LoginShellPathOptions, fresh: boolean): Promise<string[]> {
  const env = opts.env ?? process.env;
  const now = Date.now();
  const read = opts.read ?? (() => readLoginShellPath({ env, timeoutMs: opts.timeoutMs ?? 5_000 }));
  if (fresh || opts.read || !lastRead || now - lastRead.at > REREAD_AFTER_MS) {
    lastRead = { at: now, value: read().catch(() => null) };
  }
  const fromShell = await lastRead.value;
  if (!fromShell) return [];
  const current = env.PATH ?? "";
  const before = new Set(splitPosixPath(current).map(normalizeDir));
  const merged = mergeShellPath(current, fromShell);
  if (merged === current) return [];
  env.PATH = merged;
  return splitPosixPath(merged).filter((dir) => !before.has(normalizeDir(dir)));
}

/** Forget that start-up turned re-reading on, and the last read (tests). */
export function resetLoginShellPath(): void {
  enabled = false;
  lastRead = undefined;
}

import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { homedir } from "node:os";

/**
 * An app started from the macOS Dock or Finder gets launchd's minimal PATH
 * (`/usr/bin:/bin:/usr/sbin:/sbin`), not the one the user's shell profiles build, so tools set
 * up there (Homebrew, nvm, Bun) are missing (§17). Before it starts a server, the app asks the
 * user's interactive login shell for its PATH and hands the server that PATH merged with its own.
 * Only PATH is taken.
 */

/** How long the shell gets to answer. */
const TIMEOUT_MS = 5_000;

let cached: Promise<string | null> | undefined;

/**
 * The PATH for a server this app starts: the login shell's folders merged into `current`, or
 * `undefined` (keep `current`) off macOS or when the shell could not be read. A successful
 * read is reused for later starts (another port, a restart after a crash); a failed one is
 * tried again next time. Never throws.
 */
export async function loginShellPath(
  current = process.env.PATH ?? "",
  platform: NodeJS.Platform = process.platform,
): Promise<string | undefined> {
  if (platform !== "darwin") return undefined;
  cached ??= readLoginShellPath();
  const fromShell = await cached;
  if (!fromShell) {
    cached = undefined;
    return undefined;
  }
  return mergeShellPath(current, fromShell);
}

/** Forget a cached read (tests). */
export function resetLoginShellPath(): void {
  cached = undefined;
}

/**
 * Run `$SHELL -i -l -c` in the home folder, so `.zprofile`, `.zshrc`, `.bash_profile` and the
 * like run as in a terminal, and read the PATH it ends up with. The PATH is printed between two
 * random markers, so whatever the profiles print is ignored, and taken as soon as the second
 * marker arrives, so a background job a profile leaves holding the output open doesn't hold up
 * the start. After `timeoutMs` the shell and everything it started are stopped (it runs in its
 * own process group). `null` means "keep the PATH as it is". Never throws.
 */
export function readLoginShellPath(
  opts: { env?: NodeJS.ProcessEnv; timeoutMs?: number } = {},
): Promise<string | null> {
  const env = opts.env ?? process.env;
  const shell = env.SHELL?.startsWith("/") ? env.SHELL : "/bin/zsh";
  const mark = `_CODEDEN_PATH_${randomBytes(8).toString("hex")}_`;
  // `echo`, `;` and an absolute `printenv` work the same in sh, bash, zsh and fish.
  const script = `echo ${mark}; /usr/bin/printenv PATH; echo ${mark}`;
  return new Promise((resolve) => {
    let out = "";
    let settled = false;
    let timer: NodeJS.Timeout | undefined;
    const finish = (value: string | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(shell, ["-i", "-l", "-c", script], {
        cwd: homedir(),
        detached: true,
        stdio: ["ignore", "pipe", "ignore"],
        env: {
          ...env,
          // Keep common shell frameworks from prompting to update or attaching tmux.
          DISABLE_AUTO_UPDATE: "true",
          ZSH_TMUX_AUTOSTARTED: "true",
          ZSH_TMUX_AUTOSTART: "false",
        },
      });
    } catch {
      resolve(null);
      return;
    }
    timer = setTimeout(() => {
      stopGroup(child.pid);
      finish(null);
    }, opts.timeoutMs ?? TIMEOUT_MS);
    timer.unref();
    child.stdout?.setEncoding("utf8").on("data", (chunk: string) => {
      if (out.length < 256 * 1024) out += chunk;
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

/** The PATH printed between two `mark` lines; `null` when a marker is missing or it is empty. */
export function parseMarkedPath(output: string, mark: string): string | null {
  const start = output.indexOf(mark);
  if (start < 0) return null;
  const end = output.indexOf(mark, start + mark.length);
  if (end < 0) return null;
  const value = output.slice(start + mark.length, end).trim();
  return value.includes("/") ? value : null;
}

/**
 * Merge the login shell's PATH into `current`. Folders only `current` has (put there on
 * purpose by whatever started the app) stay in front; then the shell's folders follow in the
 * shell's order, so the user's tools win over the system's as in a terminal. Empty entries and
 * duplicates are dropped.
 */
export function mergeShellPath(current: string, fromShell: string): string {
  const shellDirs = splitPath(fromShell);
  const inShell = new Set(shellDirs.map(normalizeDir));
  const ownDirs = splitPath(current).filter((dir) => !inShell.has(normalizeDir(dir)));
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

function splitPath(value: string): string[] {
  return value
    .split(":")
    .map((d) => d.trim())
    .filter(Boolean);
}

function normalizeDir(dir: string): string {
  return dir.length > 1 ? dir.replace(/\/+$/, "") : dir;
}

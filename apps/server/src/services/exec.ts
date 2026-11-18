import { spawn } from "node:child_process";
import { accessSync, constants, statSync } from "node:fs";
import { delimiter, extname, isAbsolute, join } from "node:path";
import { knownLocations } from "@codeden/providers";

/** Result of running a tool. Output is capped; never log it when it may hold secrets. */
export interface ExecResult {
  /** Exit code; null when the process could not start or was killed. */
  code: number | null;
  stdout: string;
  stderr: string;
  /** The executable was not found on PATH or in its known install locations. */
  notFound: boolean;
  timedOut: boolean;
  /** Resolved executable path. */
  path: string | null;
}

export interface ExecOptions {
  timeoutMs?: number;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  /** Max bytes kept per stream (default 1 MiB). */
  maxOutput?: number;
}

/** Runs a named tool; injectable so detection logic can be tested without real CLIs. */
export type Exec = (command: string, args: string[], opts?: ExecOptions) => Promise<ExecResult>;

const isWindows = process.platform === "win32";

function isFile(p: string): boolean {
  try {
    if (!statSync(p).isFile()) return false;
    if (!isWindows) accessSync(p, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Find an executable on PATH, honouring PATHEXT on Windows (so `codex` finds `codex.cmd`).
 * Returns null when not found.
 */
export function resolveExecutable(
  name: string,
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  if (isAbsolute(name)) return isFile(name) ? name : null;
  const pathKey = Object.keys(env).find((k) => k.toLowerCase() === "path");
  const pathVar = (pathKey ? env[pathKey] : undefined) ?? "";
  const exts = isWindows
    ? extname(name)
      ? [""]
      : (env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean)
    : [""];
  for (const dir of pathVar.split(delimiter)) {
    if (!dir) continue;
    for (const ext of exts) {
      const candidate = join(dir.replace(/^"|"$/g, ""), name + ext.toLowerCase());
      if (isFile(candidate)) return candidate;
    }
  }
  return null;
}

/**
 * Find a named tool the way the setup checks do (§14): PATH first, then the tool's known
 * install locations (its installer's folders and, for `gh` and the agent CLIs, the package
 * managers' global bin folders). So the GitHub token look-up runs the same `gh` the checklist
 * reports, even when this process has the minimal PATH of an app started from the Dock or
 * Finder. Paths are taken as they are. Returns null when not found.
 */
export function resolveTool(
  name: string,
  env: NodeJS.ProcessEnv = process.env,
  known: (name: string) => readonly string[] = knownLocations,
): string | null {
  const onPath = resolveExecutable(name, env);
  if (onPath || isAbsolute(name) || name.includes("/") || name.includes("\\")) return onPath;
  return known(name).find(isFile) ?? null;
}

/**
 * Quote one argument for `cmd.exe /s /c`. Characters cmd would interpret are refused rather
 * than escaped, so a shim can never be made to run something else.
 */
function quoteForCmd(arg: string): string {
  if (/^[\w.:\\/@=+,-]+$/.test(arg)) return arg;
  if (/["%!^&|<>\r\n]/.test(arg)) throw new Error(`Unsafe argument for a .cmd shim: ${arg}`);
  return `"${arg}"`;
}

/**
 * Run a tool without a shell. On Windows, `.cmd`/`.bat` shims (npm-installed CLIs) cannot be
 * spawned directly, so they run through `cmd.exe /d /s /c` with verbatim, quoted arguments.
 * Times out (killing the process tree) instead of hanging on an interactive prompt.
 */
/**
 * Merge environment overrides. Windows variable names are case-insensitive, so an override
 * replaces every differently-cased copy (`Path` vs `PATH`) instead of duplicating it.
 */
export function mergeEnv(
  base: NodeJS.ProcessEnv,
  overrides: NodeJS.ProcessEnv = {},
): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = { ...base };
  for (const [key, value] of Object.entries(overrides)) {
    if (isWindows) {
      for (const existing of Object.keys(out)) {
        if (existing.toLowerCase() === key.toLowerCase()) delete out[existing];
      }
    }
    out[key] = value;
  }
  return out;
}

/** `cmd.exe`, found without relying on PATH (which callers may override). */
function comspec(): string {
  const systemRoot = process.env.SystemRoot ?? "C:\\Windows";
  return process.env.ComSpec ?? join(systemRoot, "System32", "cmd.exe");
}

export const runTool: Exec = (command, args, opts = {}) => {
  const env = mergeEnv(process.env, opts.env);
  const resolved = resolveTool(command, env);
  const empty = { stdout: "", stderr: "", timedOut: false };
  if (!resolved) return Promise.resolve({ ...empty, code: null, notFound: true, path: null });

  const isShim = isWindows && /\.(cmd|bat)$/i.test(resolved);
  const file = isShim ? comspec() : resolved;
  let argv = args;
  if (isShim) {
    try {
      argv = ["/d", "/s", "/c", `"${[`"${resolved}"`, ...args.map(quoteForCmd)].join(" ")}"`];
    } catch (error) {
      const stderr = error instanceof Error ? error.message : String(error);
      return Promise.resolve({ ...empty, stderr, code: null, notFound: false, path: resolved });
    }
  }
  const max = opts.maxOutput ?? 1024 * 1024;

  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let settled = false;
    const child = spawn(file, argv, {
      cwd: opts.cwd,
      // No prompts and no Git Credential Manager sign-in windows from background git.
      env: mergeEnv(env, {
        NO_COLOR: "1",
        FORCE_COLOR: "0",
        GIT_TERMINAL_PROMPT: "0",
        GCM_INTERACTIVE: "never",
      }),
      windowsHide: true,
      windowsVerbatimArguments: isShim,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const finish = (code: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code, stdout, stderr, notFound: false, timedOut, path: resolved });
    };
    const timer = setTimeout(() => {
      timedOut = true;
      killTree(child.pid);
      finish(null);
    }, opts.timeoutMs ?? 15_000);
    child.stdout.setEncoding("utf8").on("data", (d: string) => {
      if (stdout.length < max) stdout += d;
    });
    child.stderr.setEncoding("utf8").on("data", (d: string) => {
      if (stderr.length < max) stderr += d;
    });
    child.on("error", (error) => {
      stderr += error.message;
      finish(null);
    });
    child.on("close", (code) => finish(code));
  });
};

function killTree(pid: number | undefined): void {
  if (!pid) return;
  if (isWindows) {
    spawn("taskkill", ["/pid", String(pid), "/t", "/f"], { windowsHide: true, stdio: "ignore" });
    return;
  }
  try {
    process.kill(pid, "SIGKILL");
  } catch {
    // already gone
  }
}

import { execFile } from "node:child_process";
import path from "node:path";
import { refreshLoginShellPath } from "./login-shell-path";

/** Registry keys that hold the user's and the machine's `Path` on Windows. */
export const PATH_REGISTRY_KEYS = {
  machine: "HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment",
  user: "HKCU\\Environment",
} as const;

/** Reads one `Path` value from the registry; `null` when it is not set or unreadable. */
export type RegistryPathReader = (scope: keyof typeof PATH_REGISTRY_KEYS) => Promise<string | null>;

export interface RefreshPathOptions {
  /** Defaults to `process.platform`. */
  platform?: NodeJS.Platform;
  /** The environment to update (defaults to `process.env`). */
  env?: NodeJS.ProcessEnv;
  /** Defaults to `reg.exe query`. */
  readRegistry?: RegistryPathReader;
}

/**
 * Pick up PATH changes made since this process started (§14), e.g. a tool installed while
 * CodeDen runs. On Windows the user's and the machine's `Path` are read from the registry,
 * variables expanded, and folders that are not on this process's PATH yet are appended, so
 * everything started afterwards (checks, agents, terminals) sees them. Existing entries keep
 * their order. On macOS and Linux the user's login shell is asked for its PATH again, when
 * start-up turned that on (`applyLoginShellPath`); otherwise PATH is left as it is. Never
 * throws. Returns the folders that were added.
 */
export async function refreshProcessPath(opts: RefreshPathOptions = {}): Promise<string[]> {
  const platform = opts.platform ?? process.platform;
  if (platform !== "win32") {
    return refreshLoginShellPath({ platform, ...(opts.env ? { env: opts.env } : {}) });
  }
  const env = opts.env ?? process.env;
  const read = opts.readRegistry ?? readRegistryPath;
  let machine: string | null = null;
  let user: string | null = null;
  try {
    [machine, user] = await Promise.all([read("machine"), read("user")]);
  } catch {
    return [];
  }
  const fromRegistry = [machine, user]
    .filter((v): v is string => !!v)
    .flatMap((v) => splitWindowsPath(expandWindowsVars(v, env)));
  const key = pathKey(env);
  const current = splitWindowsPath(env[key] ?? "");
  const known = new Set(current.map(normalizeDir));
  const added: string[] = [];
  for (const dir of fromRegistry) {
    const id = normalizeDir(dir);
    if (known.has(id)) continue;
    known.add(id);
    added.push(dir);
  }
  if (added.length > 0) env[key] = [...current, ...added].join(";");
  return added;
}

/** The environment's PATH variable name (`Path` on Windows, case-insensitively). */
function pathKey(env: NodeJS.ProcessEnv): string {
  return Object.keys(env).find((k) => k.toLowerCase() === "path") ?? "PATH";
}

function splitWindowsPath(value: string): string[] {
  return value
    .split(";")
    .map((d) => d.trim().replace(/^"(.*)"$/, "$1"))
    .filter(Boolean);
}

function normalizeDir(dir: string): string {
  return path.win32.normalize(dir).replace(/\\+$/, "").toLowerCase();
}

/** Expand `%NAME%` references (case-insensitive); unknown ones are kept as they are. */
export function expandWindowsVars(value: string, env: NodeJS.ProcessEnv): string {
  const lower = new Map(Object.entries(env).map(([k, v]) => [k.toLowerCase(), v]));
  return value.replace(
    /%([^%;]+)%/g,
    (whole, name: string) => lower.get(name.toLowerCase()) ?? whole,
  );
}

/** Parse `reg query <key> /v Path` output. */
export function parseRegQuery(stdout: string): string | null {
  const m = /^\s*Path\s+REG_(?:EXPAND_)?SZ\s+(.*?)\s*$/im.exec(stdout);
  return m ? (m[1] ?? "") : null;
}

const readRegistryPath: RegistryPathReader = (scope) =>
  new Promise((resolve) => {
    const systemRoot = process.env.SystemRoot ?? "C:\\Windows";
    execFile(
      path.win32.join(systemRoot, "System32", "reg.exe"),
      ["query", PATH_REGISTRY_KEYS[scope], "/v", "Path"],
      { windowsHide: true, timeout: 5_000 },
      (error, stdout) => resolve(error ? null : parseRegQuery(String(stdout))),
    );
  });

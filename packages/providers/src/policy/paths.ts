import { realpathSync } from "node:fs";
import os from "node:os";
import path from "node:path";

/** Context for path checks: the worktree plus any extra directories the agent may use. */
export interface PathContext {
  /** The session's working directory (worktree). */
  cwd: string;
  /**
   * The directory relative paths resolve against: the shell's current directory, or where a
   * `cd` earlier in the command moved. Defaults to `cwd`. Never widens the worktree.
   */
  dir?: string;
  /** Extra writable roots (SessionOptions.additionalDirectories). */
  extraRoots?: readonly string[];
  /** The OS temp directories. Defaults to `osTempRoots()` for the running platform. */
  tempRoots?: readonly string[];
  /**
   * Folders outside the worktree where the agent keeps its own notes (Claude's plans and
   * auto-memory). Writable like temp, and like temp a secrets file there still asks.
   */
  notesRoots?: readonly string[];
  /** Defaults to `process.platform`; set in tests to exercise both path flavours. */
  platform?: NodeJS.Platform;
  /** Home directory used to expand `~`. Defaults to `process.env.HOME ?? USERPROFILE`. */
  home?: string;
  /**
   * CodeDen's data directory (`SessionOptions.codedenHome`): its credential files are guarded
   * (`./codeden-home`), and `$CODEDEN_HOME` resolves to it.
   */
  codedenHome?: string;
}

/** True when the context's paths are Windows paths. */
export const isWin = (ctx: PathContext) => (ctx.platform ?? process.platform) === "win32";

/** The path functions for the context's platform. */
export function pathApi(ctx: PathContext): path.PlatformPath {
  return isWin(ctx) ? path.win32 : path.posix;
}

function homeOf(ctx: PathContext): string {
  return ctx.home ?? process.env.HOME ?? process.env.USERPROFILE ?? "";
}

function tempRootsOf(ctx: PathContext): readonly string[] {
  return ctx.tempRoots ?? osTempRoots(ctx.platform);
}

/** Home variables. Matched in any case: PowerShell's `$home` is the home directory too. */
const HOME_VARS = /^(\$HOME|\$\{HOME\}|\$env:USERPROFILE|%USERPROFILE%)(?=$|[\\/])/i;
/**
 * Temp variables. Shell names are case-sensitive, so `$tmp` (a common name for what `mktemp`
 * printed) is not the temp directory; PowerShell's and cmd's names are not.
 */
const TEMP_VARS = [
  /^(\$TMPDIR|\$\{TMPDIR\}|\$TEMP|\$\{TEMP\}|\$TMP|\$\{TMP\})(?=$|[\\/])/,
  /^(\$env:TEMP|\$env:TMP|%TEMP%|%TMP%)(?=$|[\\/])/i,
];
/** CodeDen's home variable, which agents inherit: case-sensitive in POSIX shells only. */
const CODEDEN_HOME_VARS = [
  /^(\$CODEDEN_HOME|\$\{CODEDEN_HOME\})(?=$|[\\/])/,
  /^(\$env:CODEDEN_HOME|%CODEDEN_HOME%)(?=$|[\\/])/i,
];

/**
 * Git Bash paths on Windows: `/c/Users/x` is `C:\Users\x`, and `/tmp` is the user's temp
 * directory.
 */
function fromGitBash(value: string, temp: string | undefined): string {
  if (temp && /^\/tmp(?=$|\/)/.test(value)) return temp + value.slice(4);
  const drive = /^\/([a-z])(?=$|\/)/i.exec(value);
  if (drive?.[1]) return `${drive[1].toUpperCase()}:\\${value.slice(3)}`;
  return value;
}

/**
 * Resolve `target` (absolute, relative to `dir`, `~`-prefixed, or starting with a home, temp or
 * CodeDen home variable) to an absolute path. On Windows the directory it resolves from may be
 * in Git Bash form too: the shell reports `/c/Users/x/repo` once a command has run in it.
 */
export function resolveAgainst(target: string, ctx: PathContext): string {
  const p = pathApi(ctx);
  let value = target.trim().replace(/^["']|["']$/g, "");
  const home = homeOf(ctx);
  if (value === "~" || value.startsWith("~/") || value.startsWith("~\\")) {
    value = home + value.slice(1);
  }
  value = value.replace(HOME_VARS, home);
  const codeden = ctx.codedenHome;
  if (codeden) for (const vars of CODEDEN_HOME_VARS) value = value.replace(vars, codeden);
  const temp = tempRootsOf(ctx)[0];
  if (temp) for (const vars of TEMP_VARS) value = value.replace(vars, temp);
  let base = ctx.dir ?? ctx.cwd;
  if (isWin(ctx)) {
    value = fromGitBash(value, temp);
    base = fromGitBash(base, temp);
  }
  return p.resolve(base, value);
}

/** True when `target` resolves inside `root` (or equals it). Case-insensitive on Windows. */
export function isInside(target: string, root: string, ctx: PathContext): boolean {
  const rel = relative(root, target, ctx);
  return rel === "" || (!rel.startsWith("..") && !pathApi(ctx).isAbsolute(rel));
}

function relative(root: string, target: string, ctx: PathContext): string {
  const p = pathApi(ctx);
  const norm = (s: string) => (isWin(ctx) ? p.resolve(s).toLowerCase() : p.resolve(s));
  return p.relative(norm(root), norm(target));
}

/** True when two absolute paths name the same file. Case-insensitive on Windows. */
export function samePath(a: string, b: string, ctx: PathContext): boolean {
  return relative(a, b, ctx) === "";
}

/** True when `target` is inside the worktree or one of the extra roots. */
export function isInWorkspace(target: string, ctx: PathContext): boolean {
  const abs = resolveAgainst(target, ctx);
  return [ctx.cwd, ...(ctx.extraRoots ?? [])].some((root) => isInside(abs, root, ctx));
}

/** True when `target` is strictly inside one of the OS temp directories (never the root). */
export function isInTemp(target: string, ctx: PathContext): boolean {
  const abs = resolveAgainst(target, ctx);
  return tempRootsOf(ctx).some((root) => {
    const rel = relative(root, abs, ctx);
    return rel !== "" && isInside(abs, root, ctx);
  });
}

/** True when `target` is one of the OS temp directories itself. */
export function isTempRoot(target: string, ctx: PathContext): boolean {
  const abs = resolveAgainst(target, ctx);
  return tempRootsOf(ctx).some((root) => relative(root, abs, ctx) === "");
}

/** True when `target` is inside one of the agent's notes folders. */
export function isInNotes(target: string, ctx: PathContext): boolean {
  if (!ctx.notesRoots?.length) return false;
  const abs = resolveAgainst(target, ctx);
  return ctx.notesRoots.some((root) => isInside(abs, root, ctx));
}

/**
 * True when agents may write `target` without asking: the worktree, extra roots, temp or their
 * notes folders.
 */
export function isWritable(target: string, ctx: PathContext): boolean {
  return isInWorkspace(target, ctx) || isInTemp(target, ctx) || isInNotes(target, ctx);
}

/**
 * Usable temp roots from `candidates`: absolute, deduplicated, and never a filesystem root,
 * the home directory or one of its parents (a stray `TMPDIR=/` must not open everything).
 */
export function tempRootsFrom(
  candidates: ReadonlyArray<string | undefined>,
  platform: NodeJS.Platform,
  home: string,
): string[] {
  const ctx: PathContext = { cwd: "/", platform };
  const p = pathApi(ctx);
  const out: string[] = [];
  for (const candidate of candidates) {
    if (!candidate || !p.isAbsolute(candidate)) continue;
    const root = p.resolve(candidate);
    if (p.parse(root).root === root || p.dirname(root) === root) continue;
    if (home && isInside(home, root, ctx)) continue;
    if (!out.some((r) => relative(r, root, ctx) === "")) out.push(root);
  }
  return out;
}

const realpath = (p: string): string | undefined => {
  try {
    return realpathSync.native(p);
  } catch {
    return undefined;
  }
};

let cachedTempRoots: string[] | undefined;

/**
 * The OS temp directories for the running platform: `os.tmpdir()`, `%TEMP%` and `%TMP%` on
 * Windows, `$TMPDIR` and `/tmp` elsewhere, each also by its real path (macOS symlinks
 * `/tmp`, Windows may report a short 8.3 name). Empty when asked about another platform.
 */
export function osTempRoots(platform: NodeJS.Platform = process.platform): readonly string[] {
  if (platform !== process.platform) return [];
  if (cachedTempRoots) return cachedTempRoots;
  const env = process.env;
  const base = [
    os.tmpdir(),
    ...(platform === "win32" ? [env.TEMP, env.TMP] : [env.TMPDIR, "/tmp"]),
  ];
  const candidates = base.flatMap((c) => (c ? [c, realpath(c)] : []));
  cachedTempRoots = tempRootsFrom(candidates, platform, os.homedir());
  return cachedTempRoots;
}

const SECRET_BASENAMES = new Set([
  ".env",
  ".npmrc",
  ".netrc",
  ".pypirc",
  ".git-credentials",
  "id_rsa",
  "id_dsa",
  "id_ecdsa",
  "id_ed25519",
  "credentials",
  "credentials.json",
  "secrets.json",
  "secrets.yaml",
  "secrets.yml",
  "service-account.json",
]);
const SAFE_ENV_SUFFIXES = [".example", ".sample", ".template", ".dist", ".defaults"];
const SECRET_EXTENSIONS = [".pem", ".key", ".p12", ".pfx", ".keystore", ".jks"];

/** True for files that commonly hold credentials (`.env`, SSH keys, `.npmrc`, `*.pem`, ...). */
export function isSecretPath(target: string): boolean {
  const normalized = target
    .trim()
    .replace(/^["']|["']$/g, "")
    .replace(/\\/g, "/");
  const base = normalized.split("/").pop()?.toLowerCase() ?? "";
  if (!base) return false;
  if (base === ".env" || base.startsWith(".env.")) {
    return !SAFE_ENV_SUFFIXES.some((s) => base.endsWith(s));
  }
  if (base.endsWith(".env") && base !== ".env") {
    // `process.env`, `import.meta.env`, `Deno.env` and `Bun.env` are code, not files.
    if (/^(process|deno|bun|(.+\.)?meta)\.env$/.test(base)) return false;
    return !base.includes("example");
  }
  if (SECRET_BASENAMES.has(base)) return true;
  if (SECRET_EXTENSIONS.some((ext) => base.endsWith(ext))) return true;
  return /(^|\/)\.(ssh|aws|gnupg|docker)\//i.test(normalized) && !base.endsWith(".pub");
}

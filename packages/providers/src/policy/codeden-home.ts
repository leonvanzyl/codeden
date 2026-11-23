import {
  CODEDEN_CREDENTIAL_FILES,
  CODEDEN_MCP_CONFIG_DIR,
  INVALID_COPY_SUFFIX,
} from "@codeden/contracts";
import { PRIVATE_MCP_CONFIG_NAME, PRIVATE_MCP_FOLDER_PREFIX } from "../util/private-mcp-config";
import type { RiskAssessment } from "./assessment";
import { isInside, isWin, type PathContext, pathApi, resolveAgainst, samePath } from "./paths";
import {
  WILDCARD,
  wildcardMatchesNumbered,
  wildcardMatchesSessionFile,
  wildcardPattern,
  wildcardReaches,
} from "./wildcard";

export { wildcardPattern } from "./wildcard";

/**
 * CodeDen's own home (§15, #320). Its credential files are the install token, the runner lock
 * and the remote access store, the copies CodeDen keeps of one it found damaged
 * (`<file>.invalid-<timestamp>`, with the same secrets in it), and every file in the sessions'
 * private MCP config folder (`CODEDEN_MCP_CONFIG_DIR`, each session's MCP bearer token): an
 * agent holding the install token or the runner's token could drive CodeDen itself and approve
 * its own requests, and one holding another session's MCP token could call CodeDen as that
 * session's role. The rest
 * of the home holds the database (other sessions' transcripts, inbox items, MCP token hashes),
 * settings, logs, backups and other sessions' worktrees. Touching anything there asks at every
 * level, Full included, and is refused for read-only sessions (§11.2); agents get CodeDen state
 * through its MCP tools. The exceptions are the session's own folders under the home: its
 * worktree in `<home>/wt/` (the orchestrator's folder), and, for reading only, its artifacts
 * folder `<home>/artifacts/<session id>` (`SessionOptions.artifactsDir`, `forReading`), so it can
 * look at its own screenshots (#338). The data directory comes from the session
 * (`SessionOptions.codedenHome`); without it, this rule is off.
 */

/** A risky verdict on CodeDen's own home or credentials, which every level asks about. */
export function credentialsRisk(reason: string): RiskAssessment {
  return { risky: true, action: "secrets", reason, codeden: true };
}

/** The credential files in the session's CodeDen home, as absolute paths (none without one). */
export function codedenCredentialFiles(ctx: PathContext): string[] {
  const home = ctx.codedenHome;
  if (!home) return [];
  const p = pathApi(ctx);
  return CODEDEN_CREDENTIAL_FILES.map((file) => p.join(home, file));
}

/**
 * Where copies of the credential files go, as absolute paths: `<file>.invalid-`, followed on
 * disk by a timestamp. A path next to the file whose name starts so is guarded like the file,
 * and so is a wildcard or a search's name filter that matches the start and some number.
 */
export function codedenCredentialCopies(ctx: PathContext): string[] {
  return codedenCredentialFiles(ctx).map((file) => `${file}${INVALID_COPY_SUFFIX}`);
}

/**
 * Folders whose every file is a credential, as absolute paths (none without a home): the
 * sessions' private MCP configs, one folder per session inside.
 */
export function codedenSecretFolders(ctx: PathContext): string[] {
  const home = ctx.codedenHome;
  if (!home) return [];
  return [pathApi(ctx).join(home, CODEDEN_MCP_CONFIG_DIR)];
}

/** The credential files, then the folders that hold them. */
function guardedPaths(ctx: PathContext): string[] {
  const files = codedenCredentialFiles(ctx);
  const p = pathApi(ctx);
  return [
    ...files,
    ...new Set([...files.map((file) => p.dirname(file)), ...codedenSecretFolders(ctx)]),
  ];
}

/** True when `abs` (an absolute path, no wildcards) is a copy of a credential file. */
function isCredentialCopy(abs: string, ctx: PathContext): boolean {
  const p = pathApi(ctx);
  const fold = (name: string) => (isWin(ctx) ? name.toLowerCase() : name);
  return codedenCredentialCopies(ctx).some(
    (copy) =>
      fold(p.basename(abs)).startsWith(fold(p.basename(copy))) &&
      samePath(p.dirname(abs), p.dirname(copy), ctx),
  );
}

/** `/`-separated, for wildcard matching; Windows paths match in any case. */
export function slashes(value: string, ctx: PathContext): string {
  return isWin(ctx) ? value.replace(/\\/g, "/") : value;
}

/**
 * Variables left in a resolved path (`$f`, `${f}`, `$env:F`, `${env:F}`, `%F%`) could be any name,
 * so they match like `*`. `$CODEDEN_HOME`, `$HOME` and the temp variables at the start resolve
 * first.
 */
const PATH_VARIABLE = /\$\{(?:env:)?\w+\}|\$env:\w+|\$\w+|%\w+%/gi;

/**
 * How many leading characters of `abs` are CodeDen's home or a folder above it, at a folder
 * boundary. That part comes from the session (`$CODEDEN_HOME`, `~`, the working directory), so it
 * is always literal: `[`, `*`, `?` or `$` in the home's own path (`CodeDen [dev]`) are never a
 * pattern. Compared like `samePath`, in any case on Windows.
 */
function literalPrefix(abs: string, ctx: PathContext): number {
  const home = ctx.codedenHome;
  if (!home) return 0;
  const p = pathApi(ctx);
  const value = slashes(abs, ctx);
  const fold = (s: string) => (isWin(ctx) ? s.toLowerCase() : s);
  for (let dir = p.resolve(home); ; dir = p.dirname(dir)) {
    const prefix = slashes(dir, ctx).replace(/\/$/, "");
    const n = prefix.length;
    const atBoundary = value.length === n || value[n] === "/";
    if (n > 0 && atBoundary && fold(value.slice(0, n)) === fold(prefix)) return n;
    if (p.dirname(dir) === dir) return 0;
  }
}

/** `target` as an absolute path, the unknown variables it adds as wildcards. */
export function resolvePattern(target: string, ctx: PathContext): string {
  const abs = resolveAgainst(target, ctx);
  const literal = literalPrefix(abs, ctx);
  return abs.slice(0, literal) + abs.slice(literal).replace(PATH_VARIABLE, "*");
}

/**
 * The wildcards in `abs` (from `resolvePattern`) as a regular expression over `/`-separated
 * paths, or undefined when it has none (or is malformed). Only the agent's part can be a pattern:
 * CodeDen's home, and the folders above it, match literally (`literalPrefix`).
 */
export function agentPattern(abs: string, ctx: PathContext): RegExp | undefined {
  const value = slashes(abs, ctx);
  const literal = literalPrefix(abs, ctx);
  if (!WILDCARD.test(value.slice(literal))) return undefined;
  return wildcardPattern(value, isWin(ctx), literal);
}

/**
 * True when `target` reaches one of CodeDen's credential files: the file itself or a copy of
 * it, a folder that holds one (`<home>`, `<home>/runner`, `<home>/runner/mcp`: copying or
 * searching it reads them), anything in a secret folder (`codedenSecretFolders`), or a wildcard
 * that matches any of them. `~`, `$HOME`, `$CODEDEN_HOME` (and its PowerShell and cmd forms) and
 * relative paths resolve as in the shell. The home itself is always compared literally.
 */
export function touchesCodedenCredentials(target: string, ctx: PathContext): boolean {
  if (!ctx.codedenHome || !target.trim()) return false;
  const abs = resolvePattern(target, ctx);
  const guarded = guardedPaths(ctx);
  if (guarded.some((p) => samePath(p, abs, ctx))) return true;
  const folders = codedenSecretFolders(ctx);
  if (folders.some((folder) => isInside(abs, folder, ctx))) return true;
  const pattern = agentPattern(abs, ctx);
  if (pattern === undefined) return isCredentialCopy(abs, ctx);
  if (guarded.some((p) => pattern.test(slashes(p, ctx)))) return true;
  const glob = slashes(abs, ctx);
  const literal = literalPrefix(abs, ctx);
  const win = isWin(ctx);
  // A wildcard reaches a secret folder's files when it matches a session folder or file in it.
  const inFolder = (f: string) => {
    const start = `${slashes(f, ctx)}/${PRIVATE_MCP_FOLDER_PREFIX}`;
    return wildcardMatchesSessionFile(glob, start, PRIVATE_MCP_CONFIG_NAME, win, literal);
  };
  if (folders.some((f) => inFolder(f) === true)) return true;
  // Copies are numbered: a wildcard reaches them when it matches the start and some number.
  return codedenCredentialCopies(ctx).some(
    (copy) => wildcardMatchesNumbered(glob, slashes(copy, ctx), win, literal) === true,
  );
}

/**
 * The session's own folders inside CodeDen's home: its worktree (`<home>/wt/<project>/<id>`,
 * or the orchestrator's `<home>/orchestrator`) and extra roots there, and, for a call that only
 * reads (`forReading`), its artifacts folder. A working directory that is the home, or holds it,
 * opens nothing; an artifacts folder must lie below a folder of the home (`artifacts/<id>`), so
 * it can never open the home or a whole folder in it such as `artifacts` or `runner`.
 */
function ownFolders(ctx: PathContext): string[] {
  const home = ctx.codedenHome;
  if (!home) return [];
  const p = pathApi(ctx);
  const below = (root: string) => isInside(root, home, ctx) && !samePath(root, home, ctx);
  const artifacts =
    ctx.reading && ctx.artifactsDir && below(p.dirname(p.resolve(ctx.artifactsDir)))
      ? [ctx.artifactsDir]
      : [];
  return [ctx.cwd, ...(ctx.extraRoots ?? [])].filter(below).concat(artifacts);
}

/**
 * `ctx` for a call that only reads (a file read, a listing, a search, a command on the read-only
 * allowlist): the session's own artifacts folder (`artifactsDir`) counts as one of its own
 * folders, so it may read its screenshots, as in its own worktree (#338). Writes, deletes, and
 * anything else in CodeDen's home are judged on `ctx` itself and still ask.
 */
export function forReading(ctx: PathContext): PathContext {
  return ctx.artifactsDir ? { ...ctx, reading: true } : ctx;
}

/**
 * The folder of `abs` (from `resolvePattern`) before its first wildcard, which holds every path
 * it matches; undefined when it has no wildcard.
 */
function fixedFolder(abs: string, ctx: PathContext): string | undefined {
  const value = slashes(abs, ctx);
  const literal = literalPrefix(abs, ctx);
  const at = value.slice(literal).search(WILDCARD);
  if (at < 0) return undefined;
  return value.slice(0, value.lastIndexOf("/", literal + at) + 1) || "/";
}

/**
 * True when `target` reaches into CodeDen's home outside the session's own folders: a path in
 * the home (the home itself included), or a wildcard that can match one (`~/.c*`,
 * `$CODEDEN_HOME/*`). A path or pattern inside the session's own worktree doesn't; one in
 * another session's worktree does. Resolved like `touchesCodedenCredentials`.
 */
export function touchesCodedenHome(target: string, ctx: PathContext): boolean {
  const home = ctx.codedenHome;
  if (!home || !target.trim()) return false;
  const abs = resolvePattern(target, ctx);
  const folder = fixedFolder(abs, ctx);
  const fixed = folder ?? abs;
  if (ownFolders(ctx).some((root) => isInside(fixed, root, ctx))) return false;
  if (isInside(fixed, home, ctx)) return true;
  if (folder === undefined) return false;
  const glob = slashes(abs, ctx);
  const homeGlob = slashes(pathApi(ctx).resolve(home), ctx);
  return wildcardReaches(glob, homeGlob, isWin(ctx), literalPrefix(abs, ctx)) !== false;
}

/**
 * What `target` touches of CodeDen's home: one of its credential files (or a folder holding
 * one), anything else in it, or nothing.
 */
export function codedenAccess(
  target: string,
  ctx: PathContext,
): "credentials" | "home" | undefined {
  if (touchesCodedenCredentials(target, ctx)) return "credentials";
  return touchesCodedenHome(target, ctx) ? "home" : undefined;
}

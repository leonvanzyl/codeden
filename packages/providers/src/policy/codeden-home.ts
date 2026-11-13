import { CODEDEN_CREDENTIAL_FILES, INVALID_COPY_SUFFIX } from "@codeden/contracts";
import type { RiskAssessment } from "./assessment";
import { isWin, type PathContext, pathApi, resolveAgainst, samePath } from "./paths";
import { WILDCARD, wildcardMatchesNumbered, wildcardPattern } from "./wildcard";

export { wildcardPattern } from "./wildcard";

/**
 * CodeDen's own credential files (§15): the install token, the runner lock and the remote
 * access store in its data directory, and the copies CodeDen keeps of one it found damaged
 * (`<file>.invalid-<timestamp>`, with the same secrets in it). An agent holding the install
 * token or the runner's token could drive CodeDen itself and approve its own requests, so
 * touching one asks at every level, Full included, and is refused for read-only sessions
 * (§11.2). The data directory comes from the session (`SessionOptions.codedenHome`); without
 * it, this rule is off.
 */

/** A risky verdict on CodeDen's own credentials, which every level asks about. */
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

/** The credential files, then the folders that hold them. */
function guardedPaths(ctx: PathContext): string[] {
  const files = codedenCredentialFiles(ctx);
  const p = pathApi(ctx);
  return [...files, ...new Set(files.map((file) => p.dirname(file)))];
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
 * Variables left in a resolved path (`$f`, `${f}`, `$env:F`, `%F%`) could be any name, so they
 * match like `*`. `$CODEDEN_HOME`, `$HOME` and the temp variables at the start resolve first.
 */
const PATH_VARIABLE = /\$\{\w+\}|\$env:\w+|\$\w+|%\w+%/gi;

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
 * it, a folder that holds one (`<home>`, `<home>/runner`: copying or searching it reads them),
 * or a wildcard that matches any of them. `~`, `$HOME`, `$CODEDEN_HOME` (and its PowerShell
 * and cmd forms) and relative paths resolve as in the shell. The home itself is always compared
 * literally.
 */
export function touchesCodedenCredentials(target: string, ctx: PathContext): boolean {
  if (!ctx.codedenHome || !target.trim()) return false;
  const abs = resolvePattern(target, ctx);
  const guarded = guardedPaths(ctx);
  if (guarded.some((p) => samePath(p, abs, ctx))) return true;
  const pattern = agentPattern(abs, ctx);
  if (pattern === undefined) return isCredentialCopy(abs, ctx);
  if (guarded.some((p) => pattern.test(slashes(p, ctx)))) return true;
  // Copies are numbered: a wildcard reaches them when it matches the start and some number.
  const glob = slashes(abs, ctx);
  const literal = literalPrefix(abs, ctx);
  return codedenCredentialCopies(ctx).some(
    (copy) => wildcardMatchesNumbered(glob, slashes(copy, ctx), isWin(ctx), literal) === true,
  );
}

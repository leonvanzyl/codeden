import { CODEDEN_CREDENTIAL_FILES } from "@codeden/contracts";
import type { RiskAssessment } from "./assessment";
import { isWin, type PathContext, pathApi, resolveAgainst, samePath } from "./paths";

/**
 * CodeDen's own credential files (§15): the install token, the runner lock and the remote
 * access store in its data directory. An agent holding the install token or the runner's token
 * could drive CodeDen itself and approve its own requests, so touching one asks at every level,
 * Full included, and is refused for read-only sessions (§11.2). The data directory comes from
 * the session (`SessionOptions.codedenHome`); without it, this rule is off.
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

/** The credential files, then the folders that hold them. */
function guardedPaths(ctx: PathContext): string[] {
  const files = codedenCredentialFiles(ctx);
  const p = pathApi(ctx);
  return [...files, ...new Set(files.map((file) => p.dirname(file)))];
}

const WILDCARD = /[*?[]/;

/** `c` matched as itself in a regular expression. */
const literalChar = (c: string) => c.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * A shell wildcard (`*`, `?`, `[...]`, and `**`, which before a slash stands for zero or more
 * folders) over a `/`-separated path as a regular expression. Its first `literal` characters
 * match as themselves. Undefined when malformed.
 */
export function wildcardPattern(
  pattern: string,
  ignoreCase: boolean,
  literal = 0,
): RegExp | undefined {
  let source = pattern.slice(0, literal).replace(/[\s\S]/g, literalChar);
  for (let i = literal; i < pattern.length; i += 1) {
    const c = pattern[i] as string;
    if (c === "*" && pattern[i + 1] === "*") {
      const folders = pattern[i + 2] === "/";
      source += folders ? "(?:.*/)?" : ".*";
      i += folders ? 2 : 1;
    } else if (c === "*") {
      source += "[^/]*";
    } else if (c === "?") {
      source += "[^/]";
    } else if (c === "[" && pattern.indexOf("]", i + 2) > 0) {
      const end = pattern.indexOf("]", i + 2);
      const body = pattern
        .slice(i + 1, end)
        .replace(/^!/, "^")
        .replace(/\\/g, "\\\\");
      source += `[${body}]`;
      i = end;
    } else {
      source += literalChar(c);
    }
  }
  try {
    return new RegExp(`^${source}$`, ignoreCase ? "i" : "");
  } catch {
    return undefined;
  }
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
 * True when `target` reaches one of CodeDen's credential files: the file itself, a folder that
 * holds one (`<home>`, `<home>/runner`: copying or searching it reads them), or a wildcard that
 * matches either. `~`, `$HOME`, `$CODEDEN_HOME` (and its PowerShell and cmd forms) and relative
 * paths resolve as in the shell. The home itself is always compared literally.
 */
export function touchesCodedenCredentials(target: string, ctx: PathContext): boolean {
  if (!ctx.codedenHome || !target.trim()) return false;
  const abs = resolvePattern(target, ctx);
  const guarded = guardedPaths(ctx);
  if (guarded.some((p) => samePath(p, abs, ctx))) return true;
  const pattern = agentPattern(abs, ctx);
  return pattern !== undefined && guarded.some((p) => pattern.test(slashes(p, ctx)));
}

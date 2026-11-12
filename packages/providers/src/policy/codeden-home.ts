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

export const WILDCARD = /[*?[]/;

/**
 * A shell wildcard (`*`, `?`, `[...]`, and `**`, which before a slash stands for zero or more
 * folders) over a `/`-separated path as a regular expression. Undefined when malformed.
 */
export function wildcardPattern(pattern: string, ignoreCase: boolean): RegExp | undefined {
  let source = "";
  for (let i = 0; i < pattern.length; i += 1) {
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
      source += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
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

/** `target` as an absolute path, its unknown variables as wildcards. */
export function resolvePattern(target: string, ctx: PathContext): string {
  return resolveAgainst(target, ctx).replace(PATH_VARIABLE, "*");
}

/**
 * True when `target` reaches one of CodeDen's credential files: the file itself, a folder that
 * holds one (`<home>`, `<home>/runner`: copying or searching it reads them), or a wildcard that
 * matches either. `~`, `$HOME`, `$CODEDEN_HOME` (and its PowerShell and cmd forms) and relative
 * paths resolve as in the shell.
 */
export function touchesCodedenCredentials(target: string, ctx: PathContext): boolean {
  if (!ctx.codedenHome || !target.trim()) return false;
  const abs = resolvePattern(target, ctx);
  const guarded = guardedPaths(ctx);
  if (!WILDCARD.test(abs)) return guarded.some((p) => samePath(p, abs, ctx));
  const pattern = wildcardPattern(slashes(abs, ctx), isWin(ctx));
  return pattern !== undefined && guarded.some((p) => pattern.test(slashes(p, ctx)));
}

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

/** The credential files in CodeDen's home, then the folders that hold them. */
function guardedPaths(home: string, ctx: PathContext): string[] {
  const p = pathApi(ctx);
  const files = CODEDEN_CREDENTIAL_FILES.map((file) => p.join(home, file));
  return [...files, ...new Set(files.map((file) => p.dirname(file)))];
}

const WILDCARD = /[*?[]/;

/**
 * A shell wildcard (`*`, `**`, `?`, `[...]`) over a whole absolute path as a regular
 * expression, on `/`-separated paths. Undefined when the pattern is malformed.
 */
function wildcardPattern(pattern: string, ignoreCase: boolean): RegExp | undefined {
  let source = "";
  for (let i = 0; i < pattern.length; i += 1) {
    const c = pattern[i] as string;
    if (c === "*") {
      const deep = pattern[i + 1] === "*";
      source += deep ? ".*" : "[^/]*";
      if (deep) i += 1;
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

/**
 * True when `target` reaches one of CodeDen's credential files: the file itself, a folder that
 * holds one (`<home>`, `<home>/runner`: copying or searching it reads them), or a wildcard that
 * matches either. `~`, `$HOME`, `$CODEDEN_HOME` (and its PowerShell and cmd forms) and relative
 * paths resolve as in the shell.
 */
export function touchesCodedenCredentials(target: string, ctx: PathContext): boolean {
  const home = ctx.codedenHome;
  if (!home || !target.trim()) return false;
  const abs = resolveAgainst(target, ctx);
  const guarded = guardedPaths(home, ctx);
  if (!WILDCARD.test(abs)) return guarded.some((p) => samePath(p, abs, ctx));
  const win = isWin(ctx);
  const slashes = (s: string) => (win ? s.replace(/\\/g, "/") : s);
  const pattern = wildcardPattern(slashes(abs), win);
  return pattern !== undefined && guarded.some((p) => pattern.test(slashes(p)));
}

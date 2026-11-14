import os from "node:os";
import path from "node:path";
import type { RiskAssessment } from "./assessment";
import { binName, unwrap } from "./command-words";
import { isLoginFileName, isLoginInProviderFolder, LOGIN_FILE_NAMES } from "./login-names";
import { homeOf, isWin, type PathContext, pathApi, resolveAgainst, samePath } from "./paths";
import { secretArgument } from "./secrets";
import { type SimpleCommand, wordPaths } from "./shell";
import { WILDCARD, wildcardPattern } from "./wildcard";

/**
 * The agent CLIs' own logins (§11.2, §15): Claude Code's, Codex's, Gemini CLI's, OpenCode's,
 * Cursor CLI's and the GitHub CLI's OAuth tokens and keys, kept as plain files in the user's
 * home. An agent that reads or copies one can take over the account, so reading, copying,
 * moving, archiving or searching one (or the folder that holds it) asks at every level, Full
 * included. Writing one already asks as a write outside the worktree. Their settings (Codex's
 * `config.toml`, Claude's `settings.json`, ...) stay readable.
 *
 * Names alone are in `./login-names` (what `isSecretPath` knows). Here the session's home and
 * environment add the folders themselves and homes moved by a variable: `CODEX_HOME`,
 * `CLAUDE_CONFIG_DIR`, `GEMINI_CLI_HOME`, `XDG_DATA_HOME` (OpenCode), `XDG_CONFIG_HOME` and
 * `GH_CONFIG_DIR` (GitHub CLI, Cursor CLI), `CURSOR_CONFIG_DIR` and, on Windows, `APPDATA`
 * (`GitHub CLI`). A path may start with any of them (`$CODEX_HOME/auth.json`, `%APPDATA%\…`).
 */

/** A verdict on an agent CLI's login, which every level asks about. */
export function loginRisk(reason: string): RiskAssessment {
  return { risky: true, action: "secrets", reason, always: true };
}

type Env = Readonly<Record<string, string | undefined>>;

/** A variable's value, or undefined when unset or blank. Names compare in any case on Windows. */
function envValue(env: Env, name: string, win: boolean): string | undefined {
  const key = win ? Object.keys(env).find((k) => k.toUpperCase() === name) : name;
  return (key ? env[key] : undefined)?.trim() || undefined;
}

/** Each location variable's value: the environment's, else where the CLI looks without it. */
function locations(ctx: PathContext, home: string): Record<string, string[]> {
  const env = ctx.env ?? process.env;
  const win = isWin(ctx);
  const p = pathApi(ctx);
  const set = (name: string, fallback: string) => {
    const value = envValue(env, name, win);
    return value && value !== fallback ? [value, fallback] : [fallback];
  };
  const config = set("XDG_CONFIG_HOME", p.join(home, ".config"));
  return {
    CODEX_HOME: set("CODEX_HOME", p.join(home, ".codex")),
    CLAUDE_CONFIG_DIR: set("CLAUDE_CONFIG_DIR", p.join(home, ".claude")),
    GEMINI_CLI_HOME: set("GEMINI_CLI_HOME", home),
    XDG_DATA_HOME: set("XDG_DATA_HOME", p.join(home, ".local", "share")),
    XDG_CONFIG_HOME: config,
    GH_CONFIG_DIR: set("GH_CONFIG_DIR", p.join(config[0] as string, "gh")),
    CURSOR_CONFIG_DIR: set("CURSOR_CONFIG_DIR", p.join(home, ".cursor")),
    APPDATA: set("APPDATA", p.join(home, "AppData", "Roaming")),
  };
}

/**
 * The folders the agent CLIs keep their logins in, as absolute paths, for the context's home and
 * environment: both the default location and the one a variable moves it to.
 */
export function providerLoginFolders(ctx: PathContext): string[] {
  const home = homeOf(ctx);
  if (!home) return [];
  const p = pathApi(ctx);
  const at = locations(ctx, home);
  const under = (name: string, ...rest: string[]) =>
    (at[name] ?? []).map((dir) => p.join(dir, ...rest));
  const folders = [
    ...under("CODEX_HOME"),
    ...under("CLAUDE_CONFIG_DIR"),
    ...under("GEMINI_CLI_HOME", ".gemini"),
    ...under("XDG_DATA_HOME", "opencode"),
    ...under("GH_CONFIG_DIR"),
    ...under("XDG_CONFIG_HOME", "gh"),
    ...under("APPDATA", "GitHub CLI"),
    ...under("CURSOR_CONFIG_DIR"),
    ...under("XDG_CONFIG_HOME", "cursor"),
  ];
  return folders.map((dir) => resolveAgainst(dir, ctx));
}

/** A location variable at the start of a path, in POSIX, PowerShell or cmd form. */
const LOCATION_VAR = /^(?:\$\{(\w+)\}|\$env:(\w+)|\$(\w+)|%(\w+)%)(?=$|[\\/])/i;

/**
 * The paths `target` stands for once a location variable at its start is replaced: one per
 * value the variable may have (`locations`). Just `target` when it starts with none.
 */
function expandLocation(target: string, ctx: PathContext): string[] {
  const value = target.trim().replace(/^["']|["']$/g, "");
  const match = LOCATION_VAR.exec(value);
  const name = match?.slice(1).find(Boolean)?.toUpperCase();
  const home = homeOf(ctx);
  const dirs = name && home ? locations(ctx, home)[name] : undefined;
  if (!match || !dirs) return [value];
  return dirs.map((dir) => dir + value.slice(match[0].length));
}

/**
 * True when `file`, an absolute path on this machine, is one of the agent CLIs' logins for this
 * machine's home and environment: the server's evidence and share checks (§15), which see real
 * files rather than command words.
 */
export function isProviderLoginFile(
  file: string,
  home: string = os.homedir(),
  env: Env = process.env,
): boolean {
  return touchesProviderLogin(file, { cwd: path.dirname(file), home, env });
}

/** `/`-separated, for name and wildcard checks. */
const slashes = (value: string) => value.replace(/\\/g, "/");

/**
 * True when `target` reaches an agent CLI's login: a login file by name (`./login-names`), a
 * file with a credential-like name in a provider's login folder, the folder itself (copying,
 * archiving or searching it reads the login), or a wildcard that matches one of these. `~`, the
 * home variables and the location variables resolve as in the shell; relative paths from the
 * shell's directory.
 */
export function touchesProviderLogin(target: string, ctx: PathContext): boolean {
  if (!target.trim()) return false;
  const folders = providerLoginFolders(ctx);
  return expandLocation(target, ctx).some((value) => {
    if (isLoginFileName(slashes(value))) return true;
    const abs = resolveAgainst(value, ctx);
    if (isLoginFileName(slashes(abs))) return true;
    if (WILDCARD.test(value)) return wildcardReaches(abs, folders, ctx);
    if (folders.some((folder) => samePath(folder, abs, ctx))) return true;
    const p = pathApi(ctx);
    return (
      isLoginInProviderFolder(p.basename(abs).toLowerCase()) &&
      folders.some((folder) => samePath(folder, p.dirname(abs), ctx))
    );
  });
}

/**
 * True when the wildcard `abs` matches a login folder, a known login file in one, or Claude's
 * `.claude.json` in the home (`cat ~/.codex/*`, `tar czf x.tgz ~/.cod*`, `cat ~/.claude*`).
 */
function wildcardReaches(abs: string, folders: string[], ctx: PathContext): boolean {
  const pattern = wildcardPattern(slashes(abs), isWin(ctx));
  if (!pattern) return false;
  const p = pathApi(ctx);
  const candidates = [
    ...folders,
    ...folders.flatMap((folder) => LOGIN_FILE_NAMES.map((name) => p.join(folder, name))),
    p.join(homeOf(ctx), ".claude.json"),
  ];
  return candidates.some((candidate) => pattern.test(slashes(candidate)));
}

/**
 * Commands that move into, create or delete a folder or file: none reads what is in it. Deleting
 * a login asks as a delete outside the worktree, at every level.
 */
const NO_READ = new Set([
  "cd",
  "pushd",
  "chdir",
  "set-location",
  "sl",
  "push-location",
  "mkdir",
  "rm",
  "rmdir",
  "del",
  "erase",
  "rd",
  "remove-item",
  "ri",
  "unlink",
  "shred",
]);

/**
 * One simple command's access to an agent CLI's login: any argument that reaches one, read the
 * way the secrets rules read arguments (`./secrets`: listings, data words and search patterns
 * don't count). Looked for across the whole command first (`classifyCommand`), so an earlier
 * ordinary risk, which Full allows, can't hide it.
 */
export function providerLoginCommand(
  cmd: SimpleCommand,
  ctx: PathContext,
): RiskAssessment | undefined {
  const { tokens } = unwrap(cmd.words);
  const bin = binName(tokens[0]);
  if (NO_READ.has(bin)) return undefined;
  const found = secretArgument(
    bin,
    tokens.slice(1),
    [],
    (path) => touchesProviderLogin(path, ctx),
    (word, from) => wordPaths(cmd, word, from),
  );
  return found ? loginRisk(`Accesses an agent CLI's login: ${found}`) : undefined;
}

import { currentGitBranch } from "../util/git-head";
import { type RiskAssessment, risky, SAFE } from "./assessment";
import { credentialsRisk, touchesCodedenCredentials } from "./codeden-home";
import { binName, unwrap } from "./command-words";
import { classifyGit } from "./git";
import { classifyInstall } from "./installs";
import {
  isInside,
  isInWorkspace,
  isSecretPath,
  isTempRoot,
  isWritable,
  type PathContext,
  resolveAgainst,
} from "./paths";
import { pipesDownloadIntoInterpreter } from "./remote-scripts";
import { braceAlternatives, dumpsEnvironment, secretArgument, toolOutputs } from "./secrets";
import { parseShell, type ShellDialect, type SimpleCommand } from "./shell";

/**
 * Risky-action classifier for the `auto` and `full` autonomy levels (§11.2). Provider-neutral:
 * adapters translate their tool calls into `classifyCommand` / `classifyWrite` /
 * `classifyRead` / `classifyFetch` calls. A risky result is turned into an approval request;
 * everything else runs freely. Writes inside the worktree, the extra roots and the OS temp
 * directory are not risky; secrets files are, wherever they are.
 */
export type { RiskAssessment };

export interface RiskContext extends PathContext {
  /** Hosts the agent may fetch freely. When omitted, web fetches are not flagged. */
  allowedHosts?: readonly string[];
  /** The shell a command runs in, for its quoting rules. Default `auto`. */
  shell?: ShellDialect;
  /** The branch the session owns, which it may force-push with a lease (§11.2). */
  ownBranch?: string;
  /** The branch checked out in the worktree. Defaults to reading `cwd`'s git `HEAD`. */
  currentBranch?: () => string | undefined;
}

/** How deep `bash -c "…"` style inline scripts are followed. */
const MAX_DEPTH = 4;

/**
 * Classify a shell command (any shell: POSIX, PowerShell or cmd). Downloads piped into an
 * interpreter (`curl … | sh`, `irm … | iex`) are found on the parsed pipeline in
 * `classifyList`; here, a download run through a substitution (`iex (irm …)`,
 * `bash -c "$(curl …)"`, `bash <(curl …)`). CodeDen's own credentials are looked for first,
 * across the whole command, so an earlier ordinary risk (`cat .env; …`) can't hide them.
 */
export function classifyCommand(command: string, ctx: RiskContext): RiskAssessment {
  const list = parseShell(command, ctx.shell ?? "auto");
  const credentials = credentialAccess(list, ctx, 0);
  if (credentials) return credentials;
  if (
    /\b(iex|invoke-expression)\b[^|]*\b(irm|iwr|invoke-restmethod|invoke-webrequest|downloadstring)\b/i.test(
      command,
    )
  ) {
    return risky("network", "Executes a downloaded script");
  }
  if (
    /\b(bash|sh|zsh)\s+(-c\s+)?["']?\$\(\s*(curl|wget)\b/i.test(command) ||
    /<\(\s*(curl|wget)\b/i.test(command)
  ) {
    return risky("network", "Executes a downloaded script");
  }
  return classifyList(list, ctx, 0);
}

/**
 * The first access to CodeDen's own credential files anywhere in `list`: substitutions,
 * subshells and inline scripts (`bash -c "…"`) included, following `cd` like `classifyList`.
 */
function credentialAccess(
  list: SimpleCommand[],
  ctx: RiskContext,
  depth: number,
): RiskAssessment | undefined {
  let here = ctx;
  for (const cmd of list) {
    for (const nested of cmd.nested) {
      const found = credentialAccess(nested, here, depth);
      if (found) return found;
    }
    const found = credentialCommand(cmd, here, depth);
    if (found) return found;
    here = afterCd(cmd, here);
  }
  return undefined;
}

/**
 * One simple command's access to CodeDen's credentials: a redirect onto one, or any argument
 * that reaches one (read, written, copied or deleted). Moving into CodeDen's home with `cd`
 * reads nothing; the command that then reads is caught.
 */
function credentialCommand(
  cmd: SimpleCommand,
  ctx: RiskContext,
  depth: number,
): RiskAssessment | undefined {
  const { tokens } = unwrap(cmd.words);
  const bin = binName(tokens[0]);
  const args = tokens.slice(1);
  const script = inlineScript(bin, args);
  if (script && depth < MAX_DEPTH) {
    const inner = credentialAccess(parseShell(script.text, script.dialect), ctx, depth + 1);
    if (inner) return inner;
  }
  for (const target of cmd.writes) {
    if (!DISCARD.test(target) && touchesCodedenCredentials(target, ctx)) {
      return credentialsRisk(`Writes CodeDen's own credentials: ${target}`);
    }
  }
  if (CD.has(bin)) return undefined;
  const touched = secretArgument(bin, args, [], (a) => touchesCodedenCredentials(a, ctx));
  return touched ? credentialsRisk(`Accesses CodeDen's own credentials: ${touched}`) : undefined;
}

/**
 * Classify commands in order. A `cd` moves where later relative paths resolve; commands in
 * substitutions and subshells are classified too, without their `cd` leaking out.
 */
function classifyList(list: SimpleCommand[], ctx: RiskContext, depth: number): RiskAssessment {
  if (pipesDownloadIntoInterpreter(list)) {
    return risky("network", "Pipes a downloaded script straight into a shell");
  }
  let here = ctx;
  for (const cmd of list) {
    for (const nested of cmd.nested) {
      const result = classifyList(nested, here, depth);
      if (result.risky) return result;
    }
    const result = classifySimple(cmd, here, depth);
    if (result.risky) return result;
    here = afterCd(cmd, here);
  }
  return SAFE;
}

const CD = new Set(["cd", "pushd", "chdir", "set-location", "sl", "push-location"]);

/** The context after `cmd` when it changes directory (`cd dir`, `Set-Location -Path dir`). */
function afterCd(cmd: SimpleCommand, ctx: RiskContext): RiskContext {
  const { tokens } = unwrap(cmd.words);
  if (!CD.has(binName(tokens[0]))) return ctx;
  const args = tokens.slice(1);
  if (args.includes("-")) return ctx;
  const target =
    namedArg(args, ["-path", "-literalpath"]) ?? args.find((a) => !a.startsWith("-")) ?? "~";
  return { ...ctx, dir: resolveAgainst(target, ctx) };
}

/**
 * The value of a PowerShell-style named parameter, if present: `-Path x`, or bound with a
 * colon, `-Path:x`.
 */
function namedArg(args: string[], names: string[]): string | undefined {
  for (let i = 0; i < args.length; i += 1) {
    const arg = (args[i] as string).toLowerCase();
    if (names.includes(arg)) return args[i + 1];
    const bound = names.find((name) => arg.startsWith(`${name}:`));
    if (bound) return (args[i] as string).slice(bound.length + 1);
  }
  return undefined;
}

/** The script of an inline shell invocation (`bash -c "…"`, `pwsh -Command …`, `cmd /c …`). */
function inlineScript(
  bin: string,
  args: string[],
): { text: string; dialect: ShellDialect } | undefined {
  if (["sh", "bash", "zsh", "dash", "ksh", "ash", "fish"].includes(bin)) {
    const flag = args.findIndex((a) => /^-[a-z]*c[a-z]*$/i.test(a));
    const text = flag >= 0 ? args.slice(flag + 1).find((a) => !a.startsWith("-")) : undefined;
    return text ? { text, dialect: "posix" } : undefined;
  }
  if (bin === "pwsh" || bin === "powershell") {
    const flag = args.findIndex((a) => /^-(c|command)$/i.test(a));
    return flag >= 0 ? { text: args.slice(flag + 1).join(" "), dialect: "powershell" } : undefined;
  }
  if (bin === "cmd") {
    const flag = args.findIndex((a) => /^\/[ck]$/i.test(a));
    return flag >= 0 ? { text: args.slice(flag + 1).join(" "), dialect: "auto" } : undefined;
  }
  return undefined;
}

const DISCARD = /^(\/dev\/(null|stdout|stderr|tty)|nul|\$null)$/i;

function classifySimple(cmd: SimpleCommand, ctx: RiskContext, depth: number): RiskAssessment {
  const { tokens, elevated } = unwrap(cmd.words);
  if (elevated) return risky("other", "Runs a command with elevated privileges");
  const bin = binName(tokens[0]);
  const args = tokens.slice(1);
  const lower = args.map((a) => a.toLowerCase());

  const script = inlineScript(bin, args);
  if (script && depth < MAX_DEPTH) {
    const inner = classifyList(parseShell(script.text, script.dialect), ctx, depth + 1);
    if (inner.risky) return inner;
  }

  for (const target of cmd.writes) {
    if (DISCARD.test(target)) continue;
    const write = classifyWrite(target, ctx);
    if (write.risky) return write;
  }

  if (bin === "git") {
    return classifyGit(args, {
      ownBranch: ctx.ownBranch,
      currentBranch: ctx.currentBranch ?? (() => currentGitBranch(ctx.cwd)),
      inWorktree: isInside(resolveAgainst(".", ctx), ctx.cwd, ctx),
    });
  }

  const install = classifyInstall(bin, lower);
  if (install.risky) return install;

  if (["rm", "rmdir", "del", "erase", "rd", "remove-item", "ri", "unlink", "shred"].includes(bin)) {
    const targets = args.filter((a) => !a.startsWith("-") && !/^\/[a-z]$/i.test(a));
    for (const target of targets) {
      if (/^[\\/]$/.test(target) || /^[a-z]:[\\/]?$/i.test(target)) {
        return risky("outside_worktree", `Deletes ${target}`);
      }
      // `*` empties the current directory: fine in the worktree or a folder in temp.
      if (!isWritable(target === "*" ? "." : target, ctx)) {
        return risky("outside_worktree", `Deletes ${target}, outside the worktree`);
      }
    }
  }

  const dest = copyDestination(bin, args);
  const outputs = toolOutputs(bin, args);
  const written = dest ? [dest, ...outputs] : outputs;
  for (const target of [...(dest ? copyTargets(bin, args, dest, ctx) : []), ...outputs]) {
    const write = classifyWrite(target, ctx);
    if (write.risky) return write;
  }

  // Secrets: any argument that reads a credentials file.
  const secret = secretArgument(bin, args, written);
  if (secret) return risky("secrets", `Accesses the secrets file ${secret}`);

  if (dumpsEnvironment(bin, args)) return risky("secrets", "Dumps environment variables");
  return SAFE;
}

const COPIES = ["cp", "mv", "copy", "move", "copy-item", "move-item", "xcopy", "robocopy"];
const WRITERS = ["tee", "set-content", "out-file", "add-content"];
/** cmd-style copies, whose `/X` words are switches; for `cp` and `mv`, `/tmp` is a path. */
const CMD_COPIES = ["copy", "move", "xcopy", "robocopy"];

/** The path-like words of a copy or write: not options, nor cmd switches (`/E`, `/R:3`). */
function operands(bin: string, args: string[]): string[] {
  return args.filter(
    (a) => !a.startsWith("-") && !(CMD_COPIES.includes(bin) && /^\/[a-z]+(:\S*)?$/i.test(a)),
  );
}

/** Where a copy, move or file-writing command writes. */
function copyDestination(bin: string, args: string[]): string | undefined {
  if (!COPIES.includes(bin) && !WRITERS.includes(bin)) return undefined;
  const named = WRITERS.includes(bin)
    ? namedArg(args, ["-path", "-filepath", "-literalpath"])
    : namedArg(args, ["-destination"]);
  if (named) return named;
  const positional = operands(bin, args);
  return WRITERS.includes(bin) ? positional[0] : positional.at(-1);
}

/**
 * The paths a copy or write lands on. A copy into a temp directory itself (`cp a.png /tmp/`)
 * writes the copied names inside it, so they are checked instead (a secrets file there asks).
 */
function copyTargets(bin: string, args: string[], dest: string, ctx: RiskContext): string[] {
  if (!COPIES.includes(bin) || !isTempRoot(dest, ctx)) return [dest];
  const sources = operands(bin, args).filter((a) => a !== dest);
  const names = sources
    .map(
      (s) =>
        s
          .replace(/[\\/]+$/, "")
          .split(/[\\/]/)
          .pop() ?? "",
    )
    .filter(Boolean);
  return names.length ? names.map((name) => `${dest.replace(/[\\/]+$/, "")}/${name}`) : [dest];
}

/**
 * Classify a file write/edit. The worktree, extra roots and OS temp are fine, secrets files in
 * the worktree included: writing one (`cp .env.example .env`) reads nothing. A secrets file in
 * temp counts as outside the worktree, so Full autonomy (which only asks for writes outside the
 * worktree) still asks for it. CodeDen's own credential files ask at every level.
 */
export function classifyWrite(target: string, ctx: RiskContext): RiskAssessment {
  if (touchesCodedenCredentials(target, ctx)) {
    return credentialsRisk(`Writes CodeDen's own credentials: ${target}`);
  }
  if (!isWritable(target, ctx))
    return risky("outside_worktree", `Writes ${target}, outside the worktree`);
  if (isSecretPath(target) && !isInWorkspace(target, ctx)) {
    return risky("outside_worktree", `Writes the secrets file ${target}, outside the worktree`);
  }
  return SAFE;
}

/**
 * Classify a file read or search. Reads anywhere are fine except credential files; CodeDen's own
 * (or a folder holding them) ask at every level.
 */
export function classifyRead(target: string, ctx: RiskContext): RiskAssessment {
  if (touchesCodedenCredentials(target, ctx)) {
    return credentialsRisk(`Reads CodeDen's own credentials: ${target}`);
  }
  if (isSecretPath(target)) return risky("secrets", `Reads the secrets file ${target}`);
  return SAFE;
}

/**
 * Classify a file-name search: `pattern` (Claude's Glob, or a search's `--glob` filter) from
 * `base` (default: the current directory). Listing names reads nothing, so only a pattern that
 * reaches CodeDen's own credential files asks; `{a,b}` alternatives are followed.
 */
export function classifyGlob(
  pattern: string,
  base: string | undefined,
  ctx: RiskContext,
): RiskAssessment {
  if (!pattern.trim()) return SAFE;
  const dir = base ? resolveAgainst(base, ctx) : (ctx.dir ?? ctx.cwd);
  const reaches = braceAlternatives(pattern).some((alt) =>
    touchesCodedenCredentials(alt, { ...ctx, dir }),
  );
  return reaches ? credentialsRisk(`Lists CodeDen's own credential files: ${pattern}`) : SAFE;
}

/** Classify a web fetch. Only flagged when the context has an allowlist of hosts. */
export function classifyFetch(url: string, ctx: RiskContext): RiskAssessment {
  if (!ctx.allowedHosts) return SAFE;
  let host: string;
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return risky("network", `Fetches an unparseable URL: ${url}`);
  }
  const allowed = ctx.allowedHosts.some((h) => {
    const rule = h.toLowerCase();
    return rule.startsWith("*.") ? host.endsWith(rule.slice(1)) : host === rule;
  });
  return allowed
    ? SAFE
    : risky("network", `Fetches ${host}, which is not on the allowed host list`);
}

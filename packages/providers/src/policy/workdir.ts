import { type RiskAssessment, risky, SAFE } from "./assessment";
import { CODEDEN_WHAT } from "./codeden-command";
import { codedenAccess, credentialsRisk, forReading } from "./codeden-home";
import { binName, DISCARD } from "./command-words";
import { inlineScripts, scriptFlag } from "./inline-scripts";
import { isWritable, type PathContext, resolveAgainst } from "./paths";
import { readOnlyCommandDenial } from "./read-only";
import { parseShell, type ShellDialect } from "./shell";

/**
 * The folder a shell command runs in, as its provider reports it (§11.2, #613): Codex's request
 * `cwd`, OpenCode's `workdir`, an ACP agent's `cwd`. Relative paths in the command resolve from
 * it (`PathContext.dir`), but a command that names no path acts on it as well: `git clean -fdx`,
 * `git reset --hard`, `make clean` and `npm install` change the folder they run in. So a command
 * that runs where the session may not write (outside the worktree, the extra roots, temp and the
 * notes folders) is a write outside the worktree unless it only reads, and one that runs in
 * CodeDen's own home, outside the session's own folders there, asks at every level like any
 * other access to the home (reads in the session's own artifacts folder excepted). A `cd` inside
 * the command is not followed here.
 */

/** A context the folder checks can read: paths, plus the shell the command runs in. */
type WorkdirContext = PathContext & { shell?: ShellDialect };

/**
 * Shells whose inline script (`bash -lc '…'`, `pwsh -Command …`, `cmd /c …`) is the command. Not
 * fish: it runs every `-c` it is given and its `--init-command`s first, and only the first script
 * is read.
 */
const WRAPPERS = new Set(["sh", "bash", "zsh", "dash", "ksh", "ash", "pwsh", "powershell", "cmd"]);

/**
 * POSIX shell options before the script that run nothing of their own: clusters such as `-lc`,
 * `-ec` or `-euo pipefail` (`o` takes the option name after it), `--login`, `--noprofile` and
 * `--norc`. Not `--rcfile`, `--init-file` or `-s`, which run a file or standard input.
 */
const POSIX_OPTION = /^(-[ceilouvx]+|--login|--noprofile|--norc)$/;
/** PowerShell switches before `-Command` that run nothing (`-NoProfile`, `-NonInteractive`). */
const PS_SWITCH = new Set([
  "-noprofile",
  "-nop",
  "-nologo",
  "-nol",
  "-noninteractive",
  "-noni",
  "-login",
  "-l",
  "-mta",
  "-sta",
]);
/** PowerShell options before `-Command` that take a value and run nothing (`-ExecutionPolicy`). */
const PS_VALUE = new Set([
  "-executionpolicy",
  "-ep",
  "-ex",
  "-windowstyle",
  "-w",
  "-outputformat",
  "-o",
  "-of",
  "-inputformat",
  "-inp",
  "-if",
]);
/** cmd's switches before `/c` (`/d`, `/s`, `/q`, `/v:on`), also in Git Bash's `//d` form. */
const CMD_OPTION = /^\/\/?[a-z](:[a-z0-9]+)?$/i;

/** How many shells deep `bash -lc "pwsh -Command …"` is unwrapped. */
const MAX_DEPTH = 3;

/**
 * The risk of running `commands` (one command line, and any parsed forms of it the provider sent)
 * in `dir` (absolute, or relative to the context's location). Undefined `dir`: the provider names
 * no folder, so the command runs in the session's own working directory, where it was started.
 */
export function workdirRisk(
  commands: readonly string[],
  dir: string | undefined,
  ctx: WorkdirContext,
): RiskAssessment {
  if (dir === undefined || !dir.trim()) return SAFE;
  const abs = resolveAgainst(dir, ctx);
  const reads = onlyReads(commands, ctx);
  const access = codedenAccess(abs, reads ? forReading(ctx) : ctx);
  if (access === "credentials") {
    return credentialsRisk(`Runs in a folder holding ${CODEDEN_WHAT.credentials}: ${abs}`);
  }
  if (access) return credentialsRisk(`Runs in ${CODEDEN_WHAT.home}: ${abs}`);
  if (isWritable(abs, ctx) || reads) return SAFE;
  return risky("outside_worktree", `Runs in ${abs}, outside the worktree`);
}

/**
 * The risk of `commands` when the folder they run in can't be known: input typed into a running
 * terminal, whose shell may have moved since it started. Only reading runs freely.
 */
export function unknownWorkdirRisk(
  commands: readonly string[],
  ctx: WorkdirContext,
): RiskAssessment {
  if (onlyReads(commands, ctx)) return SAFE;
  return risky("outside_worktree", "Types into a running command, in a folder CodeDen can't tell");
}

/** True when every command line given only reads (`./read-only`), and at least one is given. */
function onlyReads(commands: readonly string[], ctx: WorkdirContext): boolean {
  const lines = commands.filter((c) => c.trim());
  return lines.length > 0 && lines.every((line) => readsOnly(line, ctx.shell ?? "auto", 0));
}

/**
 * True when `line` is on the read-only allowlist, as it is or as the script of the shell that
 * runs it: providers send `bash -lc 'git log'` or `pwsh -Command "git status"` for `git log` and
 * `git status`. The shell itself must do nothing else: no redirect, substitution or elevation,
 * nothing in front of it (`BASH_ENV=x`, `PATH=.`, `env`, `sudo`), and only options that run
 * nothing before its script (`plainOptions`), so no file of the folder runs first.
 */
function readsOnly(line: string, dialect: ShellDialect, depth: number): boolean {
  if (readOnlyCommandDenial(line) === undefined) return true;
  if (depth >= MAX_DEPTH) return false;
  const list = parseShell(line, dialect);
  const cmd = list[0];
  if (list.length !== 1 || !cmd) return false;
  if (cmd.nested.length > 0 || cmd.reads?.length || cmd.input?.length) return false;
  if (cmd.writes.some((target) => !DISCARD.test(target))) return false;
  const [first, ...args] = cmd.words;
  const bin = binName(first);
  if (!WRAPPERS.has(bin) || !plainOptions(bin, args)) return false;
  const scripts = inlineScripts(bin, args, cmd);
  return (
    scripts.length > 0 &&
    scripts.every((script) => readsOnly(script.text, script.dialect, depth + 1))
  );
}

/**
 * True when the words before the shell's script (`args`: the words after the shell) are options
 * that run nothing: `POSIX_OPTION`, `PS_SWITCH` and `PS_VALUE`, or `CMD_OPTION`.
 */
function plainOptions(bin: string, args: readonly string[]): boolean {
  const flag = scriptFlag(bin, args);
  if (flag < 0) return false;
  if (bin === "cmd") return args.slice(0, flag).every((word) => CMD_OPTION.test(word));
  if (bin === "pwsh" || bin === "powershell") {
    for (let i = 0; i < flag; i += 1) {
      const word = (args[i] as string).toLowerCase();
      if (PS_VALUE.has(word) && i + 1 < flag) i += 1;
      else if (!PS_SWITCH.has(word)) return false;
    }
    return true;
  }
  // POSIX: the script is the first word after the flag that isn't an option (`inlineScripts`).
  const script = args.findIndex((word, i) => i > flag && !word.startsWith("-"));
  if (script < 0) return false;
  for (let i = 0; i < script; i += 1) {
    const word = args[i] as string;
    if (!POSIX_OPTION.test(word)) return false;
    if (!word.startsWith("--") && word.includes("o")) {
      i += 1;
      if (i >= script || !/^[a-z_]+$/i.test(args[i] as string)) return false;
    }
  }
  return true;
}

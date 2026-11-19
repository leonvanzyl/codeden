import type { ShellDialect, SimpleCommand } from "./shell";
import { startedProcesses } from "./start-process";

/**
 * Command lines that another command runs (§11.2): a shell's inline script (`bash -c "…"`,
 * `pwsh -Command …`, `cmd /c …`), the commands of cmd's `for` loop (#499) and the program
 * `Start-Process` starts (#541, `./start-process`). The risk classifier parses each one and
 * classifies it like a command line of its own.
 */

export interface InlineScript {
  /** The command line, as the shell gets it. */
  text: string;
  dialect: ShellDialect;
  /**
   * True when its output goes to the command that runs it rather than to the agent, like the
   * command a `for /f` loop reads (`('set AWS')`).
   */
  feeds?: boolean;
  /** The folder it runs in (`Start-Process -WorkingDirectory`), as written; else where it is run. */
  dir?: string;
  /** True when it runs elevated (`Start-Process -Verb RunAs`). */
  elevated?: boolean;
}

const SHELLS = new Set(["sh", "bash", "zsh", "dash", "ksh", "ash", "fish"]);

/** True for a program that runs a command line given to it: a POSIX shell, PowerShell or cmd. */
export const isShell = (bin: string): boolean =>
  SHELLS.has(bin) || bin === "pwsh" || bin === "powershell" || bin === "cmd";

/**
 * The command lines `bin` runs, given the words after it; `cmd`: the command they are from.
 * `joined`: the words are a started shell's whole argument list (`Start-Process bash`), so a POSIX
 * shell's script is everything after `-c`, as the other shells read theirs.
 */
export function inlineScripts(
  bin: string,
  args: string[],
  cmd: SimpleCommand,
  joined = false,
): InlineScript[] {
  if (SHELLS.has(bin)) {
    const flag = args.findIndex((a) => /^-[a-z]*c[a-z]*$/i.test(a));
    const rest = flag >= 0 ? args.slice(flag + 1) : [];
    const text = joined ? rest.join(" ") : rest.find((a) => !a.startsWith("-"));
    return text ? [{ text, dialect: "posix" }] : [];
  }
  if (bin === "pwsh" || bin === "powershell") {
    const flag = args.findIndex((a) => /^-(c|command)$/i.test(a));
    return flag >= 0 ? [{ text: args.slice(flag + 1).join(" "), dialect: "powershell" }] : [];
  }
  if (bin === "cmd") {
    // Git Bash writes `/c` as `//c`, which its path conversion leaves alone.
    const flag = args.findIndex((a) => /^\/\/?[ck]$/i.test(a));
    if (flag < 0) return [];
    return cmdForms(args.slice(flag + 1).join(" ")).map((text) => ({ text, dialect: "auto" }));
  }
  if (bin === "for") return forLoop(args);
  return startedProcesses(bin, args, cmd);
}

/**
 * The forms `cmd /c` may run a command line in. When it starts with `"` (after spaces), cmd drops
 * that quote and the last one on the line, keeping only one quoted program path with spaces as
 * written (`"C:\Program Files\x.exe" arg`), so `"set AWS"` runs `set AWS`. Both forms are given.
 */
function cmdForms(text: string): string[] {
  const line = text.trim();
  if (!line.startsWith('"')) return [text];
  const last = line.lastIndexOf('"');
  return [text, last > 0 ? line.slice(1, last) + line.slice(last + 1) : line.slice(1)];
}

/** The `(…)` set of a `for` loop, maybe with `do` written right after it: `('set')do`. */
const SET = /^\(([\s\S]*)\)(do)?$/i;
/** A command a `for /f` loop reads: `'set AWS'`, or backquoted with `usebackq`. */
const QUOTED_COMMAND = /^(['`])([\s\S]*)\1$/;

/**
 * cmd's `for` loop: `for [/d | /r dir | /l | /f ["options"]] %i in (set) do command`. The command
 * after `do` runs for each item. `for /f` loops over lines, which it reads from a command's output
 * (`('set AWS')`, or `` (`set AWS`) `` with `usebackq`), from files (`(.env)`, or `("my file")` with
 * `usebackq`) or from a string (`("a b")`, or `('a b')` with `usebackq`). The lexer keeps the set
 * as written, so the command is parsed here; files are read as `type` reads them. Text in single
 * quotes or backquotes counts as a command whatever the switches and options say, so they can't
 * hide one. The loop runs it through `cmd /c`, which drops a leading `"` and the last one
 * (`('"set AWS"')` runs `set AWS`; `cmdForms`). cmd's `^` escapes (`'set AWS ^| findstr KEY'`) are
 * taken out. A POSIX `for` (`for f in *.txt; do`) has no `(…)` set and runs its body as commands
 * of their own.
 */
function forLoop(args: string[]): InlineScript[] {
  const lower = args.map((a) => a.toLowerCase());
  const at = lower.findIndex((w, i) => w === "in" && SET.test(args[i + 1] ?? ""));
  const set = SET.exec(args[at + 1] ?? "");
  if (at < 0 || !set) return [];
  const options = lower.slice(0, at);
  const lines = options.some((o) => o.startsWith("/f"));
  const usebackq = options.join(" ").includes("usebackq");
  const scripts: InlineScript[] = loopInput((set[1] as string).trim(), lines, usebackq).map(
    (text) => ({ text, dialect: "auto", feeds: true }),
  );
  const body = set[2] ? args.slice(at + 2) : doBody(args.slice(at + 2));
  if (body.length > 0) scripts.push({ text: uncaret(body.join(" ")), dialect: "auto" });
  return scripts;
}

/**
 * What a loop's set runs or reads, as command lines: its quoted command in each form `cmd /c` may
 * run it in, or `type` reading the files a `for /f` set names. A plain `for` only names its items.
 */
function loopInput(set: string, lines: boolean, usebackq: boolean): string[] {
  const command = QUOTED_COMMAND.exec(set);
  if (command) return cmdForms(uncaret(command[2] as string));
  if (!lines || set === "" || (set.startsWith('"') && !usebackq)) return [];
  return [`type ${uncaret(set)}`];
}

/** The words of the command after `do`: `do @echo %i`, or `do(set AWS)` written together. */
function doBody(rest: string[]): string[] {
  const first = rest[0]?.toLowerCase();
  if (first === "do") return rest.slice(1);
  if (first?.startsWith("do(")) return [(rest[0] as string).slice(2), ...rest.slice(1)];
  return [];
}

/** cmd's `^` escapes the character after it. */
const uncaret = (text: string) => text.replace(/\^([\s\S])/g, "$1");

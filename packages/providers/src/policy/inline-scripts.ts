import { binName } from "./command-words";
import type { ShellDialect, SimpleCommand } from "./shell";
import { type StartedProcess, startedProcesses } from "./start-process";

/**
 * Command lines that another command runs (§11.2): a shell's inline script (`bash -c "…"`,
 * `pwsh -Command …`, `cmd /c …`), the commands of cmd's `for` loop (#499) and the program
 * `Start-Process` starts (#541, `./start-process`), with the script of a shell it starts (#550).
 * The risk classifier parses each one and classifies it like a command line of its own.
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

/** The command lines `bin` runs, given the words after it; `cmd`: the command they are from. */
export function inlineScripts(bin: string, args: string[], cmd: SimpleCommand): InlineScript[] {
  const flag = scriptFlag(bin, args);
  if (SHELLS.has(bin)) {
    const text = flag >= 0 ? args.slice(flag + 1).find((a) => !a.startsWith("-")) : undefined;
    return text ? [{ text, dialect: "posix" }] : [];
  }
  if (bin === "pwsh" || bin === "powershell") {
    return flag >= 0 ? [{ text: args.slice(flag + 1).join(" "), dialect: "powershell" }] : [];
  }
  if (bin === "cmd") {
    if (flag < 0) return [];
    return cmdForms(args.slice(flag + 1).join(" ")).map((text) => ({ text, dialect: "auto" }));
  }
  if (bin === "for") return forLoop(args);
  return startedProcesses(bin, args, cmd).flatMap((p) => [p, ...startedShell(p, cmd)]);
}

/**
 * The word a shell's inline script follows: `-c` (also within `-lc`), `-Command` or cmd's `/c`
 * and `/k` (Git Bash writes them `//c`, which its path conversion leaves alone); -1 for none.
 */
export function scriptFlag(bin: string, args: readonly string[]): number {
  if (SHELLS.has(bin)) return args.findIndex((a) => /^-[a-z]*c[a-z]*$/i.test(a));
  if (bin === "pwsh" || bin === "powershell")
    return args.findIndex((a) => /^-(c|command)$/i.test(a));
  if (bin === "cmd") return args.findIndex((a) => /^\/\/?[ck]$/i.test(a));
  return -1;
}

/**
 * The script of a shell `Start-Process` starts (#550). It joins the argument list with spaces into
 * the shell's command line, so `-ArgumentList '-c','irm … | iex'` runs `irm … | iex`, pipe and
 * all. Every word after the script flag is taken as the script, the way PowerShell and cmd read
 * it; a POSIX shell given them unquoted would run only the first, which asks no less.
 */
function startedShell(started: StartedProcess, cmd: SimpleCommand): InlineScript[] {
  const bin = binName(started.program);
  const words = commandLineWords(started.args.join(" "));
  const flag = scriptFlag(bin, words);
  if (flag < 0) return [];
  const script = words.slice(flag + 1).join(" ");
  return inlineScripts(bin, [...words.slice(0, flag + 1), script], cmd).map((inner) => ({
    ...inner,
    dir: started.dir,
    elevated: started.elevated,
  }));
}

/**
 * A command line split into words the way a Windows program reads it: spaces separate them,
 * double quotes group them (and `\"` is a quote).
 */
function commandLineWords(line: string): string[] {
  const words: string[] = [];
  let word: string | undefined;
  let quoted = false;
  for (let i = 0; i < line.length; i += 1) {
    const c = line[i] as string;
    if (c === "\\" && line[i + 1] === '"') {
      word = `${word ?? ""}"`;
      i += 1;
    } else if (c === '"') {
      quoted = !quoted;
      word ??= "";
    } else if (/\s/.test(c) && !quoted) {
      if (word !== undefined) words.push(word);
      word = undefined;
    } else word = (word ?? "") + c;
  }
  if (word !== undefined) words.push(word);
  return words;
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

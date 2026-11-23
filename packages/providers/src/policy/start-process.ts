import type { InlineScript } from "./inline-scripts";
import { parseShell, type SimpleCommand, wordPaths } from "./shell";

/**
 * The command line `Start-Process` (and its aliases `saps` and `start`) runs (#541, §11.2), so it is
 * judged like the same command run directly: a `reg`, `regedit` or `setx` write, a delete, or an
 * inline `powershell -Command` or `cmd /c` script. The program is `-FilePath` or the first
 * positional word. Its arguments are `-ArgumentList` (a list, `'a','b'` or `@('a','b')`, or one
 * string), which Start-Process joins with spaces. Relative paths resolve from `-WorkingDirectory`.
 * `-RedirectStandardOutput` and `-RedirectStandardError` write files, as `>` and `2>` do, and
 * `-Verb RunAs` runs the program elevated. Opening a program, file or URL runs freely.
 *
 * cmd's `start` reads the same way: its switches (`/b`, `/wait`, `/d dir`) come before the program,
 * and every word after the program is an argument. Once quotes are gone, a title before the program
 * (`start "title" /b reg add …`) looks like the program, so `start` is also read with its first word
 * that isn't a switch as a title, with switches before and after it (#550; `start /b "" reg add …`
 * works too). cmd has no escapes, so a `\` before a space ends a word
 * (`start /d C:\ cmd …`).
 *
 * A shell started this way (`Start-Process powershell -ArgumentList '-c','irm … | iex'`) gets the
 * joined arguments as its command line, so its script, pipes included, is read by
 * `./inline-scripts` from `program` and `args`.
 */

/** A command line `Start-Process` or `start` starts: its program and the arguments it is given. */
export interface StartedProcess extends InlineScript {
  program: string;
  args: string[];
}

const STARTS = new Set(["start-process", "saps", "start"]);

/** Start-Process's parameters that take a value, with PowerShell's common ones. */
const VALUED = [
  "filepath",
  "argumentlist",
  "workingdirectory",
  "verb",
  "windowstyle",
  "credential",
  "redirectstandardinput",
  "redirectstandardoutput",
  "redirectstandarderror",
  "environment",
  "erroraction",
  "warningaction",
  "informationaction",
  "progressaction",
  "errorvariable",
  "warningvariable",
  "informationvariable",
  "outvariable",
  "outbuffer",
  "pipelinevariable",
];
/** Its switches (which take no value), with the common ones. */
const SWITCHES = [
  "wait",
  "nonewwindow",
  "passthru",
  "loaduserprofile",
  "usenewenvironment",
  "verbose",
  "debug",
  "whatif",
  "confirm",
];
const ALIASES: Record<string, string> = {
  path: "filepath",
  pspath: "filepath",
  args: "argumentlist",
  runas: "credential",
  rsi: "redirectstandardinput",
  rso: "redirectstandardoutput",
  rse: "redirectstandarderror",
  lup: "loaduserprofile",
  nnw: "nonewwindow",
  ea: "erroraction",
  wa: "warningaction",
  infa: "informationaction",
  proga: "progressaction",
  ev: "errorvariable",
  wv: "warningvariable",
  iv: "informationvariable",
  ov: "outvariable",
  ob: "outbuffer",
  pv: "pipelinevariable",
  vb: "verbose",
  db: "debug",
  wi: "whatif",
  cf: "confirm",
};
const NAMES = [...VALUED, ...SWITCHES];

/** A PowerShell parameter (`-FilePath`, `-FilePath:x`); not a negative number or a lone `-`. */
const PARAM = /^-([a-z][\w-]*)(?::([\s\S]*))?$/i;
/** cmd `start`'s switches, before the program: `/b`, `/wait`, `/min`, `/d dir`, `/dC:\dir`. */
const CMD_SWITCH =
  /^\/\/?(?:b|i|min|max|wait|separate|shared|low|normal|high|realtime|abovenormal|belownormal|node|affinity|machine|d[^/]*)$/i;
/** cmd `start`'s switches that take the next word as their value. */
const CMD_VALUED = /^\/\/?(?:node|affinity|machine)$/i;

/** The command lines `Start-Process` runs, given the words after it; none for another command. */
export function startedProcesses(
  bin: string,
  words: string[],
  cmd: SimpleCommand,
): StartedProcess[] {
  if (!STARTS.has(bin)) return [];
  const args = bin === "start" ? words.flatMap((w) => w.split(/(?<=\\) /)) : words;
  const named = new Map<string, string[]>();
  const positional: string[] = [];
  let dir: string | undefined;
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i] as string;
    const param = PARAM.exec(arg);
    const name = param ? parameter(param[1] as string) : undefined;
    const program = named.has("filepath") || positional.length > 0;
    // After the program, a word that names no Start-Process parameter is one of its arguments.
    if (param && (name !== undefined || !program)) {
      if (name === undefined || !VALUED.includes(name)) continue;
      let value: string[];
      if (param[2] !== undefined) value = elements(cmd, arg, arg.length - param[2].length);
      else {
        const next = argument(cmd, args, i + 1);
        value = next.elements;
        i = next.end;
      }
      named.set(name, [...(named.get(name) ?? []), ...value]);
    } else if (!program && CMD_SWITCH.test(arg)) {
      const read = cmdSwitch(args, i);
      dir = read.dir ?? dir;
      i = read.end;
    } else positional.push(arg);
  }
  const filePath = named.get("filepath")?.[0];
  const listed = named.get("argumentlist") ?? [];
  const extra = (words: string[]) => [...words.flatMap((w) => elements(cmd, w)), ...listed];
  const workingDir = named.get("workingdirectory")?.[0] ?? dir;
  const forms: Array<{ program?: string; words: string[]; dir?: string }> = filePath
    ? [{ program: filePath, words: extra(positional), dir: workingDir }]
    : [{ program: positional[0], words: extra(positional.slice(1)), dir: workingDir }];
  if (bin === "start" && !filePath && args.length > 1) {
    // cmd's `start [switches] "title" [switches] program …`, the title's quotes gone.
    const titled = cmdStart(args);
    forms.push({ ...titled, words: extra(titled.words), dir: titled.dir ?? workingDir });
  }
  const elevated = (named.get("verb") ?? []).some((v) => /^runas/i.test(v));
  const redirects = [
    ...(named.get("redirectstandardoutput") ?? []).map((f) => `> ${quote(f)}`),
    ...(named.get("redirectstandarderror") ?? []).map((f) => `2> ${quote(f)}`),
    ...(named.get("redirectstandardinput") ?? []).map((f) => `< ${quote(f)}`),
  ];
  return forms.flatMap(({ program, words, dir }) => {
    if (!program) return [];
    const text = [quote(program), ...words, ...redirects].join(" ");
    return [{ text, dialect: "auto" as const, dir, elevated, program, args: words }];
  });
}

/**
 * cmd `start` read with a title: its first word that isn't a switch, with switches allowed before
 * and after it (`start /b "" reg …`, `start "" /b reg …`), then its program and that program's
 * arguments.
 */
function cmdStart(args: string[]): { program?: string; words: string[]; dir?: string } {
  let dir: string | undefined;
  let titled = false;
  let i = 0;
  while (i < args.length) {
    if (CMD_SWITCH.test(args[i] as string)) {
      const read = cmdSwitch(args, i);
      dir = read.dir ?? dir;
      i = read.end + 1;
    } else if (!titled) {
      titled = true;
      i += 1;
    } else break;
  }
  return { program: args[i], words: args.slice(i + 1), dir };
}

/** The cmd `start` switch at word `i`: the last word it takes, and the folder `/d dir` names. */
function cmdSwitch(args: string[], i: number): { end: number; dir?: string } {
  const d = /^\/\/?d(.*)$/i.exec(args[i] as string);
  if (d) return d[1] ? { end: i, dir: d[1] } : { end: i + 1, dir: args[i + 1] };
  return { end: CMD_VALUED.test(args[i] as string) ? i + 1 : i };
}

/** The Start-Process parameter a name stands for: the name, an alias or an unambiguous prefix. */
function parameter(name: string): string | undefined {
  const lower = name.toLowerCase();
  if (NAMES.includes(lower)) return lower;
  if (ALIASES[lower]) return ALIASES[lower];
  const matches = NAMES.filter((n) => n.startsWith(lower));
  return matches.length === 1 ? matches[0] : undefined;
}

/**
 * The elements of the argument starting at word `i`. A list written with spaces (`'a', 'b'`) goes
 * on past a word ending in a comma, and onto a word starting with one.
 */
function argument(
  cmd: SimpleCommand,
  args: string[],
  i: number,
): { elements: string[]; end: number } {
  if (i >= args.length) return { elements: [], end: i };
  let end = i;
  const comma = (word: string, at: (w: string) => number) =>
    cmd.lists?.get(word)?.includes(at(word)) === true;
  while (
    end + 1 < args.length &&
    (comma(args[end] as string, (w) => w.length - 1) || comma(args[end + 1] as string, () => 0))
  ) {
    end += 1;
  }
  return { elements: args.slice(i, end + 1).flatMap((w) => elements(cmd, w)), end };
}

/**
 * The elements of a word from `from` on (after a bound `-ArgumentList:`): a PowerShell list (`a,b`,
 * `@('a','b')`), or the word itself.
 */
function elements(cmd: SimpleCommand, word: string, from = 0): string[] {
  const group = /^@?\(([\s\S]*)\)$/.exec(word.slice(from));
  if (group) {
    return parseShell(group[1] as string, "powershell").flatMap((inner) =>
      inner.words.flatMap((w) => elements(inner, w)),
    );
  }
  const parts = wordPaths(cmd, word, from);
  return parts.length > 1 ? parts.slice(1) : parts;
}

/** A word as it must be written to stay one word in a command line. */
function quote(word: string): string {
  if (!/[\s'"]/.test(word)) return word;
  return word.includes("'") ? `"${word}"` : `'${word}'`;
}

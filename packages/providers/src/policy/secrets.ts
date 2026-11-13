import { isSecretPath } from "./paths";

/**
 * Secrets rules of the risk classifier (§11.2): which words of a command read a credentials
 * file, and which commands dump the environment. Writing a secrets file inside the worktree is
 * not access (`cp .env.example .env`); reading one is.
 */

/**
 * The argument as a path, or undefined when it can't be one: inline code, multi-line text
 * or anything with shell or code punctuation (`selected={row.key`) is not a file name. A
 * variable in braces (`${HOME}/.env`) is a path, and so is an option's value: `--file=x`, or
 * PowerShell's colon-bound `-Path:x` and `-LiteralPath:x`.
 */
function asPath(arg: string): string | undefined {
  const value = arg.replace(/^-+[a-z-]*=/i, "").replace(/^-[a-z][a-z-]*:(?=.)/i, "");
  if (!value || /[\n\r{}()<>|;=`]/.test(value.replace(/\$\{\w+\}/g, ""))) return undefined;
  return value;
}

/** Commands whose words are data or only checked for existence (`echo .env >> .gitignore`). */
export const DATA = new Set(["echo", "printf", "write-output", "write-host", "test", "[", "[["]);
/** Commands that list or describe files without reading them (`ls certs/*.pem`). */
const LISTS = new Set([
  "ls",
  "dir",
  "get-childitem",
  "gci",
  "find",
  "fd",
  "tree",
  "stat",
  "du",
  "test-path",
]);
/** Search commands, whose first operand is the pattern (`grep -rn "process.env" src`). */
export const SEARCHES = new Set([
  "grep",
  "egrep",
  "fgrep",
  "zgrep",
  "rg",
  "ag",
  "ack",
  "findstr",
  "select-string",
  "sls",
]);
/** Options that take the next word as their value, per search tool. */
const GREP_VALUED = [
  "-A",
  "-B",
  "-C",
  "-m",
  "-d",
  "-D",
  "--after-context",
  "--before-context",
  "--context",
  "--max-count",
  "--include",
  "--exclude",
  "--exclude-dir",
  "--label",
  "--binary-files",
  "--devices",
  "--directories",
];
const RG_VALUED = [
  ...GREP_VALUED,
  "-g",
  "--glob",
  "--iglob",
  "-t",
  "--type",
  "-T",
  "--type-not",
  "-j",
  "--threads",
  "--max-depth",
  "-M",
  "--max-columns",
  "--sort",
  "--sortr",
  "-r",
  "--replace",
  "--colors",
  "-E",
  "--encoding",
];
const SELECT_STRING_VALUED = [
  "-path",
  "-literalpath",
  "-include",
  "-exclude",
  "-encoding",
  "-context",
];

function searchValued(bin: string, arg: string): boolean {
  if (bin === "rg") return RG_VALUED.includes(arg);
  if (bin === "select-string" || bin === "sls")
    return SELECT_STRING_VALUED.includes(arg.toLowerCase());
  return GREP_VALUED.includes(arg);
}

/** Options that give the search pattern as the next word. */
const isPatternOption = (a: string) => a === "-e" || a === "--regexp" || /^-pattern$/i.test(a);

/** True when a search option takes the next word as its value: a pattern, a pattern file or other. */
const takesValue = (bin: string, a: string) =>
  isPatternOption(a) || a === "-f" || searchValued(bin, a);

/**
 * Search tools whose short options combine in one word, the getopt way, and whose `-e` and `-f`
 * take a value (`ag -f` and `ack -f` don't, so their words are left as written).
 */
const CLUSTERING = new Set(["grep", "egrep", "fgrep", "zgrep", "rg"]);

/**
 * A search command's words as the tool reads them, short options taken apart: `-ne.` is
 * `-n -e .`, `-fFILE` is `-f FILE` and `-A3` is `-A 3`. An option's value, and every word after
 * `--`, stays whole. Search roles (pattern, file) are only assigned to words in this form.
 */
export function searchArgs(bin: string, args: string[]): string[] {
  if (!CLUSTERING.has(bin)) return args;
  const out: string[] = [];
  for (let i = 0; i < args.length; i += 1) {
    const a = args[i] as string;
    if (a === "--") {
      out.push(...args.slice(i));
      break;
    }
    if (!/^-[^-]./.test(a)) {
      out.push(a);
      if (takesValue(bin, a) && i + 1 < args.length) out.push(args[++i] as string);
      continue;
    }
    for (let j = 1; j < a.length; j += 1) {
      const flag = `-${a[j]}`;
      out.push(flag);
      if (!takesValue(bin, flag)) continue;
      // The rest of the word is the value; at the end of the word, the next word is.
      if (j + 1 < a.length) out.push(a.slice(j + 1));
      else if (i + 1 < args.length) out.push(args[++i] as string);
      break;
    }
  }
  return out;
}

/**
 * The positions of a search command's pattern words: `-e`/`--regexp`/`-Pattern` values, or the
 * first operand when the pattern isn't given by an option (or a pattern file, `-f`). `findstr`'s
 * `/c:"text"` is a pattern too, and after `--` every word is an operand. Positions, not text: the
 * same words may also name a file. `args` are in `searchArgs` form.
 */
function searchPatterns(bin: string, args: string[]): Set<number> {
  const patterns = new Set<number>();
  let explicit = false;
  for (let i = 0; i < args.length; i += 1) {
    const a = args[i] as string;
    if (a === "--") break;
    if (isPatternOption(a)) {
      explicit = true;
      if (i + 1 < args.length) patterns.add(i + 1);
      i += 1;
    } else if (a.startsWith("--regexp=") || /^-pattern:/i.test(a) || /^\/c:/i.test(a)) {
      explicit = true;
      patterns.add(i);
    } else if (a === "-f" || a.startsWith("--file") || /^\/g:/i.test(a)) explicit = true;
  }
  if (explicit) return patterns;
  for (let i = 0; i < args.length; i += 1) {
    const a = args[i] as string;
    if (a === "--") {
      if (i + 1 < args.length) patterns.add(i + 1);
      break;
    }
    if (searchValued(bin, a)) {
      i += 1;
    } else if (!a.startsWith("-") && !(bin === "findstr" && a.startsWith("/"))) {
      patterns.add(i);
      break;
    }
  }
  return patterns;
}

/**
 * The file operands of a search command (`grep -r -e x src lib` -> `src`, `lib`): its words
 * that are neither options, option values nor patterns. `args` are in `searchArgs` form.
 */
export function searchOperands(bin: string, args: string[]): string[] {
  const patterns = searchPatterns(bin, args);
  const out: string[] = [];
  let operandsOnly = false;
  for (let i = 0; i < args.length; i += 1) {
    const a = args[i] as string;
    if (patterns.has(i)) continue;
    if (operandsOnly) out.push(a);
    else if (a === "--") operandsOnly = true;
    else if (takesValue(bin, a)) i += 1;
    else if (!a.startsWith("-") && !(bin === "findstr" && a.startsWith("/"))) out.push(a);
  }
  return out;
}

/**
 * The first argument that reads a credentials file, if any. `written` are the paths the command
 * writes (a copy's destination), which classifyWrite judges instead. `isSecret` decides which
 * paths count (default: secrets files by name).
 */
export function secretArgument(
  bin: string,
  args: string[],
  written: readonly string[] = [],
  isSecret: (path: string) => boolean = isSecretPath,
): string | undefined {
  if (DATA.has(bin)) return undefined;
  // `find -exec cat {}` and `fd -x cat` read what they find.
  const runs =
    (bin === "find" || bin === "fd") &&
    args.some((a) => /^-(exec|execdir|ok|okdir|x|X|-exec|-exec-batch)$/.test(a));
  if (LISTS.has(bin) && !runs) return undefined;
  const search = SEARCHES.has(bin);
  const words = search ? searchArgs(bin, args) : args;
  const patterns = search ? searchPatterns(bin, words) : new Set<number>();
  return words.find((a, i) => {
    if (patterns.has(i) || written.includes(a)) return false;
    return braceAlternatives(a).some((alt) => {
      const value = asPath(alt);
      return value !== undefined && isSecret(value);
    });
  });
}

/** The most words one argument's brace expansion is followed to. */
const MAX_ALTERNATIVES = 64;

/**
 * The words a shell's brace expansion makes of `word` (`~/.ssh/{id_rsa,x}` -> `~/.ssh/id_rsa`,
 * `~/.ssh/x`), capped; just `word` when it has no `{a,b}` group.
 */
export function braceAlternatives(word: string): string[] {
  const group = /\{([^{}]*,[^{}]*)\}/.exec(word);
  if (!group?.[1]) return [word];
  const before = word.slice(0, group.index);
  const after = word.slice(group.index + group[0].length);
  const out: string[] = [];
  for (const part of group[1].split(",")) {
    for (const alt of braceAlternatives(before + part + after)) {
      if (out.length >= MAX_ALTERNATIVES) return out;
      out.push(alt);
    }
  }
  return out;
}

/** Files a tool writes through its own options (`openssl req -keyout key.pem -out cert.pem`). */
export function toolOutputs(bin: string, args: string[]): string[] {
  if (bin !== "openssl" && bin !== "ssh-keygen") return [];
  const flags = bin === "openssl" ? ["-out", "-keyout"] : ["-f"];
  return args.flatMap((a, i) => (flags.includes(a) && args[i + 1] ? [args[i + 1] as string] : []));
}

/** Variable names that may hold a credential. */
const SECRET_VAR = /key|token|secret|passw|pwd|credential|auth|private|session|cookie/i;

/**
 * True for `printenv` and `Get-ChildItem env:` listings. Printing named variables that don't
 * look like credentials (`printenv PATH`, `Get-ChildItem env:NODE_ENV`) is not a dump.
 */
export function dumpsEnvironment(bin: string, args: string[]): boolean {
  const named = (names: string[]) =>
    names.length > 0 && names.every((n) => /^\w+$/.test(n) && !SECRET_VAR.test(n));
  if (bin === "printenv") return !named(args.filter((a) => !a.startsWith("-")));
  if (!/^(get-childitem|gci|ls|dir)$/.test(bin)) return false;
  const drives = args.filter((a) => /^env:/i.test(a));
  return drives.length > 0 && !named(drives.map((a) => a.slice(4)));
}

import { isSecretPath } from "./paths";

/**
 * Secrets rules of the risk classifier (§11.2): which words of a command read a credentials
 * file, and which commands dump the environment. Writing a secrets file inside the worktree is
 * not access (`cp .env.example .env`); reading one is.
 */

/**
 * The argument as a path, or undefined when it can't be one: inline code, multi-line text
 * or anything with shell or code punctuation (`selected={row.key`) is not a file name. A
 * variable in braces (`${HOME}/.env`) is a path.
 */
function asPath(arg: string): string | undefined {
  const value = arg.replace(/^-+[a-z-]*=/i, "");
  if (!value || /[\n\r{}()<>|;=`]/.test(value.replace(/\$\{\w+\}/g, ""))) return undefined;
  return value;
}

/** Commands whose words are data or only checked for existence (`echo .env >> .gitignore`). */
const DATA = new Set(["echo", "printf", "write-output", "write-host", "test", "[", "[["]);
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
const SEARCHES = new Set([
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

/**
 * The search pattern words of a search command: `-e`/`--regexp`/`-Pattern` values, or the first
 * operand when the pattern isn't given by an option (or a pattern file, `-f`). `findstr`'s
 * `/c:"text"` is a pattern too.
 */
function searchPatterns(bin: string, args: string[]): Set<string> {
  const patterns = new Set<string>();
  let explicit = false;
  for (let i = 0; i < args.length; i += 1) {
    const a = args[i] as string;
    if (a === "-e" || a === "--regexp" || /^-pattern$/i.test(a)) {
      explicit = true;
      const value = args[i + 1];
      if (value !== undefined) patterns.add(value);
      i += 1;
    } else if (a.startsWith("--regexp=") || /^\/c:/i.test(a)) {
      explicit = true;
      patterns.add(a);
    } else if (a === "-f" || a.startsWith("--file") || /^\/g:/i.test(a)) explicit = true;
  }
  if (explicit) return patterns;
  for (let i = 0; i < args.length; i += 1) {
    const a = args[i] as string;
    if (searchValued(bin, a)) {
      i += 1;
    } else if (!a.startsWith("-") && !(bin === "findstr" && a.startsWith("/"))) {
      patterns.add(a);
      break;
    }
  }
  return patterns;
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
  const patterns = SEARCHES.has(bin) ? searchPatterns(bin, args) : new Set<string>();
  return args.find((a) => {
    if (patterns.has(a) || written.includes(a)) return false;
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
function braceAlternatives(word: string): string[] {
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

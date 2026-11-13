import { isSecretPath } from "./paths";
import { parseSearch, SEARCHES, type SearchWord } from "./search-words";
import type { WordPaths } from "./shell";

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

/**
 * The first argument that reads a credentials file, if any. `written` are the paths the command
 * writes (a copy's destination), which classifyWrite judges instead. `isSecret` decides which
 * paths count (default: secrets files by name). `paths` gives what a word may stand for (each
 * element of a PowerShell list, `shell.wordPaths`). A search's patterns are skipped whole, list
 * elements included: the tool searches for them, not in them.
 */
export function secretArgument(
  bin: string,
  args: string[],
  written: readonly string[] = [],
  isSecret: (path: string) => boolean = isSecretPath,
  paths: WordPaths = (word, from) => [word.slice(from)],
): string | undefined {
  if (DATA.has(bin)) return undefined;
  // `find -exec cat {}` and `fd -x cat` read what they find.
  const runs =
    (bin === "find" || bin === "fd") &&
    args.some((a) => /^-(exec|execdir|ok|okdir|x|X|-exec|-exec-batch)$/.test(a));
  if (LISTS.has(bin) && !runs) return undefined;
  const words: Pick<SearchWord, "text" | "arg" | "from" | "pattern">[] = SEARCHES.has(bin)
    ? parseSearch(bin, args)
    : args.map((text, arg) => ({ text, arg, from: 0, pattern: false }));
  const found = words.find((w) => {
    if (w.pattern || written.includes(w.text)) return false;
    const candidates = w.arg >= 0 ? paths(args[w.arg] as string, w.from) : [w.text];
    return candidates.some((word) =>
      braceAlternatives(word).some((alt) => {
        const value = asPath(alt);
        return value !== undefined && isSecret(value);
      }),
    );
  });
  return found?.text;
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

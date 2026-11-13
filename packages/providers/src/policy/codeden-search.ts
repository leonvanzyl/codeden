import {
  agentPattern,
  codedenCredentialFiles,
  resolvePattern,
  slashes,
  touchesCodedenCredentials,
  wildcardPattern,
} from "./codeden-home";
import { isInside, type PathContext, pathApi, samePath } from "./paths";
import { braceAlternatives, DATA, SEARCHES, searchArgs, searchOperands } from "./secrets";

/**
 * Searches and listings that reach CodeDen's credential files from a folder above them
 * (§11.2). A recursive search (`grep -r`, `rg`, `findstr /s`) reads every file under its roots
 * that its name filters let through. A listing (`find`, `fd`, `ls`, `Get-ChildItem`) only names
 * files, which counts once the names feed another command: through a pipe
 * (`find ~ -name install-token | xargs cat`), a substitution (`cat $(find …)`) or `-exec`.
 */

/** Where a command looks for files: its roots, whether it goes into subfolders, and the name
 * patterns it keeps (none: every file). */
interface Walk {
  roots: string[];
  recursive: boolean;
  names: string[];
}

/** The values of an option, given as `name X`, `name=X` or `name:X`, each time it appears. */
function optionValues(args: string[], names: string[], anyCase: boolean): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i += 1) {
    const a = args[i] as string;
    const word = anyCase ? a.toLowerCase() : a;
    if (names.includes(word)) {
      if (i + 1 < args.length) out.push(args[i + 1] as string);
      i += 1;
      continue;
    }
    const bound = names.find((n) => word.startsWith(`${n}=`) || word.startsWith(`${n}:`));
    if (bound) out.push(a.slice(bound.length + 1));
  }
  return out;
}

const GREPS = new Set(["grep", "egrep", "fgrep", "zgrep"]);

/** `grep -r`, `-R`, `-rn`, `--recursive`, `-d recurse`: grep reads folders only then. */
function grepRecursive(args: string[]): boolean {
  return args.some(
    (a, i) =>
      /^-[a-zA-Z]*[rR][a-zA-Z]*$/.test(a) ||
      a === "--recursive" ||
      a === "--dereference-recursive" ||
      /^(--directories=|-d)recurse$/.test(a) ||
      ((a === "-d" || a === "--directories") && args[i + 1] === "recurse"),
  );
}

/** The folders a search reads recursively, with its name filters. */
function searchWalks(bin: string, words: string[], ctx: PathContext): Walk[] {
  // `grep -re. ~` is `grep -r -e . ~`: take clustered options apart before reading roles.
  const args = searchArgs(bin, words);
  if (bin === "rg" || bin === "ag" || bin === "ack") {
    // Only ripgrep's globs narrow; `!glob` excludes, and other filters are regexes or types.
    const names =
      bin === "rg"
        ? optionValues(args, ["-g", "--glob", "--iglob"], false).filter((n) => !n.startsWith("!"))
        : [];
    return [{ roots: searchOperands(bin, args), recursive: true, names }];
  }
  if (GREPS.has(bin)) {
    if (!grepRecursive(args)) return [];
    const names = optionValues(args, ["--include"], false);
    return [{ roots: searchOperands(bin, args), recursive: true, names }];
  }
  if (bin === "findstr" && args.some((a) => /^\/[a-z]*s[a-z]*$/i.test(a))) {
    // `findstr /s x C:\dir\*.txt` reads `*.txt` in `C:\dir` and every folder below it.
    const p = pathApi(ctx);
    return searchOperands(bin, args).map((operand) => ({
      roots: [p.dirname(operand)],
      recursive: true,
      names: [p.basename(operand)],
    }));
  }
  return [];
}

const LISTINGS = new Set(["get-childitem", "gci", "dir", "ls"]);
const LISTING_VALUED = ["-filter", "-include", "-exclude", "-depth", "-attributes"];
/** `find -exec cat {} +` and `fd -x cat` hand what they find to a command. */
const RUNS = /^-(exec|execdir|ok|okdir|x|X|-exec|-exec-batch)$/;

/** The folders a listing goes through, with its name filters. */
function listingWalk(bin: string, args: string[]): Walk | undefined {
  if (bin === "find") {
    const end = args.findIndex((a) => /^[-(!)]/.test(a));
    const either = args.some((a) => ["-o", "-or", "!", "-not"].includes(a));
    return {
      roots: end < 0 ? args : args.slice(0, end),
      recursive: true,
      names: either ? [] : optionValues(args, ["-name", "-iname"], false),
    };
  }
  if (bin === "fd") {
    // `fd [pattern] [path…]`: the pattern is a regular expression, so it doesn't narrow here.
    return { roots: args.filter((a) => !a.startsWith("-")).slice(1), recursive: true, names: [] };
  }
  if (!LISTINGS.has(bin)) return undefined;
  const recursive = args.some(
    (a) => /^-rec/i.test(a) || a === "-r" || /^-[a-zA-Z]*R[a-zA-Z]*$/.test(a) || /^\/s$/i.test(a),
  );
  const named = optionValues(args, ["-path", "-literalpath"], true);
  const positional: string[] = [];
  for (let i = 0; i < args.length; i += 1) {
    const a = args[i] as string;
    const lower = a.toLowerCase();
    if (LISTING_VALUED.includes(lower) || lower === "-path" || lower === "-literalpath") i += 1;
    else if (!a.startsWith("-") && !/^\/[a-z](:\S*)?$/i.test(a)) positional.push(a);
  }
  return {
    roots: [...named, ...positional].flatMap((root) => root.split(",")),
    recursive,
    names: optionValues(args, ["-filter", "-include"], true).flatMap((n) => n.split(",")),
  };
}

/**
 * True when listing `dir` (and, recursively, its subfolders) reaches `folder`: by its path, or
 * through the wildcards the agent wrote in it (never ones in CodeDen's home path).
 */
function holds(dir: string, folder: string, recursive: boolean, ctx: PathContext): boolean {
  if (recursive ? isInside(folder, dir, ctx) : samePath(dir, folder, ctx)) return true;
  const pattern = agentPattern(dir, ctx);
  if (!pattern) return false;
  const p = pathApi(ctx);
  for (let at = folder; ; at = p.dirname(at)) {
    if (pattern.test(slashes(at, ctx))) return true;
    if (!recursive || p.dirname(at) === at) return false;
  }
}

/** True when `file`, found under `root`, passes one of the name filters (or there are none). */
function keeps(names: string[], file: string, root: string, ctx: PathContext): boolean {
  if (names.length === 0) return true;
  const p = pathApi(ctx);
  const base = p.basename(file);
  const below = slashes(p.relative(root, file), ctx);
  return names
    .flatMap((name) => braceAlternatives(name.trim().replace(/^\.[\\/]/, "")))
    .some((name) => {
      const pattern = wildcardPattern(slashes(name, ctx), true);
      if (!pattern) return true;
      return /[\\/]/.test(name) ? pattern.test(below) : pattern.test(base);
    });
}

/** The root of `walk` from which it reaches a credential file, if any. */
function walkReaches(walk: Walk, ctx: PathContext): string | undefined {
  const files = codedenCredentialFiles(ctx);
  const p = pathApi(ctx);
  for (const root of walk.roots.length ? walk.roots : ["."]) {
    for (const alt of braceAlternatives(root)) {
      const dir = resolvePattern(alt, ctx);
      const found = files.some(
        (file) =>
          holds(dir, p.dirname(file), walk.recursive, ctx) && keeps(walk.names, file, dir, ctx),
      );
      if (found) return root;
    }
  }
  return undefined;
}

/**
 * A recursive search from `roots` (Claude's Grep), keeping files whose names match `names`:
 * the root it reaches a credential file from, if any.
 */
export function searchReaches(
  roots: string[],
  names: string[],
  ctx: PathContext,
): string | undefined {
  return ctx.codedenHome ? walkReaches({ roots, recursive: true, names }, ctx) : undefined;
}

/**
 * How a command reaches CodeDen's credential files other than by naming one: a recursive search
 * from a folder above them, or a listing (or `echo`ed path) whose output `feeds` another command.
 * Returns the word it reaches them through.
 */
export function reachesThroughFolder(
  bin: string,
  args: string[],
  ctx: PathContext,
  feeds: boolean,
): string | undefined {
  if (!ctx.codedenHome) return undefined;
  if (SEARCHES.has(bin)) {
    for (const walk of searchWalks(bin, args, ctx)) {
      const root = walkReaches(walk, ctx);
      if (root) return root;
    }
  }
  if (feeds || ((bin === "find" || bin === "fd") && args.some((a) => RUNS.test(a)))) {
    const walk = listingWalk(bin, args);
    const root = walk && walkReaches(walk, ctx);
    if (root) return root;
  }
  if (feeds && DATA.has(bin)) return args.find((a) => touchesCodedenCredentials(a, ctx));
  return undefined;
}

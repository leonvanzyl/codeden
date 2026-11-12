import { matchesLong } from "./read-only-options";

/**
 * Read-only rules for `gh` and `sed` (§11.2): which of their forms only read. Used by the
 * read-only allowlist; each returns why a command is refused, or undefined. Git's rules are in
 * `read-only-git.ts`.
 */

/** `gh` command groups whose reading verbs may run (extensions and other groups may not). */
const GH_GROUPS = new Set([
  "pr",
  "issue",
  "repo",
  "run",
  "workflow",
  "release",
  "gist",
  "label",
  "project",
  "ruleset",
  "cache",
  "org",
  "secret",
  "variable",
]);
/** `gh <group> <verb>` verbs that only read. */
const READ_ONLY_GH = new Set(["view", "list", "status", "diff", "checks"]);
/** Global `gh` flags that take the next word as their value (`gh -R o/r pr list`). */
const GH_VALUED = new Set(["-r", "--repo", "--hostname"]);

/** Why `gh <args>` (lower-cased) is refused in a read-only session. */
export function ghDenial(args: string[]): string | undefined {
  const positional: string[] = [];
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i] as string;
    if (GH_VALUED.has(arg)) i += 1;
    else if (!arg.startsWith("-")) positional.push(arg);
  }
  const [group, verb] = positional;
  if (group === "search" || group === "status") return undefined;
  if (group === "api") {
    const at = args.findIndex((a) => a === "-x" || a === "--method");
    const method =
      at >= 0
        ? args[at + 1]
        : (args.find((a) => a.startsWith("--method="))?.slice(9) ??
          args.find((a) => /^-x./.test(a))?.slice(2));
    // Fields (`-f`, `-F`, `--input`) make gh send a POST.
    const fields = args.some((a) => /^(-f|--field|--raw-field|--input)(=.*)?$/.test(a));
    if ((method && method !== "get") || fields) {
      return "Only GET requests with gh api are allowed in a read-only session";
    }
    return undefined;
  }
  if (!group || !GH_GROUPS.has(group) || !verb || !READ_ONLY_GH.has(verb)) {
    return "Only read-only gh commands are allowed (view, list, status, diff, checks, search, GET api)";
  }
  return undefined;
}

const ADDRESS = String.raw`(?:\d+|\$|/(?:[^/\\]|\\.)*/)`;
/** sed scripts that only print: `1,40p`, `/start/,/end/p`, `5q`, `$=`. */
const SED_PRINT = new RegExp(String.raw`^(?:${ADDRESS}(?:\s*,\s*(?:${ADDRESS}|\+\d+))?)?\s*[pq=]$`);
/** sed substitutions without the `w` (write) and `e` (execute) flags. */
const SED_SUBSTITUTE = /^s([^\w\s\\])(?:(?!\1)[^\\]|\\.)*\1(?:(?!\1)[^\\]|\\.)*\1[gip0-9]*$/i;
const SED_REFUSED = "sed may not edit files or read scripts in a read-only session";

/**
 * Why `sed <args>` (with their case) is refused: only printing scripts may run. Scripts come
 * from `-e` (also inside a cluster such as `-ne`, with the rest of the word as the script) and
 * `--expression` (abbreviations count), else from the first operand.
 */
export function sedDenial(args: string[]): string | undefined {
  const scripts: string[] = [];
  const operands: string[] = [];
  let explicit = false;
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i] as string;
    if (arg === "--") {
      operands.push(...args.slice(i + 1));
      break;
    }
    if (arg.startsWith("--")) {
      if (matchesLong(arg, "--in-place") || matchesLong(arg, "--file")) return SED_REFUSED;
      if (matchesLong(arg, "--expression")) {
        explicit = true;
        const at = arg.indexOf("=");
        if (at >= 0) scripts.push(arg.slice(at + 1));
        else {
          scripts.push(args[i + 1] ?? "");
          i += 1;
        }
      } else if (matchesLong(arg, "--line-length") && !arg.includes("=")) i += 1;
      continue;
    }
    if (arg.startsWith("-") && arg !== "-") {
      for (let j = 1; j < arg.length; j += 1) {
        const c = arg[j] as string;
        // `-i`/`-I` edit in place (GNU and BSD), `-f` reads a script file.
        if (c === "i" || c === "I" || c === "f") return SED_REFUSED;
        if (c === "e" || c === "l") {
          const value = arg.slice(j + 1) || args[i + 1] || "";
          if (!arg.slice(j + 1)) i += 1;
          if (c === "e") {
            explicit = true;
            scripts.push(value);
          }
          break;
        }
      }
      continue;
    }
    operands.push(arg);
  }
  if (!explicit && operands[0] !== undefined) scripts.push(operands[0]);
  const prints = (s: string) => SED_PRINT.test(s.trim()) || SED_SUBSTITUTE.test(s.trim());
  if (scripts.length === 0 || !scripts.every(prints)) {
    return "Only sed scripts that print (such as sed -n 1,40p) are allowed in a read-only session";
  }
  return undefined;
}

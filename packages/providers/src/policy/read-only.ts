import { gitDenial } from "./read-only-git";
import { groupingDenial, optionSensitive, writingOptionDenial } from "./read-only-options";
import { ghDenial, sedDenial } from "./read-only-tools";
import { parseShellWords, redirectsToFile, unquoted } from "./shell-words";

/**
 * Read-only sessions (the orchestrator and PMs, and agent sessions with the `read_only`
 * permission level, §11.2, and plan mode) may inspect a repository but never change it. This
 * allowlist decides which shell commands they may run: commands that only read, with no output
 * redirection, command substitution, variable expansion, grouping or script blocks, and none of
 * the options that make a reading program write or run something (`read-only-options.ts`,
 * `read-only-git.ts`). Options are read from the words the shell actually passes (`-'o'` is
 * `-o`, `shell-words.ts`). Agent sessions may also run the project's checks (tests, lint, type
 * checks) without fix or update flags. Anything else is denied.
 */

/**
 * Split on every `;`, `&&`, `||`, `|`, `&` (but not the `&` of `>&` or `&>`) and newline, even
 * inside quotes. Deliberately cruder than the risk classifier's lexer: for an allowlist,
 * over-splitting only denies more.
 */
function splitCommands(command: string): string[] {
  return command
    .split(/\r?\n|;|&&|\|\||\||(?<![<>&])&(?![>&])/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Programs that only read (or print). */
const READ_ONLY_BINS = new Set([
  "ls",
  "dir",
  "cat",
  "type",
  "head",
  "tail",
  "less",
  "more",
  "wc",
  "grep",
  "egrep",
  "fgrep",
  "rg",
  "find",
  "fd",
  "tree",
  "pwd",
  "echo",
  "printf",
  "which",
  "where",
  "whoami",
  "date",
  "stat",
  "file",
  "du",
  "df",
  "sort",
  "uniq",
  "cut",
  "diff",
  "jq",
  "basename",
  "dirname",
  "realpath",
  "true",
  "get-childitem",
  "gci",
  "get-content",
  "gc",
  "get-item",
  "gi",
  "get-location",
  "gl",
  "select-string",
  "sls",
  "measure-object",
  "test-path",
  "resolve-path",
  "write-output",
  "write-host",
  "select-object",
  "where-object",
  "format-list",
  "format-table",
  "out-string",
  "sort-object",
  "gh",
  "nl",
  // Changing directory only moves where the next command runs.
  "cd",
  "pushd",
  "popd",
  "chdir",
  "set-location",
  "sl",
  "push-location",
  "pop-location",
]);

const bin = (token: string | undefined): string =>
  (token ?? "")
    .replace(/\\/g, "/")
    .split("/")
    .pop()
    ?.toLowerCase()
    .replace(/\.(exe|cmd|bat|ps1)$/, "") ?? "";

/** Package managers whose `test`, `lint`, ... scripts count as checks. */
const PACKAGE_MANAGERS = new Set(["npm", "pnpm", "yarn", "bun"]);

/** Script names a package manager may run as a check (`pnpm test`, `npm run lint`). */
const CHECK_SCRIPTS = new Set([
  "test",
  "tests",
  "lint",
  "typecheck",
  "type-check",
  "check",
  "types",
  "vitest",
  "jest",
  "biome",
  "eslint",
  "tsc",
]);

/** Programs (null: any arguments) and `<program> <subcommand>` pairs that run checks. */
const CHECK_COMMANDS: Record<string, string[] | null> = {
  tsc: null,
  vitest: null,
  jest: null,
  eslint: null,
  pytest: null,
  mypy: null,
  pyright: null,
  biome: ["check", "lint", "ci"],
  ruff: ["check"],
  cargo: ["test", "check", "clippy"],
  go: ["test", "vet"],
  dotnet: ["test"],
  mvn: ["test", "verify"],
  gradle: ["test", "check"],
};

/** Flags that turn a check into a write (fixing, formatting, updating snapshots, watching). */
const WRITING_FLAG =
  /^(--fix|--fix-type=.*|--write|--apply|--apply-unsafe|--unsafe|-u|--update|--update-snapshots?|--updatesnapshot|--watch|-w)(=.*)?$/;

/** True when `name args` runs a known check without writing flags. */
function isCheck(name: string, args: string[]): boolean {
  if (args.some((a) => WRITING_FLAG.test(a))) return false;
  const positional = args.filter((a) => !a.startsWith("-"));
  if (PACKAGE_MANAGERS.has(name)) {
    const script = positional[0] === "run" ? positional[1] : positional[0];
    return script !== undefined && CHECK_SCRIPTS.has(script);
  }
  if (name === "npx" || name === "pnpx" || name === "bunx") {
    const tool = positional[0];
    return tool !== undefined && isCheck(bin(tool), args.slice(args.indexOf(tool) + 1));
  }
  if (name === "python" || name === "python3" || name === "py") {
    return args[0] === "-m" && (args[1] === "pytest" || args[1] === "mypy");
  }
  if (!Object.hasOwn(CHECK_COMMANDS, name)) return false;
  const subs = CHECK_COMMANDS[name];
  if (!subs) return true;
  return positional[0] !== undefined && subs.includes(positional[0]);
}

/** Options of `readOnlyCommandDenial`. */
export interface ReadOnlyCommandOptions {
  /**
   * Also allow the project's checks (`pnpm test`, `tsc --noEmit`, `cargo check`, ...) without
   * fix, write or snapshot-update flags. On for agent sessions with the `read_only` level; off
   * for the orchestrator and PMs.
   */
  allowChecks?: boolean;
}

/** Why a command is refused in a read-only session, or undefined when it may run. */
export function readOnlyCommandDenial(
  command: string,
  options: ReadOnlyCommandOptions = {},
): string | undefined {
  if (/\$\(|`|<\(|>\(/.test(command)) {
    return "Command substitution is not allowed in a read-only session";
  }
  for (const simple of splitCommands(command)) {
    if (redirectsToFile(simple)) return "Writing files is not allowed in a read-only session";
    const { words, expands } = parseShellWords(simple);
    if (expands) {
      return "Variables and $'…' quoting are not allowed in a read-only session; write the value out";
    }
    const name = bin(words[0]?.raw);
    const tokens = words.map((w) => w.text);
    const args = tokens.slice(1).map((a) => a.toLowerCase());
    const grouping = groupingDenial(name, unquoted(simple));
    if (grouping) return grouping;
    // A glob could expand to a file named like an option (`-o…`) that no check saw.
    if (optionSensitive(name) && words.slice(1).some((w) => w.glob && /^[-*?[]/.test(w.text))) {
      return `${name} with an unquoted pattern is not allowed in a read-only session; quote it`;
    }
    if (name === "git") {
      const reason = gitDenial(tokens.slice(1));
      if (reason) return reason;
      continue;
    }
    if (name === "gh") {
      const reason = ghDenial(args);
      if (reason) return reason;
      continue;
    }
    if (name === "sed") {
      const reason = sedDenial(tokens.slice(1));
      if (reason) return reason;
      continue;
    }
    if (options.allowChecks && isCheck(name, args)) continue;
    if (!READ_ONLY_BINS.has(name)) {
      return `${name || "This command"} is not on the read-only allowlist`;
    }
    // Allowlisted programs still write or run things with some options (`sort -o`).
    const writes = writingOptionDenial(name, tokens.slice(1));
    if (writes) return writes;
  }
  return undefined;
}

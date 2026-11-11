import { writesConfig } from "./git";
import { matchesLong, refusedShort } from "./read-only-options";

/**
 * Read-only rules for `git` (§11.2): which subcommands and forms only read. Options that write a
 * file or run a program (`git diff --output=f`, `git grep -O<pager>`) are refused for every
 * subcommand, long options also by the abbreviations git accepts.
 */

/** Git subcommands that never change the repository (in their reading forms). */
const READ_ONLY_GIT = new Set([
  "status",
  "log",
  "show",
  "diff",
  "blame",
  "grep",
  "ls-files",
  "ls-tree",
  "ls-remote",
  "rev-parse",
  "rev-list",
  "describe",
  "shortlog",
  "cat-file",
  "remote",
  "branch",
  "tag",
  "config",
  "reflog",
  "merge-base",
  "name-rev",
  "for-each-ref",
  "show-ref",
  "worktree",
  "stash",
  "check-ignore",
  "check-attr",
  "count-objects",
  "cherry",
  "whatchanged",
  "range-diff",
  "version",
]);

/** Global options that take the next word as their value (`git -C dir log`). */
const GIT_VALUED = new Set(["-C", "--git-dir", "--work-tree", "--namespace"]);
/**
 * `git -c key=value` is allowed only with a plain value: a pager, editor or other command set
 * through it could run anything.
 */
const SAFE_GIT_CONFIG = /^[a-z0-9.-]+=(false|true|cat|never|always|auto|0|1)?$/i;

/** Long options that write a file or run a program, refused with every subcommand. */
const WRITING_LONG = [
  "--output",
  "--ext-diff",
  "--open-files-in-pager",
  "--upload-pack",
  "--receive-pack",
  "--exec",
];

/** `git config` long options that write (abbreviations count). */
const CONFIG_WRITING_LONG = [
  "--unset",
  "--unset-all",
  "--add",
  "--replace-all",
  "--edit",
  "--rename-section",
  "--remove-section",
];

interface RefRules {
  /** Short options that change refs. */
  short: string;
  /** Long options that change refs. */
  long: string[];
  /** Options that make the command list (so names are patterns, not new refs). */
  list: { short: string; long: string[] };
  /** Options whose value is the next word. */
  valued: string[];
}

/** `git branch` and `git tag` create a ref from a bare name; only their listing forms read. */
const REF_RULES: Record<"branch" | "tag", RefRules> = {
  branch: {
    short: "dDmMcCfut",
    long: [
      "--delete",
      "--move",
      "--copy",
      "--force",
      "--set-upstream-to",
      "--set-upstream",
      "--unset-upstream",
      "--edit-description",
      "--track",
      "--no-track",
      "--create-reflog",
      "--recurse-submodules",
    ],
    list: { short: "l", long: ["--list"] },
    valued: [
      "--contains",
      "--no-contains",
      "--merged",
      "--no-merged",
      "--points-at",
      "--sort",
      "--format",
      "--column",
    ],
  },
  tag: {
    short: "dasufmFe",
    long: [
      "--delete",
      "--annotate",
      "--sign",
      "--local-user",
      "--force",
      "--message",
      "--file",
      "--edit",
      "--create-reflog",
      "--cleanup",
      "--trailer",
    ],
    list: { short: "lnv", long: ["--list", "--verify"] },
    valued: [
      "--contains",
      "--no-contains",
      "--merged",
      "--no-merged",
      "--points-at",
      "--sort",
      "--format",
      "--column",
    ],
  },
};

/** Why `git branch|tag <rest>` changes refs, or undefined for its listing forms. */
function refDenial(sub: "branch" | "tag", rest: string[]): string | undefined {
  const rules = REF_RULES[sub];
  let names = 0;
  let listing = false;
  for (let i = 0; i < rest.length; i += 1) {
    const arg = rest[i] as string;
    if (arg.startsWith("--")) {
      if (rules.long.some((long) => matchesLong(arg, long))) {
        return `git ${sub} ${arg.split("=")[0]} changes the repository`;
      }
      if (rules.list.long.some((long) => matchesLong(arg, long))) listing = true;
      if (rules.valued.includes(arg)) i += 1;
    } else if (arg.startsWith("-") && arg !== "-") {
      if (refusedShort(arg, rules.short)) return `git ${sub} ${arg} changes the repository`;
      if ([...arg.slice(1)].some((c) => rules.list.short.includes(c))) listing = true;
    } else names += 1;
  }
  return names > 0 && !listing ? `git ${sub} <name> creates a ${sub}` : undefined;
}

/** Subcommand words of `git remote`, `git worktree` and `git reflog` that only read. */
const READING_SUBCOMMANDS: Record<string, { reads: Set<string>; refAllowed: boolean }> = {
  remote: { reads: new Set(["show", "get-url"]), refAllowed: false },
  worktree: { reads: new Set(["list"]), refAllowed: false },
  // `git reflog <ref>` shows that ref's log.
  reflog: { reads: new Set(["show", "exists", "list"]), refAllowed: true },
};
const REFLOG_WRITES = new Set(["expire", "delete", "drop", "write"]);

/** Why `git <args>` is refused in a read-only session. `args` keep their case. */
export function gitDenial(args: string[]): string | undefined {
  let i = 0;
  for (; i < args.length && args[i]?.startsWith("-"); i += 1) {
    const option = args[i] as string;
    if (GIT_VALUED.has(option)) i += 1;
    else if (option === "-c") {
      if (!SAFE_GIT_CONFIG.test(args[i + 1] ?? "")) {
        return "git -c with this setting is not allowed in a read-only session";
      }
      i += 1;
    } else if (/^--(exec-path|config-env)/.test(option)) {
      return `git ${option} is not allowed in a read-only session`;
    }
  }
  const sub = args[i]?.toLowerCase();
  const rest = args.slice(i + 1);
  if (!sub || !READ_ONLY_GIT.has(sub)) return `git ${sub ?? ""} may change the repository`;
  const writing = rest.find((a) => WRITING_LONG.some((long) => matchesLong(a, long)));
  if (writing) {
    return `git ${sub} ${writing.split("=")[0]} writes a file or runs a program, which is not allowed in a read-only session`;
  }
  if (sub === "grep" && rest.some((a) => !a.startsWith("--") && refusedShort(a, "O", "efABCm"))) {
    return "git grep -O runs a program, which is not allowed in a read-only session";
  }
  if (sub === "branch" || sub === "tag") return refDenial(sub, rest);
  const reading = READING_SUBCOMMANDS[sub];
  if (reading) {
    const word = rest.find((a) => !a.startsWith("-"))?.toLowerCase();
    const known = word === undefined || reading.reads.has(word);
    const ref = reading.refAllowed && word !== undefined && !REFLOG_WRITES.has(word);
    if (!known && !ref) return `git ${sub} ${word} changes the repository`;
    return undefined;
  }
  const lower = rest.map((a) => a.toLowerCase());
  if (sub === "config") {
    const long = rest.find((a) => CONFIG_WRITING_LONG.some((w) => matchesLong(a, w)));
    if (long || writesConfig(lower)) return "Only reading git config is allowed";
  }
  if (sub === "stash" && lower[0] !== "list" && lower[0] !== "show") {
    return "Only git stash list and show are allowed in a read-only session";
  }
  return undefined;
}

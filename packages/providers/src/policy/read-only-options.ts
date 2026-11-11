/**
 * Options that make an otherwise read-only program write files or run other programs
 * (`sort -o out`, `find -fprint out`, `rg --pre cmd`, `uniq in out`). The read-only allowlist
 * (`read-only.ts`) admits these programs only without them. Matching errs on the side of
 * refusing: short options are found inside clusters (`-uo`, `-oout.txt`), long options also by
 * the abbreviations GNU tools accept (`--out=x` for `--output`).
 */

interface Rule {
  /** Short options (case-sensitive letters) that write or run something. */
  short?: string;
  /** Short options that take a value, which may follow in the same word (`-k1,1`). */
  valued?: string;
  /** Long options that write or run something. */
  long?: string[];
  /** Single-dash word options (`find -fprint`), matched whole. */
  words?: string[];
  /** Refuse any `+command` argument (pagers run `+` arguments as their own commands). */
  plusCommands?: boolean;
}

const RULES: Record<string, Rule> = {
  sort: {
    short: "oT",
    valued: "kStT",
    long: ["--output", "--compress-program", "--temporary-directory"],
  },
  // `-R` reruns tree at each level with `-o 00Tree.html`.
  tree: { short: "oR", valued: "LPIHT", long: ["--output"] },
  less: { short: "oO", valued: "bhjkpPtTxyz#", long: ["--log-file"], plusCommands: true },
  more: { plusCommands: true },
  find: {
    words: [
      "-delete",
      "-exec",
      "-execdir",
      "-ok",
      "-okdir",
      "-fprint",
      "-fprint0",
      "-fprintf",
      "-fls",
    ],
  },
  fd: { short: "xX", valued: "deEtjcS", long: ["--exec", "--exec-batch"] },
  rg: { long: ["--pre"] },
  date: { short: "s", valued: "dfIr", long: ["--set"] },
  file: { short: "C", valued: "mfFeP", long: ["--compile"] },
};

/** True when a cluster such as `-uo` holds a short option that `rule` refuses. */
function refusedShort(arg: string, rule: Rule): boolean {
  if (!rule.short || !/^-[A-Za-z]/.test(arg)) return false;
  for (const c of arg.slice(1)) {
    if (rule.short.includes(c)) return true;
    // The rest of the word is this option's value.
    if (rule.valued?.includes(c)) return false;
  }
  return false;
}

/** True when `arg` names `long`, exactly or by an abbreviation (`--out` for `--output`). */
function matchesLong(arg: string, long: string): boolean {
  if (!arg.startsWith("--")) return false;
  const name = (arg.split("=")[0] ?? "").toLowerCase();
  return name.length > 2 && long.startsWith(name);
}

/**
 * `uniq INPUT OUTPUT` writes OUTPUT: refuse a second operand. `-f N`, `-s N` and `-w N` (and
 * their long forms without `=`) take the next word as their value.
 */
function uniqWrites(args: string[]): boolean {
  const valued = new Set(["-f", "-s", "-w", "--skip-fields", "--skip-chars", "--check-chars"]);
  let operands = 0;
  let afterDashes = false;
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i] as string;
    if (!afterDashes && arg === "--") afterDashes = true;
    else if (!afterDashes && arg.startsWith("-") && arg !== "-") {
      if (valued.has(arg)) i += 1;
    } else operands += 1;
  }
  return operands > 1;
}

/** Why `<name> <args>` would write or run something, or undefined. `args` keep their case. */
export function writingOptionDenial(name: string, args: string[]): string | undefined {
  const refused = (what: string) => `${name} ${what} is not allowed in a read-only session`;
  if (name === "uniq") return uniqWrites(args) ? refused("with an output file") : undefined;
  const rule = RULES[name];
  if (!rule) return undefined;
  for (const arg of args) {
    if (arg === "--") break;
    if (rule.plusCommands && arg.startsWith("+")) return refused(arg);
    if (rule.words?.includes(arg.toLowerCase())) return refused(arg);
    if (refusedShort(arg, rule)) return refused(arg);
    if (rule.long?.some((long) => matchesLong(arg, long))) {
      return refused(arg.split("=")[0] ?? arg);
    }
  }
  return undefined;
}

/** The command with its quoted parts blanked out (an unterminated quote runs to the end). */
function unquoted(command: string): string {
  return command.replace(/"(?:[^"\\]|\\.)*"?|'[^']*'?/g, " ");
}

/**
 * Why a simple command groups or runs code beyond its own words: unquoted `( )` (PowerShell
 * runs a command in parentheses, even as an argument of an allowlisted cmdlet) and `{ }`
 * (script blocks; also bash brace expansion). `find` may use escaped `\( \)`; git's `@{u}`
 * revision syntax is fine.
 */
export function groupingDenial(name: string, command: string): string | undefined {
  let bare = unquoted(command);
  if (name === "find") bare = bare.replace(/\\[()]/g, " ");
  if (/[()]/.test(bare)) return "Parentheses are not allowed in a read-only session";
  if (/[{}]/.test(bare.replace(/@\{[\w.:/-]*\}/g, " "))) {
    return "Script blocks and braces are not allowed in a read-only session";
  }
  return undefined;
}

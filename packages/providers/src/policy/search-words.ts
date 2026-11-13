/**
 * Search commands (`grep`, `rg`, `findstr`, `Select-String`, ...) read as the tool reads them, for
 * the risk classifier (§11.2). Each word gets one role, once: an option, an option's value or an
 * operand. The pattern is an option's pattern value, or else the first operand. Because roles are
 * fixed in one pass, a value that looks like an option (`rg -r-e`: replacement text `-e`) is never
 * read as one, and a word that looks like a pattern option is never skipped as a value.
 */

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

/** Tools whose option names are matched in any case (names are kept in lower case). */
const ANY_CASE = new Set(["findstr", "select-string", "sls"]);
/**
 * Tools whose short options combine in one word, the getopt way (`-ne.` is `-n -e .`), and whose
 * `-e` and `-f` take a value. `ag -f` and `ack -f` take none, so their words stay as written.
 */
const CLUSTERING = new Set(["grep", "egrep", "fgrep", "zgrep", "rg"]);
/** Options whose value is the search pattern. */
const PATTERN_OPTIONS = ["-e", "--regexp", "-pattern", "/c"];
/** Options that give the pattern another way, a pattern file: then no operand is the pattern. */
const isPatternFile = (name: string) => name === "-f" || name.startsWith("--file") || name === "/g";

/** True when the option `name` takes the next word as its value. */
function takesValue(bin: string, name: string): boolean {
  if (["-e", "--regexp", "-pattern", "-f", "--file"].includes(name)) return true;
  if (bin === "rg") return RG_VALUED.includes(name);
  if (bin === "select-string" || bin === "sls") return SELECT_STRING_VALUED.includes(name);
  return GREP_VALUED.includes(name);
}

/** One word of a search command, as the tool reads it. */
export interface SearchWord {
  /** The text: an option (`-n`, `--glob=x`, `-Path:x`), an option's value, or an operand. */
  text: string;
  role: "option" | "value" | "operand";
  /** An option's name (`--glob` for `--glob=x`), or the option a value belongs to. */
  option?: string;
  /**
   * The argument the text comes from and where in it the text starts (`-fFILE`: the value starts
   * at 2). `arg` is -1 for an option taken out of a cluster (`-n` in `-ne.`), which is no path.
   */
  arg: number;
  from: number;
  /** True for a word the tool searches for rather than in. */
  pattern: boolean;
}

/** An option word's value bound with `=` or `:` (`--glob=x`, `-Path:x`, `/c:x`). */
const BOUND = /^(--?[A-Za-z][\w-]*|\/[A-Za-z])[=:]/;

/** Parse a search command's arguments (after the program name) into roles. */
export function parseSearch(bin: string, args: string[]): SearchWord[] {
  const words: SearchWord[] = [];
  const add = (text: string, role: SearchWord["role"], arg: number, from = 0, option?: string) =>
    words.push({ text, role, option, arg, from, pattern: false });
  const fold = (name: string) => (ANY_CASE.has(bin) ? name.toLowerCase() : name);
  const isOption = (a: string) => a.startsWith("-") || (bin === "findstr" && a.startsWith("/"));
  let operandsOnly = false;
  for (let i = 0; i < args.length; i += 1) {
    const a = args[i] as string;
    if (operandsOnly || !isOption(a)) {
      add(a, "operand", i);
    } else if (a === "--") {
      operandsOnly = true;
      add(a, "option", i, 0, a);
    } else if (CLUSTERING.has(bin) && /^-[^-]./.test(a)) {
      // Short options in one word: an option that takes a value takes the rest of the word,
      // or the next word when it ends the cluster (`-ne.`, `-fFILE`, `-r-e`).
      for (let j = 1; j < a.length; j += 1) {
        const flag = `-${a[j]}`;
        add(flag, "option", -1, 0, flag);
        if (!takesValue(bin, flag)) continue;
        if (j + 1 < a.length) add(a.slice(j + 1), "value", i, j + 1, flag);
        else if (i + 1 < args.length) add(args[++i] as string, "value", i, 0, flag);
        break;
      }
    } else {
      const bound = BOUND.exec(a);
      const name = fold(bound?.[1] ?? a);
      add(a, "option", i, 0, name);
      if (!bound && takesValue(bin, name) && i + 1 < args.length) {
        add(args[++i] as string, "value", i, 0, name);
      }
    }
  }
  markPatterns(words);
  return words;
}

/**
 * Mark the pattern words: the values of `-e`, `--regexp`, `-Pattern` and `findstr /c:`, or, when
 * no option gives the pattern (nor a pattern file, `-f`), the first operand.
 */
function markPatterns(words: SearchWord[]): void {
  let explicit = false;
  for (const w of words) {
    const name = w.option ?? "";
    if (w.role === "value" && PATTERN_OPTIONS.includes(name)) {
      w.pattern = true;
      explicit = true;
    } else if (w.role === "option" && PATTERN_OPTIONS.includes(name)) {
      explicit = true;
      // `--regexp=x`, `-Pattern:x`, `/c:x`: the option word holds the pattern.
      if (w.text.length > name.length) w.pattern = true;
    } else if (w.role === "option" && isPatternFile(name)) explicit = true;
  }
  if (explicit) return;
  const first = words.find((w) => w.role === "operand");
  if (first) first.pattern = true;
}

/** The file operands of a parsed search (`grep -r -e x src lib` -> `src`, `lib`). */
export function searchOperands(words: SearchWord[]): SearchWord[] {
  return words.filter((w) => w.role === "operand" && !w.pattern);
}

/** The values given to the named options: `name X`, `name=X`, or in a cluster (`-gX`). */
export function searchOptionValues(words: SearchWord[], names: string[]): string[] {
  return words.flatMap((w) => {
    if (!w.option || !names.includes(w.option)) return [];
    if (w.role === "value") return [w.text];
    return w.role === "option" && w.text.length > w.option.length
      ? [w.text.slice(w.option.length + 1)]
      : [];
  });
}

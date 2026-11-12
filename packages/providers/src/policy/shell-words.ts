/**
 * Shell words as a POSIX shell hands them to a program, for the read-only allowlist: quotes
 * removed and concatenated (`-'o'` and `"-"o` are both `-o`), backslash escapes applied. Where
 * the words cannot be known from the text alone, the parse says so and the allowlist refuses the
 * command: variable expansion and `$'…'` quoting, and globs that might expand to an option.
 */

/** One word of a simple command. */
export interface ShellWord {
  /** The word the program receives (POSIX quoting and escapes applied). */
  text: string;
  /** The word with its quotes removed but backslashes kept, for program names (`C:\bin\rg`). */
  raw: string;
  /** An unquoted glob character (`*`, `?`, `[`) appears: the shell may expand the word. */
  glob: boolean;
}

export interface ParsedCommand {
  words: ShellWord[];
  /** `$` starts an expansion or `$'…'`/`$"…"` quoting outside single quotes. */
  expands: boolean;
}

/** True when the `$` at `i` expands something (PowerShell's `$null` is a plain value). */
function expandsAt(command: string, i: number): boolean {
  if (/^\$null\b/i.test(command.slice(i))) return false;
  return /[A-Za-z_0-9{('"!@#*?$-]/.test(command[i + 1] ?? "");
}

/** Characters a backslash escapes inside double quotes. */
const DOUBLE_ESCAPES = '$`"\\\n';

/** Split one simple command into shell words. */
export function parseShellWords(command: string): ParsedCommand {
  const words: ShellWord[] = [];
  let expands = false;
  let text = "";
  let raw = "";
  let glob = false;
  let inWord = false;
  const end = () => {
    if (inWord) words.push({ text, raw, glob });
    text = "";
    raw = "";
    glob = false;
    inWord = false;
  };
  let i = 0;
  while (i < command.length) {
    const c = command[i] as string;
    if (/\s/.test(c)) {
      end();
      i += 1;
      continue;
    }
    inWord = true;
    if (c === "'") {
      const close = command.indexOf("'", i + 1);
      const stop = close < 0 ? command.length : close;
      text += command.slice(i + 1, stop);
      raw += command.slice(i + 1, stop);
      i = stop + 1;
    } else if (c === '"') {
      i += 1;
      while (i < command.length && command[i] !== '"') {
        const d = command[i] as string;
        const next = command[i + 1];
        if (d === "\\" && next !== undefined && DOUBLE_ESCAPES.includes(next)) {
          text += next;
          raw += d + next;
          i += 2;
          continue;
        }
        if (d === "$" && expandsAt(command, i)) expands = true;
        text += d;
        raw += d;
        i += 1;
      }
      i += 1;
    } else if (c === "\\") {
      const next = command[i + 1] ?? "";
      text += next;
      raw += c + next;
      i += 2;
    } else {
      if (c === "$" && expandsAt(command, i)) expands = true;
      if (c === "*" || c === "?" || c === "[") glob = true;
      text += c;
      raw += c;
      i += 1;
    }
  }
  end();
  return { words, expands };
}

/** The command with its quoted parts blanked out (an unterminated quote runs to the end). */
export function unquoted(command: string): string {
  return command.replace(/"(?:[^"\\]|\\.)*"?|'[^']*'?/g, " ");
}

/**
 * True when a simple command redirects output into a file. Redirections to another stream
 * (`2>&1`) or to the null device (`/dev/null`, `nul`, PowerShell's `$null`) are fine; `&>`,
 * `>|` and `<>` count as writes.
 */
export function redirectsToFile(command: string): boolean {
  const bare = unquoted(command);
  for (const m of bare.matchAll(/(?:\d+|&)?(?:<>|>>?\|?)\s*(\S*)/g)) {
    const target = m[1] ?? "";
    if (/^&\d$/.test(target) || /^(\/dev\/null|nul|\$null)$/i.test(target)) continue;
    return true;
  }
  return false;
}

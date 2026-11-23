import { assignsAt, itemsIn, variableItem } from "./ps-variables";

/**
 * A small shell lexer for the risk classifier (§11.2). It splits a command line into simple
 * commands the way a shell would, so quoted text, heredoc bodies and PowerShell here-strings
 * stay data instead of being read as commands, and output redirections are only found
 * outside quotes. It covers POSIX shells and PowerShell well enough to classify commands;
 * it is not a full parser.
 */

import { dropAssignments } from "./ps-assignments";

/** Which quoting rules to apply. `auto` is for callers that cannot tell the shell. */
export type ShellDialect = "posix" | "powershell" | "auto";

/** One simple command, such as `git commit -m msg` or `pnpm build > log`. */
export interface SimpleCommand {
  /** Words with quotes removed. Substitutions such as `$(pwd)` stay as written. */
  words: string[];
  /**
   * Output redirection targets (`> f`, `>> f`, `2> f`, `&> f`, `*> f`), and the items a PowerShell
   * variable on a drive assigns (`${C:\x} = …`, `./ps-variables`).
   */
  writes: string[];
  /**
   * Items a PowerShell variable on a drive reads (`${C:\Users\me\.ssh\id_rsa}` as a value, or
   * inside a double-quoted string or `@"…"@` here-string; `./ps-variables`).
   */
  reads?: string[];
  /** Command lists inside substitutions and subshells (`$(…)`, `(…)`, `<(…)`), in order. */
  nested: SimpleCommand[][];
  /** Here-string words (`<<< text`), which the command reads on its input. */
  input?: string[];
  /** True when the command reads the output of the one before it (`a | b`, `a |& b`). */
  piped?: boolean;
  /**
   * PowerShell list arguments (`a,b`: unquoted commas, outside POSIX shells), each word with the
   * positions of its unquoted commas. A comma inside quotes or escaped is part of the name.
   */
  lists?: Map<string, number[]>;
  /**
   * True when the words are the right-hand side of a PowerShell assignment (`$p = '.env'`,
   * `$r = Remove-Item …`), whose target `./ps-assignments` dropped.
   */
  assigned?: boolean;
}

/** What a word may stand for as paths, from `from` on (after an attached option, `-fFILE`). */
export type WordPaths = (word: string, from: number) => string[];

/**
 * The paths a word of `cmd` may stand for, from `from` on: its text and, for a PowerShell list
 * (`a,b`), each element. The whole text stays: when the shell is unknown it may be one name, or a
 * brace expansion (`{a,b}`). Callers apply it after reading the word's role, so a list given as a
 * search pattern stays data.
 */
export function wordPaths(cmd: SimpleCommand, word: string, from = 0): string[] {
  const text = word.slice(from);
  const commas = cmd.lists?.get(word)?.filter((at) => at >= from) ?? [];
  if (!commas.length) return [text];
  const bounds = [from - 1, ...commas, word.length];
  const elements = bounds.slice(1).map((end, k) => word.slice((bounds[k] as number) + 1, end));
  return [text, ...elements.filter(Boolean)];
}

/** Parse a command line into its simple commands. */
export function parseShell(src: string, dialect: ShellDialect = "auto"): SimpleCommand[] {
  return new Lexer(src, dialect).list(null);
}

/** Placeholder for heredoc and here-string bodies, which are data, never commands. */
const BODY = "<body>";

/**
 * When the shell is unknown, a `${…}` that may be a PowerShell drive item: up to the first `}`,
 * with no `$`, backtick or line break in its name (bash's `${x:-$(cmd)}` runs a command instead).
 */
const BRACED_NAME = /\$\{([^}`$\n\r]*)\}/y;

type Target = "word" | "write" | "heredoc" | "skip";

/** The command being built and the word being read. */
class Builder {
  cmd: SimpleCommand = { words: [], writes: [], nested: [] };
  word = "";
  inWord = false;
  /** Where the current word goes: an argument, a redirect target or a heredoc delimiter. */
  target: Target = "word";
  heredocStrip = false;
  readonly heredocs: Array<{ delim: string; strip: boolean }> = [];
  /** Where the word's unquoted commas are: a PowerShell list's element boundaries. */
  private commas: number[] = [];

  constructor(
    private readonly out: SimpleCommand[],
    private readonly dialect: ShellDialect,
  ) {}

  /** Note an item a PowerShell variable reads. */
  read(item: string): void {
    this.cmd.reads = [...(this.cmd.reads ?? []), item];
  }

  add(text: string): void {
    this.word += text;
    this.inWord = true;
  }

  /** An unquoted comma, which separates a PowerShell list's elements (`a,b`). */
  addComma(): void {
    this.commas.push(this.word.length);
    this.add(",");
  }

  endWord(): void {
    if (!this.inWord) return;
    if (this.target === "write") this.cmd.writes.push(this.word);
    else if (this.target === "heredoc") {
      // `<<\EOF` and `<<'EOF'` both end at a line reading `EOF`.
      this.heredocs.push({ delim: this.word.replace(/\\/g, ""), strip: this.heredocStrip });
    } else if (this.target === "word") {
      this.cmd.words.push(this.word);
      if (this.commas.length) this.addList();
    } else if (this.target === "skip") this.cmd.input = [...(this.cmd.input ?? []), this.word];
    this.target = "word";
    this.word = "";
    this.inWord = false;
    this.commas = [];
  }

  /**
   * Note where the current word's unquoted commas are. The same text written twice with different
   * quoting keeps every comma either one had, so its list is never missed.
   */
  private addList(): void {
    this.cmd.lists ??= new Map();
    const seen = this.cmd.lists.get(this.word) ?? [];
    const commas = [...new Set([...seen, ...this.commas])].sort((a, b) => a - b);
    this.cmd.lists.set(this.word, commas);
  }

  endCommand(): void {
    this.endWord();
    this.target = "word";
    const { cmd } = this;
    // PowerShell runs the right-hand side of `$r = Remove-Item …`: judge it as if it stood alone.
    if (this.dialect !== "posix") dropAssignments(cmd);
    // An empty command keeps its state, so `curl … |` then `sh` on the next line stays piped (and
    // `$x =` then a command on the next line assigns that command, as in PowerShell).
    if (!cmd.words.length && !cmd.writes.length && !cmd.nested.length) return;
    this.out.push(cmd);
    this.cmd = { words: [], writes: [], nested: [] };
  }
}

class Lexer {
  private i = 0;

  constructor(
    private readonly src: string,
    private readonly dialect: ShellDialect,
  ) {}

  /** Read simple commands until `closer` (`)` or a backtick) or the end of the input. */
  list(closer: ")" | "`" | null): SimpleCommand[] {
    const out: SimpleCommand[] = [];
    const b = new Builder(out, this.dialect);
    const { src } = this;
    while (this.i < src.length) {
      const c = src[this.i] as string;
      const next = src[this.i + 1];
      if (closer && c === closer) {
        this.i += 1;
        b.endCommand();
        return out;
      }
      if (c === "\n" || c === "\r") {
        b.endCommand();
        this.i += c === "\r" && next === "\n" ? 2 : 1;
        this.skipHeredocs(b.heredocs.splice(0));
      } else if (c === " " || c === "\t") {
        b.endWord();
        this.i += 1;
      } else if (c === "#" && !b.inWord) {
        while (this.i < src.length && src[this.i] !== "\n" && src[this.i] !== "\r") this.i += 1;
      } else if (c === ";") {
        b.endCommand();
        this.i += 1;
      } else if (c === "|") {
        b.endCommand();
        // `||` runs the next command on failure; `|` and `|&` pipe into it.
        if (next !== "|") b.cmd.piped = true;
        this.i += next === "|" || next === "&" ? 2 : 1;
      } else if (c === "&" && next === ">") {
        b.endWord();
        b.target = "write";
        this.i += src[this.i + 2] === ">" ? 3 : 2;
      } else if (c === "&") {
        b.endCommand();
        this.i += next === "&" ? 2 : 1;
      } else if (c === ">" || c === "<") {
        this.redirect(b, c);
      } else if (c === "'" || c === '"') {
        if (b.inWord && b.word.endsWith("@") && this.lineEndsAt(this.i + 1)) {
          const body = this.skipHereString(c);
          // `@"…"@` expands its variables; `@'…'@` doesn't.
          if (c === '"' && this.dialect !== "posix") {
            for (const item of itemsIn(body, this.dialect === "auto")) b.read(item);
          }
          b.add(BODY);
        } else if (c === "'") {
          b.add(this.readSingle());
        } else {
          b.add(this.readDouble(b));
        }
      } else if (c === "\\" && this.dialect !== "powershell") {
        // POSIX escape: the next character is literal (a newline continues the line). The
        // backslash is kept so Windows paths keep their separators.
        if (next === "\n" || next === "\r") {
          this.i += next === "\r" && src[this.i + 2] === "\n" ? 3 : 2;
        } else {
          b.add(src.slice(this.i, this.i + 2));
          this.i += 2;
        }
      } else if (c === "`") {
        this.backtick(b);
      } else if (c === "(") {
        const start = this.i;
        this.i += 1;
        b.cmd.nested.push(this.list(")"));
        b.add(src.slice(start, this.i));
      } else if (c === "," && this.dialect !== "posix") {
        // PowerShell passes `a,b` as a list of two paths; a POSIX shell, as one name.
        b.addComma();
        this.i += 1;
      } else if (c === "$" && next === "{" && this.dialect !== "posix") {
        b.add(this.braced(b, false));
      } else {
        b.add(c);
        this.i += 1;
      }
    }
    b.endCommand();
    return out;
  }

  /** `>`, `>>`, `>|`, `2>`, `*>`, `2>&1`, `<`, `<<EOF`, `<<-EOF`, `<<<`, `<(…)`, `>(…)`. */
  private redirect(b: Builder, c: ">" | "<"): void {
    const { src } = this;
    // A file descriptor written right before the operator (`2>`, `*>`) is not a word.
    if (b.inWord && /^(\d+|\*)$/.test(b.word)) {
      b.word = "";
      b.inWord = false;
    } else b.endWord();
    const next = src[this.i + 1];
    if (next === "(") {
      const start = this.i;
      this.i += 2;
      b.cmd.nested.push(this.list(")"));
      b.add(src.slice(start, this.i));
      return;
    }
    if (c === "<") {
      if (next === "<" && src[this.i + 2] === "<") {
        b.target = "skip";
        this.i += 3;
      } else if (next === "<") {
        this.i += 2;
        b.heredocStrip = src[this.i] === "-";
        if (b.heredocStrip) this.i += 1;
        b.target = "heredoc";
      } else {
        // Input redirect: the file stays an argument, so secrets checks still see it.
        this.i += 1;
      }
      return;
    }
    let j = this.i + 1;
    if (src[j] === ">") j += 1;
    if (src[j] === "|") j += 1;
    if (src[j] === "&") {
      const dup = /^&(\d+|-)/.exec(src.slice(j));
      if (dup) {
        this.i = j + dup[0].length;
        return;
      }
      j += 1;
    }
    b.target = "write";
    this.i = j;
  }

  /**
   * PowerShell escapes the next character; POSIX starts a command substitution. (A closing
   * backtick never gets here: `list` checks for its closer first.)
   */
  private backtick(b: Builder): void {
    const { src } = this;
    const next = src[this.i + 1];
    const escapes =
      this.dialect === "powershell" ||
      (this.dialect === "auto" && (next === undefined || /\s/.test(next)));
    if (escapes) {
      if (next === "\n" || next === "\r") {
        this.i += next === "\r" && src[this.i + 2] === "\n" ? 3 : 2;
      } else {
        b.add(src.slice(this.i + 1, this.i + 2));
        this.i += 2;
      }
      return;
    }
    const start = this.i;
    this.i += 1;
    b.cmd.nested.push(this.list("`"));
    b.add(src.slice(start, this.i));
  }

  private readSingle(): string {
    const end = this.src.indexOf("'", this.i + 1);
    const stop = end === -1 ? this.src.length : end;
    const text = this.src.slice(this.i + 1, stop);
    this.i = stop + 1;
    return text;
  }

  /** A double-quoted string: escapes, and `$(…)` substitutions run as nested commands. */
  private readDouble(b: Builder): string {
    const { src } = this;
    let text = "";
    this.i += 1;
    while (this.i < src.length) {
      const c = src[this.i] as string;
      const next = src[this.i + 1];
      if (c === '"') {
        this.i += 1;
        return text;
      }
      if (c === "\\" && this.dialect !== "powershell" && next && '"\\$`\n'.includes(next)) {
        text += next;
        this.i += 2;
      } else if (c === "`" && this.dialect !== "posix" && next !== undefined) {
        text += next;
        this.i += 2;
      } else if (c === "`") {
        const start = this.i;
        this.i += 1;
        b.cmd.nested.push(this.list("`"));
        text += src.slice(start, this.i);
      } else if (c === "$" && next === "(") {
        const start = this.i;
        this.i += 2;
        b.cmd.nested.push(this.list(")"));
        text += src.slice(start, this.i);
      } else if (c === "$" && next === "{" && this.dialect !== "posix") {
        text += this.braced(b, true);
      } else {
        text += c;
        this.i += 1;
      }
    }
    return text;
  }

  /**
   * `${…}` at `this.i`. In PowerShell it is one variable, read whole: the name may hold spaces and
   * ends at the first `}` a backtick doesn't escape. When the shell is unknown (`auto`) it may be
   * bash's `${x:-$(cmd)}`, whose `$(…)` and backticks run commands, so only the `$` is taken here
   * and the rest is lexed as usual; the item it names is found by looking ahead. The text taken.
   */
  private braced(b: Builder, quoted: boolean): string {
    const { src } = this;
    const start = this.i;
    if (this.dialect !== "powershell") {
      BRACED_NAME.lastIndex = start;
      const m = BRACED_NAME.exec(src);
      if (m) this.noteItem(b, variableItem(m[1] as string, true), quoted, start + m[0].length);
      this.i += 1;
      return "$";
    }
    let j = start + 2;
    while (j < src.length && src[j] !== "}") j += src[j] === "`" ? 2 : 1;
    this.i = Math.min(j + 1, src.length);
    this.noteItem(b, variableItem(src.slice(start + 2, Math.min(j, src.length))), quoted, this.i);
    return src.slice(start, this.i);
  }

  /**
   * Note the item a PowerShell variable on a drive names (`${C:\x}`, `./ps-variables`): written
   * when an assignment operator follows it (at `after`), and read unless it is only the target of
   * an assignment that starts the command (`${C:\x} = …`, `[string]${C:\x} = …`). `quoted`: inside
   * a double-quoted string, where it is always read.
   */
  private noteItem(b: Builder, item: string | undefined, quoted: boolean, after: number): void {
    if (item === undefined) return;
    const assigns = !quoted && assignsAt(this.src, after);
    const target = assigns && !b.cmd.words.length && /^(?:\[[^\]]*\])*$/.test(b.word);
    if (assigns) b.cmd.writes.push(item);
    if (!target) b.read(item);
  }

  /** True when only spaces or tabs remain before the end of the line at `j`. */
  private lineEndsAt(j: number): boolean {
    const rest = /^[ \t]*(\r?\n|$)/.exec(this.src.slice(j));
    return rest !== null;
  }

  /** Skip a PowerShell here-string (`@'` … `'@`) whose opening quote is at `this.i`; its body. */
  private skipHereString(quote: "'" | '"'): string {
    const close = new RegExp(`(^|\\n)${quote}@`, "g");
    const from = this.i + 1;
    close.lastIndex = from;
    const m = close.exec(this.src);
    this.i = m ? m.index + m[0].length : this.src.length;
    return this.src.slice(from, m ? m.index : this.src.length);
  }

  /** Skip the bodies of heredocs opened on the line that just ended. */
  private skipHeredocs(pending: Array<{ delim: string; strip: boolean }>): void {
    const { src } = this;
    for (const { delim, strip } of pending) {
      while (this.i < src.length) {
        const nl = src.indexOf("\n", this.i);
        const end = nl === -1 ? src.length : nl;
        let line = src.slice(this.i, end).replace(/\r$/, "");
        if (strip) line = line.replace(/^\t+/, "");
        this.i = nl === -1 ? src.length : nl + 1;
        if (line === delim) break;
      }
    }
  }
}

/**
 * A small shell lexer for the risk classifier (§11.2). It splits a command line into simple
 * commands the way a shell would, so quoted text, heredoc bodies and PowerShell here-strings
 * stay data instead of being read as commands, and output redirections are only found
 * outside quotes. It covers POSIX shells and PowerShell well enough to classify commands;
 * it is not a full parser.
 */

/** Which quoting rules to apply. `auto` is for callers that cannot tell the shell. */
export type ShellDialect = "posix" | "powershell" | "auto";

/** One simple command, such as `git commit -m msg` or `pnpm build > log`. */
export interface SimpleCommand {
  /** Words with quotes removed. Substitutions such as `$(pwd)` stay as written. */
  words: string[];
  /** Output redirection targets (`> f`, `>> f`, `2> f`, `&> f`, `*> f`). */
  writes: string[];
  /** Command lists inside substitutions and subshells (`$(…)`, `(…)`, `<(…)`), in order. */
  nested: SimpleCommand[][];
  /** Here-string words (`<<< text`), which the command reads on its input. */
  input?: string[];
  /** True when the command reads the output of the one before it (`a | b`, `a |& b`). */
  piped?: boolean;
}

/** Parse a command line into its simple commands. */
export function parseShell(src: string, dialect: ShellDialect = "auto"): SimpleCommand[] {
  return new Lexer(src, dialect).list(null);
}

/** Placeholder for heredoc and here-string bodies, which are data, never commands. */
const BODY = "<body>";

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

  constructor(private readonly out: SimpleCommand[]) {}

  add(text: string): void {
    this.word += text;
    this.inWord = true;
  }

  endWord(): void {
    if (!this.inWord) return;
    if (this.target === "write") this.cmd.writes.push(this.word);
    else if (this.target === "heredoc") {
      // `<<\EOF` and `<<'EOF'` both end at a line reading `EOF`.
      this.heredocs.push({ delim: this.word.replace(/\\/g, ""), strip: this.heredocStrip });
    } else if (this.target === "word") this.cmd.words.push(this.word);
    else if (this.target === "skip") this.cmd.input = [...(this.cmd.input ?? []), this.word];
    this.target = "word";
    this.word = "";
    this.inWord = false;
  }

  endCommand(): void {
    this.endWord();
    this.target = "word";
    const { cmd } = this;
    // An empty command keeps its state, so `curl … |` then `sh` on the next line stays piped.
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
    const b = new Builder(out);
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
          this.skipHereString(c);
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
      } else {
        text += c;
        this.i += 1;
      }
    }
    return text;
  }

  /** True when only spaces or tabs remain before the end of the line at `j`. */
  private lineEndsAt(j: number): boolean {
    const rest = /^[ \t]*(\r?\n|$)/.exec(this.src.slice(j));
    return rest !== null;
  }

  /** Skip a PowerShell here-string (`@'` … `'@`) whose opening quote is at `this.i`. */
  private skipHereString(quote: "'" | '"'): void {
    const close = new RegExp(`(^|\\n)${quote}@`, "g");
    close.lastIndex = this.i + 1;
    const m = close.exec(this.src);
    this.i = m ? m.index + m[0].length : this.src.length;
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

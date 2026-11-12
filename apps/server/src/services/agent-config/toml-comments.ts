/**
 * TOML comments (§12.4 skill switches): finding them outside strings, so an edit of
 * `config.toml` can keep every comment, or be refused when it can't.
 */

/** A comment found in a text: where it starts, and its text (`#` to the end of the line). */
export interface TomlComment {
  start: number;
  text: string;
}

/** End offset (exclusive) of a multi-line string whose body starts at `at`. */
function skipMultiline(text: string, at: number, quote: '"""' | "'''"): number {
  let i = at;
  while (i < text.length) {
    if (quote === '"""' && text[i] === "\\") {
      i += 2;
      continue;
    }
    if (text.startsWith(quote, i)) {
      let end = i + 3;
      // Up to two quotes of the content may sit right before the closing delimiter.
      while (end < text.length && end < i + 5 && text[end] === quote[0]) end++;
      return end;
    }
    i++;
  }
  return text.length;
}

/** End offset (exclusive) of a one-line string starting at the quote at `at`. */
function skipString(text: string, at: number): number {
  const quote = text[at];
  let i = at + 1;
  while (i < text.length && text[i] !== "\n") {
    if (quote === '"' && text[i] === "\\") {
      i += 2;
      continue;
    }
    if (text[i] === quote) return i + 1;
    i++;
  }
  return i;
}

/**
 * Every comment in a TOML text, whole-line or after a value, in order. A `#` inside a basic,
 * literal or multi-line string is not a comment.
 */
export function tomlComments(text: string): TomlComment[] {
  const out: TomlComment[] = [];
  let i = 0;
  while (i < text.length) {
    if (text.startsWith('"""', i)) i = skipMultiline(text, i + 3, '"""');
    else if (text.startsWith("'''", i)) i = skipMultiline(text, i + 3, "'''");
    else if (text[i] === '"' || text[i] === "'") i = skipString(text, i);
    else if (text[i] === "#") {
      const newline = text.indexOf("\n", i);
      const end = newline < 0 ? text.length : newline;
      out.push({ start: i, text: text.slice(i, end).replace(/\r$/, "").trimEnd() });
      i = end;
    } else i++;
  }
  return out;
}

/** The comment that ends one line, if any (the line read on its own). */
export function lineComment(line: string): string | null {
  return tomlComments(line).at(-1)?.text ?? null;
}

/** True when both texts hold the same comments, each as often (order and position aside). */
export function sameComments(before: string, after: string): boolean {
  const list = (text: string) =>
    tomlComments(text)
      .map((c) => c.text)
      .sort();
  const a = list(before);
  const b = list(after);
  return a.length === b.length && a.every((c, i) => c === b[i]);
}

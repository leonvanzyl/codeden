/**
 * Shell wildcards over `/`-separated paths: `*`, `?`, `[...]`, and `**`, which before a slash
 * stands for zero or more folders. The policy uses them to tell whether a path pattern or a
 * search's name filter reaches CodeDen's own credential files (§11.2).
 */

/** True when a path holds a wildcard. */
export const WILDCARD = /[*?[]/;

type Token =
  | { kind: "char"; char: string }
  /** `?`: one character, never `/`. */
  | { kind: "one" }
  /** `[...]`, as a regular expression character class body. */
  | { kind: "class"; body: string }
  /** `*`: any text without `/`. */
  | { kind: "star" }
  /** `**` not before a slash: any text. */
  | { kind: "any" }
  /** `**` and the slash after it: zero or more folders. */
  | { kind: "folders" };

/** The pattern's tokens; its first `literal` characters are plain characters, whatever they are. */
function tokens(pattern: string, literal = 0): Token[] {
  const out: Token[] = [...pattern.slice(0, literal)].map((char) => ({ kind: "char", char }));
  for (let i = literal; i < pattern.length; i += 1) {
    const c = pattern[i] as string;
    if (c === "*" && pattern[i + 1] === "*") {
      const folders = pattern[i + 2] === "/";
      out.push({ kind: folders ? "folders" : "any" });
      i += folders ? 2 : 1;
    } else if (c === "*") {
      out.push({ kind: "star" });
    } else if (c === "?") {
      out.push({ kind: "one" });
    } else if (c === "[" && pattern.indexOf("]", i + 2) > 0) {
      const end = pattern.indexOf("]", i + 2);
      const body = pattern
        .slice(i + 1, end)
        .replace(/^!/, "^")
        .replace(/\\/g, "\\\\");
      out.push({ kind: "class", body });
      i = end;
    } else {
      out.push({ kind: "char", char: c });
    }
  }
  return out;
}

/** `c` matched as itself in a regular expression. */
const literalChar = (c: string) => c.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

function source(t: Token): string {
  switch (t.kind) {
    case "char":
      return literalChar(t.char);
    case "one":
      return "[^/]";
    case "class":
      return `[${t.body}]`;
    case "star":
      return "[^/]*";
    case "any":
      return ".*";
    case "folders":
      return "(?:.*/)?";
  }
}

/**
 * A wildcard over a `/`-separated path as a regular expression. Its first `literal` characters
 * match as themselves. Undefined when malformed.
 */
export function wildcardPattern(
  pattern: string,
  ignoreCase: boolean,
  literal = 0,
): RegExp | undefined {
  try {
    const body = tokens(pattern, literal).map(source).join("");
    return new RegExp(`^${body}$`, ignoreCase ? "i" : "");
  } catch {
    return undefined;
  }
}

const DIGITS = [..."0123456789"];

/**
 * True when `pattern` matches `prefix` followed by some run of digits: whether a wildcard reaches
 * any of a numbered family of files, such as the copies CodeDen keeps of a damaged file
 * (`remote-access.json.invalid-<timestamp>`). The pattern runs as a small automaton: over
 * `prefix`, then over digits until no new state turns up. The pattern's first `literal`
 * characters match as themselves. Undefined when it is malformed.
 */
export function wildcardMatchesNumbered(
  pattern: string,
  prefix: string,
  ignoreCase: boolean,
  literal = 0,
): boolean | undefined {
  const toks = tokens(pattern, literal);
  const classes = new Map<number, RegExp>();
  try {
    toks.forEach((t, i) => {
      if (t.kind === "class") classes.set(i, new RegExp(`^[${t.body}]$`, ignoreCase ? "i" : ""));
    });
  } catch {
    return undefined;
  }
  const same = (a: string, b: string) =>
    ignoreCase ? a.toLowerCase() === b.toLowerCase() : a === b;
  // State 2i: before token i. State 2i+1: inside the `**/` at token i, before its closing slash.
  // State 2n: the whole pattern matched.
  const closure = (states: Set<number>) => {
    for (const s of states) {
      const t = toks[s / 2];
      if (s % 2 === 0 && (t?.kind === "star" || t?.kind === "any" || t?.kind === "folders")) {
        states.add(s + 2);
      }
    }
    return states;
  };
  const step = (states: Iterable<number>, ch: string) => {
    const next = new Set<number>();
    for (const s of states) {
      if (s % 2 === 1) {
        next.add(s);
        if (ch === "/") next.add(s + 1);
        continue;
      }
      const t = toks[s / 2];
      switch (t?.kind) {
        case "char":
          if (same(t.char, ch)) next.add(s + 2);
          break;
        case "one":
          if (ch !== "/") next.add(s + 2);
          break;
        case "class":
          if (classes.get(s / 2)?.test(ch)) next.add(s + 2);
          break;
        case "star":
          if (ch !== "/") next.add(s);
          break;
        case "any":
          next.add(s);
          break;
        case "folders":
          next.add(s + 1);
          if (ch === "/") next.add(s + 2);
          break;
      }
    }
    return closure(next);
  };
  let states = closure(new Set([0]));
  for (const ch of prefix) {
    states = step(states, ch);
    if (states.size === 0) return false;
  }
  // Every state some run of one or more digits leads to.
  const seen = new Set<number>();
  let frontier: Set<number> = states;
  while (frontier.size > 0) {
    const found = new Set<number>();
    for (const d of DIGITS) {
      for (const s of step(frontier, d)) {
        if (!seen.has(s)) found.add(s);
      }
    }
    for (const s of found) seen.add(s);
    frontier = found;
  }
  return seen.has(2 * toks.length);
}

/**
 * Replace one top-level member of a JSON document in its text, leaving every other byte as it
 * was (other settings, key order, indentation, line endings, trailing newline). Used to edit the
 * `hooks` key of Claude Code's settings files in place (§12.4). The text must be valid JSON
 * with an object at the top; callers parse it first.
 */

interface Member {
  key: string;
  /** Offset of the opening quote of the key. */
  keyStart: number;
  /** Offset just after the closing quote of the key. */
  keyEnd: number;
  valueStart: number;
  valueEnd: number;
}

interface TopLevel {
  /** Offset of the top-level `{`. */
  open: number;
  /** Offset of the top-level `}`. */
  close: number;
  members: Member[];
}

const isSpace = (ch: string | undefined) =>
  ch === " " || ch === "\t" || ch === "\n" || ch === "\r" || ch === "﻿";

function skipSpace(text: string, at: number): number {
  let i = at;
  while (i < text.length && isSpace(text[i])) i++;
  return i;
}

/** End offset (exclusive) of the string starting at `at` (an opening quote). */
function skipString(text: string, at: number): number {
  let i = at + 1;
  while (i < text.length) {
    const ch = text[i];
    if (ch === "\\") i += 2;
    else if (ch === '"') return i + 1;
    else i++;
  }
  throw new Error("Unterminated string");
}

/** End offset (exclusive) of the JSON value starting at `at`. */
function skipValue(text: string, at: number): number {
  const ch = text[at];
  if (ch === '"') return skipString(text, at);
  if (ch === "{" || ch === "[") {
    let depth = 0;
    let i = at;
    while (i < text.length) {
      const c = text[i];
      if (c === '"') {
        i = skipString(text, i);
        continue;
      }
      if (c === "{" || c === "[") depth++;
      else if (c === "}" || c === "]") {
        depth--;
        if (depth === 0) return i + 1;
      }
      i++;
    }
    throw new Error("Unterminated object or array");
  }
  let i = at;
  while (i < text.length && !/[\s,}\]]/.test(text[i] as string)) i++;
  return i;
}

/** The top-level object's members and the offsets of its braces. */
function scanTopLevel(text: string): TopLevel {
  const open = skipSpace(text, 0);
  if (text[open] !== "{") throw new Error("The document is not a JSON object");
  const members: Member[] = [];
  let i = skipSpace(text, open + 1);
  while (text[i] !== "}") {
    if (text[i] !== '"') throw new Error(`Unexpected character at ${i}`);
    const keyStart = i;
    const keyEnd = skipString(text, i);
    const key = JSON.parse(text.slice(keyStart, keyEnd)) as string;
    i = skipSpace(text, keyEnd);
    if (text[i] !== ":") throw new Error(`Expected ':' at ${i}`);
    const valueStart = skipSpace(text, i + 1);
    const valueEnd = skipValue(text, valueStart);
    members.push({ key, keyStart, keyEnd, valueStart, valueEnd });
    i = skipSpace(text, valueEnd);
    if (text[i] === ",") i = skipSpace(text, i + 1);
    else if (text[i] !== "}") throw new Error(`Expected ',' or '}' at ${i}`);
  }
  return { open, close: i, members };
}

/** The whitespace at the start of the line that holds `offset`. */
function lineIndent(text: string, offset: number): string {
  const lineStart = text.lastIndexOf("\n", offset - 1) + 1;
  return /^[ \t]*/.exec(text.slice(lineStart))?.[0] ?? "";
}

/**
 * Serialise `value` for a member whose line is indented by `memberIndent`, one level being
 * `unit`. An empty `unit` means the file is on one line, so the value stays on one line too.
 */
function serialise(value: unknown, unit: string, memberIndent: string, eol: string): string {
  if (!unit) return JSON.stringify(value);
  return JSON.stringify(value, null, unit).split("\n").join(`${eol}${memberIndent}`);
}

/**
 * Set top-level member `key` to `value`: replace its value text if present, otherwise append it
 * as the last member. Everything outside that value is kept byte for byte.
 */
export function setTopLevelMember(text: string, key: string, value: unknown): string {
  const top = scanTopLevel(text);
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const multiline = text.slice(top.open, top.close).includes("\n");
  const first = top.members[0];
  const unit = multiline ? (first ? lineIndent(text, first.keyStart) : "") || "  " : "";
  const existing = top.members.find((m) => m.key === key);
  if (existing) {
    const indent = multiline ? lineIndent(text, existing.keyStart) : "";
    const body = serialise(value, unit, indent, eol);
    return text.slice(0, existing.valueStart) + body + text.slice(existing.valueEnd);
  }
  const last = top.members.at(-1);
  if (!last) {
    // `{}` or `{ }`: write the member on its own line.
    const body = serialise(value, "  ", "  ", eol);
    const head = `${text.slice(0, top.open)}{${eol}  ${JSON.stringify(key)}: `;
    return `${head}${body}${eol}}${text.slice(top.close + 1)}`;
  }
  // Follow the file's own spacing: the text between the last key and its value (`": "`).
  const colon = text.slice(last.keyEnd, last.valueStart);
  const member = `${JSON.stringify(key)}${colon}`;
  const indent = multiline ? lineIndent(text, last.keyStart) : "";
  const body = serialise(value, unit, indent, eol);
  const comma = multiline ? `,${eol}${indent}` : colon.includes(" ") ? ", " : ",";
  return text.slice(0, last.valueEnd) + comma + member + body + text.slice(last.valueEnd);
}

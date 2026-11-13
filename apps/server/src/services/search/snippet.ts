import type { SnippetPart } from "@codeden/contracts";
import { HIGHLIGHT_CLOSE, HIGHLIGHT_OPEN } from "./item-text";

/** About how many characters a snippet shows. */
export const SNIPPET_WIDTH = 160;
/** Characters of context kept before the first match. */
const LEAD = 40;
/** How far a cut may move to land between words. */
const WORD_SLACK = 20;
const ELLIPSIS = "…";

interface Segment {
  text: string;
  match: boolean;
  start: number;
}

/**
 * A short excerpt around the first match of highlighted text (matches wrapped in
 * `HIGHLIGHT_OPEN`/`HIGHLIGHT_CLOSE`), as plain parts: whitespace collapsed, an ellipsis where
 * text was cut, never HTML.
 */
export function snippetParts(marked: string, width = SNIPPET_WIDTH): SnippetPart[] {
  const segments = parse(marked.replace(/\s+/g, " ").trim());
  const plain = segments.map((s) => s.text).join("");
  const firstMatch = segments.find((s) => s.match);
  const matchStart = firstMatch?.start ?? 0;
  const matchEnd = firstMatch ? firstMatch.start + firstMatch.text.length : 0;

  let end = Math.min(plain.length, Math.max(0, matchStart - LEAD) + width);
  let start = Math.max(0, end - width);
  start = cutStart(plain, start, matchStart);
  end = cutEnd(plain, end, matchEnd);

  const parts: SnippetPart[] = [];
  if (start > 0) parts.push({ text: ELLIPSIS, match: false });
  for (const s of segments) {
    const from = Math.max(start, s.start);
    const to = Math.min(end, s.start + s.text.length);
    if (from < to) parts.push({ text: s.text.slice(from - s.start, to - s.start), match: s.match });
  }
  if (end < plain.length) parts.push({ text: ELLIPSIS, match: false });
  return merge(parts);
}

function parse(marked: string): Segment[] {
  const out: Segment[] = [];
  let match = false;
  let text = "";
  let offset = 0;
  const flush = () => {
    if (text) out.push({ text, match, start: offset });
    offset += text.length;
    text = "";
  };
  for (const ch of marked) {
    if (ch === HIGHLIGHT_OPEN || ch === HIGHLIGHT_CLOSE) {
      flush();
      match = ch === HIGHLIGHT_OPEN;
    } else text += ch;
  }
  flush();
  return out;
}

/** Move the start forward to the next word, never past the first match. */
function cutStart(plain: string, start: number, matchStart: number): number {
  if (start === 0) return 0;
  const space = plain.indexOf(" ", start);
  const at = space !== -1 && space < matchStart && space - start < WORD_SLACK ? space + 1 : start;
  return isLowSurrogate(plain, at) ? at + 1 : at;
}

/** Move the end back to the end of a word, never into the first match. */
function cutEnd(plain: string, end: number, matchEnd: number): number {
  if (end >= plain.length) return plain.length;
  const space = plain.lastIndexOf(" ", end);
  const at = space >= matchEnd && end - space < WORD_SLACK ? space : end;
  return isLowSurrogate(plain, at) ? at - 1 : at;
}

/** True when `index` sits between the two halves of a surrogate pair. */
function isLowSurrogate(text: string, index: number): boolean {
  const code = text.charCodeAt(index);
  return code >= 0xdc00 && code <= 0xdfff;
}

/** Join neighbouring parts that are both matches or both not. */
function merge(parts: SnippetPart[]): SnippetPart[] {
  const out: SnippetPart[] = [];
  for (const part of parts) {
    const prev = out.at(-1);
    if (prev && prev.match === part.match) prev.text += part.text;
    else out.push({ ...part });
  }
  return out;
}

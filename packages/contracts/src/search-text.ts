import type { Item, ToolCallItem } from "./items";

/** Most characters of one item that transcript search indexes; the rest is not searchable. */
export const MAX_SEARCHABLE_CHARS = 16_000;

/**
 * The searchable text of a transcript item (§6): what was asked and answered, which commands
 * ran and which files were touched. Reasoning, tool output, diffs, todo lists and follow-up
 * chips are left out: they are large or noisy, and the messages around them say what happened.
 * Returns "" when nothing in the item is worth indexing.
 */
export function searchableText(item: Item): string {
  return join(parts(item)).slice(0, MAX_SEARCHABLE_CHARS);
}

function parts(item: Item): Array<string | undefined> {
  switch (item.kind) {
    case "user_message":
      return [item.input.text];
    case "assistant_message":
    case "plan":
      return [item.text];
    case "tool_call":
      return [item.title, ...toolParts(item)];
    case "subagent":
      return [item.agentType, item.description, item.prompt, item.summary];
    case "user_question":
      return [
        ...item.questions.flatMap((q) => [q.header, q.question]),
        ...Object.values(item.answers ?? {}).flat(),
      ];
    case "approval_request":
      return [item.title, item.reason, item.command, ...(item.paths ?? [])];
    case "notice":
      return [item.message];
    case "error":
      return [item.error.message];
    case "reasoning":
    case "todo_list":
    case "followups":
      return [];
  }
}

function toolParts(item: ToolCallItem): Array<string | undefined> {
  switch (item.toolKind) {
    case "command":
      return [item.command];
    case "file_edit":
      return item.changes.flatMap((c) => [c.previousPath, c.path]);
    case "file_read":
      return [item.path];
    case "search":
      return [item.query, item.path];
    case "web":
      return [item.url, item.query];
    case "mcp":
      return [`${item.server} ${item.tool}`];
    case "browser":
      return [item.action, item.url];
    case "other":
      return [item.toolName];
  }
}

/** Distinct, non-empty parts on their own lines (a title often repeats the command). */
function join(values: Array<string | undefined>): string {
  const seen = new Set<string>();
  for (const value of values) {
    const text = typeof value === "string" ? value.trim() : "";
    if (text) seen.add(text);
  }
  return [...seen].join("\n");
}

/** C0 and C1 control characters and DEL: never part of a search term (a NUL breaks FTS5). */
// biome-ignore lint/suspicious/noControlCharactersInRegex: matching control characters is the point.
const CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f]/g;

/**
 * A transcript search query as searched: control characters become spaces, the text is in NFC
 * form (so an accented letter is one character, as the index stores it) and trimmed.
 */
export function cleanSearchQuery(q: string): string {
  return q.replace(CONTROL_CHARS, " ").normalize("NFC").trim();
}

/** The terms of a query: separated by whitespace, each once. Every term must appear in a hit. */
export function searchTerms(q: string): string[] {
  return [...new Set(cleanSearchQuery(q).split(/\s+/).filter(Boolean))];
}

const NON_ASCII = /[^\p{ASCII}]/u;
const MARKS = /\p{M}/gu;

/**
 * Text as transcript search compares it: lower case, without accents (é → e, Å → a). Matching
 * a folded term against folded text ignores case and accents for terms of any length, as the
 * index does.
 */
export function foldSearchText(text: string): string {
  if (!NON_ASCII.test(text)) return text.toLowerCase();
  return text.normalize("NFD").replace(MARKS, "").toLowerCase().replaceAll("ς", "σ");
}

/**
 * Where the terms appear in `text`, ignoring case and accents: sorted, non-overlapping
 * `[start, end)` ranges of UTF-16 offsets into `text`, for highlighting.
 */
export function searchMatchRanges(text: string, terms: string[]): Array<[number, number]> {
  // Fold character by character, remembering where each folded unit came from.
  let folded = "";
  const from: number[] = [];
  const to: number[] = [];
  let offset = 0;
  for (const ch of text) {
    const f = foldSearchText(ch);
    for (let k = 0; k < f.length; k++) {
      from.push(offset);
      to.push(offset + ch.length);
    }
    folded += f;
    offset += ch.length;
  }
  const ranges: Array<[number, number]> = [];
  for (const term of terms) {
    const t = foldSearchText(term);
    if (!t) continue;
    for (let i = folded.indexOf(t); i !== -1; i = folded.indexOf(t, i + t.length)) {
      ranges.push([from[i] ?? 0, to[i + t.length - 1] ?? 0]);
    }
  }
  ranges.sort((a, b) => a[0] - b[0]);
  const merged: Array<[number, number]> = [];
  for (const [start, end] of ranges) {
    const last = merged.at(-1);
    if (last && start <= last[1]) last[1] = Math.max(last[1], end);
    else merged.push([start, end]);
  }
  return merged;
}

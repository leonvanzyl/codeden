import type { DiffScope } from "@codeden/contracts";

/**
 * Line comments on a diff, sent to the agent as one review message. Pure helpers: reading the
 * rows of a unified patch, quoting the rows a comment covers, and writing the message.
 */

/**
 * Give the diff view's own "+" (its gutter button, drawn inside each `diffs-container`'s
 * shadow root) the Comment label and tooltip it lacks. The view creates the button when a
 * line is first hovered and reuses it, so call this on pointer and focus events.
 */
export function labelCommentButtons(host: ParentNode): void {
  for (const view of host.querySelectorAll("diffs-container")) {
    const buttons = view.shadowRoot?.querySelectorAll("[data-utility-button]:not([aria-label])");
    for (const button of buttons ?? []) {
      button.setAttribute("aria-label", "Comment");
      button.setAttribute("title", "Comment (drag for several lines)");
    }
  }
}

/** Which diff view a comment belongs to: the whole session, uncommitted work or one turn. */
export function diffScopeKey(scope: DiffScope): string {
  return scope.kind === "turn" ? `turn:${scope.turnId}` : scope.kind;
}

/** A diff side: `additions` counts lines in the changed file, `deletions` in the file before. */
export type DiffSide = "additions" | "deletions";

/** The lines a comment covers, from `start` on `side` to `end` on `endSide`, in diff order. */
export interface ReviewRange {
  start: number;
  side: DiffSide;
  end: number;
  endSide: DiffSide;
}

/** A line range as the diff view reports it: sides may be missing and the ends reversed. */
export interface SelectedRange {
  start: number;
  side?: DiffSide;
  end: number;
  endSide?: DiffSide;
}

/** One row of a unified patch hunk. */
export interface PatchRow {
  marker: "+" | "-" | " ";
  text: string;
  /** Line number in the file before the change (context and deleted rows). */
  oldLine?: number;
  /** Line number in the changed file (context and added rows). */
  newLine?: number;
}

/** A finished comment, as it goes into the review message. */
export interface ReviewEntry {
  path: string;
  range: ReviewRange;
  /** The covered rows, each with its `+`, `-` or space marker. */
  quote: string[];
  body: string;
}

const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

/**
 * The rows of every hunk in a unified patch, in diff order. Hunk line counts decide where a
 * hunk ends, so file headers after it are never read as rows. `\ No newline` notes are skipped.
 */
export function parsePatchRows(patch: string): PatchRow[] {
  const rows: PatchRow[] = [];
  let oldLine = 0;
  let newLine = 0;
  let oldLeft = 0;
  let newLeft = 0;
  for (const raw of patch.split("\n")) {
    const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
    const header = HUNK_HEADER.exec(line);
    if (header) {
      oldLine = Number(header[1]);
      oldLeft = header[2] === undefined ? 1 : Number(header[2]);
      newLine = Number(header[3]);
      newLeft = header[4] === undefined ? 1 : Number(header[4]);
      continue;
    }
    if (oldLeft <= 0 && newLeft <= 0) continue;
    if (line.startsWith("\\")) continue;
    const marker = line[0];
    if (marker === "+" && newLeft > 0) {
      rows.push({ marker: "+", text: line.slice(1), newLine: newLine++ });
      newLeft--;
    } else if (marker === "-" && oldLeft > 0) {
      rows.push({ marker: "-", text: line.slice(1), oldLine: oldLine++ });
      oldLeft--;
    } else if (marker === " " || line === "") {
      // Some tools strip the space from an empty context line.
      rows.push({ marker: " ", text: line.slice(1), oldLine: oldLine++, newLine: newLine++ });
      oldLeft--;
      newLeft--;
    }
  }
  return rows;
}

function rowIndex(rows: PatchRow[], line: number, side: DiffSide): number {
  return rows.findIndex((r) => (side === "additions" ? r.newLine : r.oldLine) === line);
}

/** A side for a row: the one it was picked on when the row has it, else the row's own side. */
function sideOf(row: PatchRow, picked: DiffSide): DiffSide {
  if (picked === "additions" ? row.newLine !== undefined : row.oldLine !== undefined) return picked;
  return row.marker === "-" ? "deletions" : "additions";
}

function lineOf(row: PatchRow, side: DiffSide): number {
  return (side === "additions" ? row.newLine : row.oldLine) ?? 0;
}

/**
 * The rows a selected range covers, top to bottom, and the range put in diff order (a range
 * selected upwards is turned around). Every row between the two ends is quoted, whatever its
 * side, so a comment carries what the unified view showed. A range whose lines are not in the
 * patch keeps its numbers and quotes nothing.
 */
export function captureRange(
  patch: string,
  selected: SelectedRange,
): { range: ReviewRange; quote: string[] } {
  const side = selected.side ?? "additions";
  const endSide = selected.endSide ?? side;
  const rows = parsePatchRows(patch);
  const a = rowIndex(rows, selected.start, side);
  const b = rowIndex(rows, selected.end, endSide);
  if (a < 0 || b < 0) {
    const [start, end] =
      side === endSide && selected.start > selected.end
        ? [selected.end, selected.start]
        : [selected.start, selected.end];
    return { range: { start, side, end, endSide }, quote: [] };
  }
  const [top, bottom] = a <= b ? [a, b] : [b, a];
  const topRow = rows[top] as PatchRow;
  const bottomRow = rows[bottom] as PatchRow;
  const topSide = sideOf(topRow, a <= b ? side : endSide);
  const bottomSide = sideOf(bottomRow, a <= b ? endSide : side);
  return {
    range: {
      start: lineOf(topRow, topSide),
      side: topSide,
      end: lineOf(bottomRow, bottomSide),
      endSide: bottomSide,
    },
    quote: rows.slice(top, bottom + 1).map((r) => r.marker + r.text),
  };
}

const sideWord = (side: DiffSide) => (side === "additions" ? "new" : "old");

/**
 * "new line 37", "new lines 37–39", "old line 12" or "old line 12 to new line 14". New lines
 * are numbered in the changed file, old lines in the file before the change.
 */
export function rangeLabel(range: ReviewRange): string {
  if (range.side !== range.endSide) {
    return `${sideWord(range.side)} line ${range.start} to ${sideWord(range.endSide)} line ${range.end}`;
  }
  if (range.start === range.end) return `${sideWord(range.side)} line ${range.start}`;
  return `${sideWord(range.side)} lines ${range.start}–${range.end}`;
}

/** A code fence longer than any run of backticks in the quoted lines, so code can't close it. */
export function fenceFor(lines: string[]): string {
  let longest = 0;
  for (const line of lines) {
    for (const run of line.match(/`+/g) ?? []) longest = Math.max(longest, run.length);
  }
  return "`".repeat(Math.max(3, longest + 1));
}

function compareEntries(a: ReviewEntry, b: ReviewEntry): number {
  if (a.path !== b.path) return a.path < b.path ? -1 : 1;
  return a.range.start - b.range.start || a.range.end - b.range.end;
}

/**
 * One message for the agent with every comment: by file, then by line. Each names its file,
 * side and lines, quotes the diff rows in a `diff` fence and then gives the comment.
 */
export function formatReviewMessage(entries: ReviewEntry[]): string {
  const sorted = entries.filter((e) => e.body.trim()).sort(compareEntries);
  const n = sorted.length;
  const intro =
    n === 1
      ? "1 review comment on your changes. Please address it."
      : `${n} review comments on your changes. Please address each one.`;
  const blocks = sorted.map((e, i) => {
    const lines = [`${i + 1}. ${e.path}, ${rangeLabel(e.range)}`];
    if (e.quote.length > 0) {
      const fence = fenceFor(e.quote);
      lines.push(`${fence}diff`, ...e.quote, fence);
    }
    lines.push(e.body.trim());
    return lines.join("\n");
  });
  return [intro, ...blocks].join("\n\n");
}

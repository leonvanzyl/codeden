import { type DiffSide, type PatchRow, parsePatchRows, type ReviewRange } from "./diff-review";

/**
 * Picking a file's diff lines for a comment from the keyboard (the diff view's own "+" needs a
 * pointer). Pure helpers: the rows the line picker lists, and the range the picked ones cover.
 */

/** A row of a file's diff as the line picker lists it, in diff order. */
export interface PickerLine {
  /** The side a comment on it is anchored to: `deletions` for a removed row, else `additions`. */
  side: DiffSide;
  /** Its line number on that side. */
  line: number;
  kind: "added" | "removed" | "unchanged";
  marker: PatchRow["marker"];
  /** Line number in the file before the change (unchanged and removed rows). */
  oldLine?: number;
  /** Line number in the changed file (unchanged and added rows). */
  newLine?: number;
  text: string;
  /** Whether lines the diff doesn't show come before it: it starts a hunk after the first. */
  gapBefore: boolean;
  /** How it reads aloud: "new line 2, added: return 0;". */
  label: string;
}

const kinds = { "+": "added", "-": "removed", " ": "unchanged" } as const;

/** The rows of a unified patch that a comment can go on, as the line picker lists them. */
export function pickerLines(patch: string): PickerLine[] {
  // The line each side's next row has when no lines are skipped.
  let nextOld: number | undefined;
  let nextNew: number | undefined;
  return parsePatchRows(patch).map((row) => {
    const gapBefore =
      (row.oldLine !== undefined && nextOld !== undefined && row.oldLine !== nextOld) ||
      (row.newLine !== undefined && nextNew !== undefined && row.newLine !== nextNew);
    // A new hunk: the side this row lacks picks up from its own first row.
    if (gapBefore) nextOld = nextNew = undefined;
    if (row.oldLine !== undefined) nextOld = row.oldLine + 1;
    if (row.newLine !== undefined) nextNew = row.newLine + 1;
    const side: DiffSide = row.marker === "-" ? "deletions" : "additions";
    const line = (side === "additions" ? row.newLine : row.oldLine) ?? 0;
    const kind = kinds[row.marker];
    const words = row.text.trim() || "blank";
    return {
      side,
      line,
      kind,
      marker: row.marker,
      ...(row.oldLine !== undefined ? { oldLine: row.oldLine } : {}),
      ...(row.newLine !== undefined ? { newLine: row.newLine } : {}),
      text: row.text,
      gapBefore,
      label: `${side === "additions" ? "new" : "old"} line ${line}, ${kind}: ${words}`,
    };
  });
}

/**
 * The range a comment covers when the picker's rows from index `a` to index `b` are picked,
 * either way round, top to bottom: the same range `captureRange` makes of those rows. Null
 * when either index isn't a row.
 */
export function pickedRange(lines: PickerLine[], a: number, b: number): ReviewRange | null {
  const top = lines[Math.min(a, b)];
  const bottom = lines[Math.max(a, b)];
  if (!top || !bottom) return null;
  return { start: top.line, side: top.side, end: bottom.line, endSide: bottom.side };
}

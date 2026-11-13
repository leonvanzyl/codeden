import { describe, expect, it } from "vitest";
import { pickedRange, pickerLines } from "@/lib/diff-line-picker";
import { captureRange } from "@/lib/diff-review";

// Two hunks: old lines 10-13 and 30-31, new lines 10-14 and 31-32.
const patch = [
  "diff --git a/src/cart.ts b/src/cart.ts",
  "--- a/src/cart.ts",
  "+++ b/src/cart.ts",
  "@@ -10,4 +10,5 @@ export function useCart() {",
  "   const latest = useRef(0);",
  "-  const id = next();",
  "+  const requestId = next();",
  "+  latest.current = requestId;",
  "   load(id);",
  "",
  "@@ -30,2 +31,2 @@",
  "-  return items;",
  "+  return items ?? [];",
  " }",
].join("\n");

describe("pickerLines", () => {
  it("lists every row in diff order with its side, numbers and spoken label", () => {
    const lines = pickerLines(patch);
    expect(lines.map((l) => [l.marker, l.side, l.line, l.oldLine, l.newLine])).toEqual([
      [" ", "additions", 10, 10, 10],
      ["-", "deletions", 11, 11, undefined],
      ["+", "additions", 11, undefined, 11],
      ["+", "additions", 12, undefined, 12],
      [" ", "additions", 13, 12, 13],
      [" ", "additions", 14, 13, 14],
      ["-", "deletions", 30, 30, undefined],
      ["+", "additions", 31, undefined, 31],
      [" ", "additions", 32, 31, 32],
    ]);
    expect(lines.map((l) => l.label).slice(0, 3)).toEqual([
      "new line 10, unchanged: const latest = useRef(0);",
      "old line 11, removed: const id = next();",
      "new line 11, added: const requestId = next();",
    ]);
    // An empty row still reads as something.
    expect(lines[5]?.label).toBe("new line 14, unchanged: blank");
    expect(lines[2]?.text).toBe("  const requestId = next();");
  });

  it("marks the first row of each later hunk as following a gap", () => {
    const gaps = pickerLines(patch).map((l, i) => (l.gapBefore ? i : -1));
    expect(gaps.filter((i) => i >= 0)).toEqual([6]);
  });

  it("lists nothing for a patch without hunks", () => {
    expect(pickerLines("diff --git a/x b/x\nsimilarity index 100%\n")).toEqual([]);
  });
});

describe("pickedRange", () => {
  const lines = pickerLines(patch);

  it("covers one row, or the rows between two picks either way round", () => {
    expect(pickedRange(lines, 2, 2)).toEqual({
      start: 11,
      side: "additions",
      end: 11,
      endSide: "additions",
    });
    const down = pickedRange(lines, 1, 3);
    expect(down).toEqual({ start: 11, side: "deletions", end: 12, endSide: "additions" });
    expect(pickedRange(lines, 3, 1)).toEqual(down);
  });

  it("is the range the diff view's own selection of those rows makes", () => {
    for (const [a, b] of [
      [0, 0],
      [1, 3],
      [4, 1],
      [5, 8],
      [6, 6],
    ] as const) {
      const range = pickedRange(lines, a, b);
      expect(range && captureRange(patch, range).range).toEqual(range);
    }
  });

  it("is null when a pick isn't a row", () => {
    expect(pickedRange(lines, 0, lines.length)).toBeNull();
    expect(pickedRange(lines, -1, 2)).toBeNull();
    expect(pickedRange([], 0, 0)).toBeNull();
  });
});

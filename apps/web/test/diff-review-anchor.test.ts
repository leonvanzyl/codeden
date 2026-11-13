import { describe, expect, it } from "vitest";
import {
  anchorComments,
  captureRange,
  diffScopeKey,
  parsePatchRows,
  type ReviewRange,
  relocateRange,
  scopeFromKey,
} from "@/lib/diff-review";

const header = ["diff --git a/src/cart.ts b/src/cart.ts", "--- a/src/cart.ts", "+++ b/src/cart.ts"];
const changes = [
  "   const latest = useRef(0);",
  "-  const id = next();",
  "+  const requestId = next();",
  "+  latest.current = requestId;",
  "   load(id);",
  " ",
];
const tail = ["-  return items;", "+  return items ?? [];", " }"];

// The diff a comment was written on: old lines 10-13 and 30-31, new lines 10-14 and 31-32.
const before = [
  ...header,
  "@@ -10,4 +10,5 @@ export function useCart() {",
  ...changes,
  "@@ -30,2 +31,2 @@",
  ...tail,
].join("\n");

// The next checkpoint: two imports added at the top, so every new line below moves down by 2.
const shifted = [
  ...header,
  "@@ -1,1 +1,3 @@",
  "+import { next } from './ids';",
  "+",
  " import { useRef } from 'react';",
  "@@ -10,4 +12,5 @@ export function useCart() {",
  ...changes,
  "@@ -30,2 +33,2 @@",
  ...tail,
].join("\n");

// A later checkpoint: the first change reverted, so its rows are no longer in the diff.
const reverted = [...header, "@@ -30,2 +30,2 @@", ...tail].join("\n");

/** A comment's range and quote as written on `before`. */
const written = (selected: Parameters<typeof captureRange>[1]) => captureRange(before, selected);

describe("relocateRange", () => {
  it("returns the same range when the diff hasn't changed", () => {
    const { range, quote } = written({ start: 12, side: "additions", end: 12 });
    expect(relocateRange(parsePatchRows(before), range, quote)).toBe(range);
  });

  it("follows the quoted lines when lines are added above them", () => {
    const rows = parsePatchRows(shifted);
    const one = written({ start: 12, side: "additions", end: 12 });
    expect(relocateRange(rows, one.range, one.quote)).toEqual({
      start: 14,
      side: "additions",
      end: 14,
      endSide: "additions",
    });
    // From a deleted line (old numbers don't move) to an added one (new numbers do).
    const span = written({ start: 11, side: "deletions", end: 12, endSide: "additions" });
    expect(relocateRange(rows, span.range, span.quote)).toEqual({
      start: 11,
      side: "deletions",
      end: 14,
      endSide: "additions",
    });
    const context = written({ start: 32, side: "additions", end: 32 });
    expect(relocateRange(rows, context.range, context.quote)?.start).toBe(34);
  });

  it("returns null when the quoted lines are no longer in the diff", () => {
    const rows = parsePatchRows(reverted);
    const { range, quote } = written({ start: 12, side: "additions", end: 12 });
    expect(relocateRange(rows, range, quote)).toBeNull();
    // One quoted line changed: the comment no longer matches what it was about.
    const edited = parsePatchRows(before.replace("latest.current = requestId", "latest.current++"));
    const span = written({ start: 11, side: "additions", end: 12 });
    expect(relocateRange(edited, span.range, span.quote)).toBeNull();
  });

  it("picks the match nearest the old position when the quote appears more than once", () => {
    const body = ["+if (a) {", "+  go();", "+}", "+if (b) {", "+  go();", "+}"];
    const was = ["@@ -0,0 +1,6 @@", ...body].join("\n");
    const now = parsePatchRows(["@@ -0,0 +1,7 @@", "+// Both branches", ...body].join("\n"));
    const { range, quote } = captureRange(was, { start: 5, side: "additions", end: 5 });
    expect(relocateRange(now, range, quote)?.start).toBe(6);
  });

  it("keeps a range that quotes nothing while its last line is still a row", () => {
    const range: ReviewRange = { start: 12, side: "additions", end: 12, endSide: "additions" };
    expect(relocateRange(parsePatchRows(shifted), range, [])).toBe(range);
    expect(relocateRange(parsePatchRows(reverted), range, [])).toBeNull();
  });
});

describe("anchorComments", () => {
  const comment = (id: string, path: string, start: number) => ({
    id,
    path,
    ...written({ start, side: "additions", end: start }),
  });

  it("puts comments under their lines as they are now, and lists the rest as outdated", () => {
    const anchors = anchorComments(
      [
        comment("a", "src/cart.ts", 12),
        comment("b", "src/cart.ts", 12),
        comment("c", "src/cart.ts", 31),
        comment("gone-file", "src/old.ts", 12),
      ],
      [{ path: "src/cart.ts", patch: shifted }],
    );
    expect(anchors.byPath.get("src/cart.ts")).toEqual([
      { side: "additions", lineNumber: 14, metadata: ["a", "b"] },
      { side: "additions", lineNumber: 33, metadata: ["c"] },
    ]);
    expect(anchors.ranges.get("c")).toEqual({
      start: 33,
      side: "additions",
      end: 33,
      endSide: "additions",
    });
    expect(anchors.outdated).toEqual(["gone-file"]);

    const later = anchorComments(
      [comment("a", "src/cart.ts", 12)],
      [{ path: "src/cart.ts", patch: reverted }],
    );
    expect(later.byPath.size).toBe(0);
    expect(later.ranges.size).toBe(0);
    expect(later.outdated).toEqual(["a"]);
  });

  it("lists a comment on a file that became binary as outdated", () => {
    const anchors = anchorComments(
      [comment("a", "src/cart.ts", 12)],
      [{ path: "src/cart.ts", patch: before, binary: true }],
    );
    expect(anchors.outdated).toEqual(["a"]);
  });

  it("places comments on files whose names are also Object properties", () => {
    for (const path of ["constructor", "__proto__", "toString", "hasOwnProperty"]) {
      const patch = `diff --git a/${path} b/${path}\n--- /dev/null\n+++ b/${path}\n@@ -0,0 +1 @@\n+x\n`;
      const written = captureRange(patch, { start: 1, side: "additions", end: 1 });
      const anchors = anchorComments([{ id: "a", path, ...written }], [{ path, patch }]);
      expect(anchors.byPath.get(path)).toEqual([
        { side: "additions", lineNumber: 1, metadata: ["a"] },
      ]);
      expect(anchors.outdated).toEqual([]);
    }
  });
});

describe("scopeFromKey", () => {
  it("reads back each view's key", () => {
    for (const scope of [
      { kind: "session" },
      { kind: "uncommitted" },
      { kind: "turn", turnId: "t-3" },
    ] as const) {
      expect(scopeFromKey(diffScopeKey(scope))).toEqual(scope);
    }
  });
});

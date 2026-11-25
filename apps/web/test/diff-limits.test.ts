import type { DiffFile } from "@codeden/contracts";
import { describe, expect, it } from "vitest";
import { DIFF_LIMITS, isLargePatch, visibleFiles } from "@/lib/diff-limits";

const file = (path: string, over: Partial<DiffFile> = {}): DiffFile => ({
  path,
  change: "modify",
  additions: 1,
  deletions: 1,
  patch: `--- a/${path}\n+++ b/${path}\n@@ -1 +1 @@\n-a\n+b\n`,
  ...over,
});

describe("isLargePatch", () => {
  it("keeps ordinary files open", () => {
    expect(isLargePatch(file("a.ts", { additions: 1500, deletions: 500 }))).toBe(false);
  });

  it("collapses a file with too many changed lines", () => {
    expect(isLargePatch(file("fixtures.json", { additions: 137_551, deletions: 0 }))).toBe(true);
  });

  it("collapses a file with few, very long lines", () => {
    const patch = "x".repeat(DIFF_LIMITS.largePatchChars + 1);
    expect(isLargePatch(file("bundle.min.js", { additions: 1, deletions: 1, patch }))).toBe(true);
  });
});

describe("visibleFiles", () => {
  const files = Array.from({ length: 120 }, (_, i) => file(`f${i}.ts`));

  it("draws every file of a small diff", () => {
    expect(visibleFiles(files.slice(0, 3), 50, () => false)).toHaveLength(3);
  });

  it("draws only the first page of a big diff", () => {
    const shown = visibleFiles(files, 50, () => false);
    expect(shown).toHaveLength(50);
    expect(shown.at(-1)?.path).toBe("f49.ts");
  });

  it("keeps a later file with comments, in diff order", () => {
    const shown = visibleFiles(files, 2, (f) => f.path === "f100.ts");
    expect(shown.map((f) => f.path)).toEqual(["f0.ts", "f1.ts", "f100.ts"]);
  });
});

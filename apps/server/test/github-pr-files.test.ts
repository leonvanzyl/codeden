import { describe, expect, it } from "vitest";
import { toUnifiedPatch } from "../src/services/github/pr-files";

const hunks = "@@ -1,2 +1,2 @@\n a\n-b\n+c";

describe("toUnifiedPatch", () => {
  it("adds git headers to GitHub's hunk-only patch", () => {
    expect(toUnifiedPatch({ path: "src/a.ts", status: "modified" }, hunks)).toBe(
      `diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n${hunks}\n`,
    );
  });

  it("uses /dev/null for added and removed files", () => {
    expect(toUnifiedPatch({ path: "new.ts", status: "added" }, "@@ -0,0 +1 @@\n+x")).toBe(
      "diff --git a/new.ts b/new.ts\n--- /dev/null\n+++ b/new.ts\n@@ -0,0 +1 @@\n+x\n",
    );
    expect(toUnifiedPatch({ path: "old.ts", status: "removed" }, "@@ -1 +0,0 @@\n-x\n")).toBe(
      "diff --git a/old.ts b/old.ts\n--- a/old.ts\n+++ /dev/null\n@@ -1 +0,0 @@\n-x\n",
    );
  });

  it("names both sides of a rename", () => {
    expect(
      toUnifiedPatch({ path: "src/new.ts", previousPath: "src/old.ts", status: "renamed" }, hunks),
    ).toBe(`diff --git a/src/old.ts b/src/new.ts\n--- a/src/old.ts\n+++ b/src/new.ts\n${hunks}\n`);
  });

  it("is null when GitHub sent no patch (binary, too large, no content change)", () => {
    expect(toUnifiedPatch({ path: "logo.png", status: "added" }, undefined)).toBeNull();
    expect(
      toUnifiedPatch({ path: "a.ts", status: "renamed", previousPath: "b.ts" }, ""),
    ).toBeNull();
  });
});

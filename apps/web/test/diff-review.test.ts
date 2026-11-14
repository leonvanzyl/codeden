import { afterEach, describe, expect, it } from "vitest";
import {
  captureRange,
  diffScopeKey,
  fenceFor,
  formatReviewMessage,
  labelCommentButtons,
  parsePatchRows,
  type ReviewEntry,
  rangeLabel,
} from "@/lib/diff-review";
import {
  hasUnsavedEdit,
  type ReviewComment,
  savedComments,
  sessionComments,
  useDiffReviewStore,
} from "@/stores/diff-review";

// Old file lines 10-16, new file lines 10-17; two hunks.
const patch = [
  "diff --git a/src/cart.ts b/src/cart.ts",
  "index 1111111..2222222 100644",
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
  "\\ No newline at end of file",
  "",
].join("\n");

describe("parsePatchRows", () => {
  it("numbers rows on both sides and skips file headers and no-newline notes", () => {
    const rows = parsePatchRows(patch);
    expect(rows.map((r) => r.marker).join("")).toBe(" -++  -+ ");
    expect(rows[0]).toEqual({
      marker: " ",
      text: "  const latest = useRef(0);",
      oldLine: 10,
      newLine: 10,
    });
    expect(rows[1]).toMatchObject({ marker: "-", oldLine: 11 });
    expect(rows[1]?.newLine).toBeUndefined();
    expect(rows[3]).toMatchObject({
      marker: "+",
      newLine: 12,
      text: "  latest.current = requestId;",
    });
    // An empty context line, here without its leading space after a trim.
    expect(rows[5]).toMatchObject({ marker: " ", text: "", oldLine: 13, newLine: 14 });
    expect(rows[6]).toMatchObject({ marker: "-", oldLine: 30 });
    expect(rows[8]).toMatchObject({ marker: " ", text: "}", oldLine: 31, newLine: 32 });
  });

  it("reads a hunk header without counts and a new file", () => {
    const rows = parsePatchRows("--- /dev/null\n+++ b/a.txt\n@@ -0,0 +1 @@\n+hello\n");
    expect(rows).toEqual([{ marker: "+", text: "hello", newLine: 1 }]);
  });

  it("handles CRLF patches", () => {
    const rows = parsePatchRows("@@ -1 +1 @@\r\n-a\r\n+b\r\n");
    expect(rows.map((r) => r.marker + r.text)).toEqual(["-a", "+b"]);
  });
});

describe("captureRange", () => {
  it("quotes one added line", () => {
    const { range, quote } = captureRange(patch, { start: 12, side: "additions", end: 12 });
    expect(range).toEqual({ start: 12, side: "additions", end: 12, endSide: "additions" });
    expect(quote).toEqual(["+  latest.current = requestId;"]);
  });

  it("defaults a range without sides to the new file", () => {
    expect(captureRange(patch, { start: 11, end: 12 }).quote).toEqual([
      "+  const requestId = next();",
      "+  latest.current = requestId;",
    ]);
  });

  it("quotes a range on the old side, context included", () => {
    const { range, quote } = captureRange(patch, {
      start: 10,
      side: "deletions",
      end: 11,
      endSide: "deletions",
    });
    expect(range).toEqual({ start: 10, side: "deletions", end: 11, endSide: "deletions" });
    expect(quote).toEqual(["   const latest = useRef(0);", "-  const id = next();"]);
  });

  it("quotes a range from a deleted line to an added line", () => {
    const { range, quote } = captureRange(patch, {
      start: 11,
      side: "deletions",
      end: 12,
      endSide: "additions",
    });
    expect(range).toEqual({ start: 11, side: "deletions", end: 12, endSide: "additions" });
    expect(quote).toEqual([
      "-  const id = next();",
      "+  const requestId = next();",
      "+  latest.current = requestId;",
    ]);
  });

  it("turns a range selected upwards around", () => {
    const { range, quote } = captureRange(patch, {
      start: 12,
      side: "additions",
      end: 11,
      endSide: "deletions",
    });
    expect(range).toEqual({ start: 11, side: "deletions", end: 12, endSide: "additions" });
    expect(quote).toHaveLength(3);
    expect(captureRange(patch, { start: 13, side: "additions", end: 10 }).range).toEqual({
      start: 10,
      side: "additions",
      end: 13,
      endSide: "additions",
    });
  });

  it("quotes across hunks, in diff order, without the no-newline note", () => {
    const { quote } = captureRange(patch, { start: 31, side: "additions", end: 32 });
    expect(quote).toEqual(["+  return items ?? [];", " }"]);
    expect(captureRange(patch, { start: 14, side: "additions", end: 31 }).quote).toEqual([
      " ",
      "-  return items;",
      "+  return items ?? [];",
    ]);
  });

  it("keeps the numbers and quotes nothing when the lines are not in the patch", () => {
    const { range, quote } = captureRange(patch, { start: 90, side: "additions", end: 80 });
    expect(range).toEqual({ start: 80, side: "additions", end: 90, endSide: "additions" });
    expect(quote).toEqual([]);
  });
});

describe("labelCommentButtons", () => {
  it("names the diff view's + button inside its shadow root", () => {
    const card = document.createElement("div");
    const view = document.createElement("diffs-container");
    card.append(view);
    const root = view.attachShadow({ mode: "open" });
    const plus = document.createElement("button");
    plus.setAttribute("data-utility-button", "");
    const other = document.createElement("button");
    root.append(plus, other);
    labelCommentButtons(card);
    expect(plus.getAttribute("aria-label")).toBe("Comment");
    expect(plus.title).toBe("Comment (drag for several lines)");
    expect(other.hasAttribute("aria-label")).toBe(false);
  });
});

describe("diffScopeKey", () => {
  it("names each diff view, turns by id", () => {
    expect(diffScopeKey({ kind: "session" })).toBe("session");
    expect(diffScopeKey({ kind: "uncommitted" })).toBe("uncommitted");
    expect(diffScopeKey({ kind: "turn", turnId: "t-3" })).toBe("turn:t-3");
    expect(diffScopeKey({ kind: "compare", sessionId: "s-2" })).toBe("compare:s-2");
  });
});

describe("rangeLabel", () => {
  it("names the side and the lines", () => {
    expect(rangeLabel({ start: 37, side: "additions", end: 37, endSide: "additions" })).toBe(
      "new line 37",
    );
    expect(rangeLabel({ start: 37, side: "additions", end: 39, endSide: "additions" })).toBe(
      "new lines 37–39",
    );
    expect(rangeLabel({ start: 12, side: "deletions", end: 12, endSide: "deletions" })).toBe(
      "old line 12",
    );
    expect(rangeLabel({ start: 12, side: "deletions", end: 14, endSide: "additions" })).toBe(
      "old line 12 to new line 14",
    );
  });
});

describe("formatReviewMessage", () => {
  const entry = (path: string, start: number, body: string, quote = [`+line ${start}`]) =>
    ({
      path,
      range: { start, side: "additions", end: start, endSide: "additions" },
      quote,
      body,
    }) satisfies ReviewEntry;

  it("writes one message, by file then line, with the quoted rows and each comment", () => {
    const text = formatReviewMessage([
      entry("src/b.ts", 5, "Rename this."),
      entry("src/a.ts", 20, "  Guard the error path too.\n"),
      entry("src/a.ts", 3, "Why a loop?"),
    ]);
    expect(text).toBe(
      [
        "3 review comments on your changes. Please address each one.",
        "",
        "1. src/a.ts, new line 3",
        "```diff",
        "+line 3",
        "```",
        "Why a loop?",
        "",
        "2. src/a.ts, new line 20",
        "```diff",
        "+line 20",
        "```",
        "Guard the error path too.",
        "",
        "3. src/b.ts, new line 5",
        "```diff",
        "+line 5",
        "```",
        "Rename this.",
      ].join("\n"),
    );
  });

  it("uses a fence the quoted code cannot close", () => {
    expect(fenceFor(["+const s = `x`;"])).toBe("```");
    expect(fenceFor(["+```ts", "+ ````"])).toBe("`````");
    const text = formatReviewMessage([entry("README.md", 1, "Close the block.", ["+```ts"])]);
    expect(text).toContain("````diff\n+```ts\n````\nClose the block.");
    expect(text.startsWith("1 review comment on your changes. Please address it.")).toBe(true);
  });

  it("leaves out empty comments and the code block when nothing was quoted", () => {
    const text = formatReviewMessage([entry("a.ts", 1, "   "), entry("b.ts", 2, "Fix.", [])]);
    expect(text).toBe(
      "1 review comment on your changes. Please address it.\n\n1. b.ts, new line 2\nFix.",
    );
  });
});

describe("diff review drafts", () => {
  const sid = "s1";
  const base: Omit<ReviewComment, "id" | "body" | "draft"> = {
    path: "src/a.ts",
    scopeKey: "session",
    range: { start: 1, side: "additions", end: 1, endSide: "additions" },
    quote: ["+x"],
  };
  const list = () => sessionComments(useDiffReviewStore.getState(), sid);
  afterEach(() => useDiffReviewStore.getState().clear(sid));

  it("starts with the editor open and counts a comment only once it is saved", () => {
    const store = useDiffReviewStore.getState();
    store.start(sid, base);
    const id = list()[0]?.id ?? "";
    expect(list()[0]).toMatchObject({ body: "", draft: "" });
    expect(savedComments(list())).toHaveLength(0);
    store.setDraft(sid, id, "  Use a map.  ");
    expect(hasUnsavedEdit(list())).toBe(true);
    store.save(sid, id);
    expect(list()[0]).toMatchObject({ body: "Use a map.", draft: undefined });
    expect(savedComments(list())).toHaveLength(1);
    expect(hasUnsavedEdit(list())).toBe(false);
  });

  it("drops a never-saved comment on cancel or an empty save, and keeps a saved one", () => {
    const store = useDiffReviewStore.getState();
    store.start(sid, base);
    store.cancel(sid, list()[0]?.id ?? "");
    expect(list()).toHaveLength(0);
    store.start(sid, base);
    store.save(sid, list()[0]?.id ?? "");
    expect(list()).toHaveLength(0);

    store.start(sid, base);
    const id = list()[0]?.id ?? "";
    store.setDraft(sid, id, "Keep me");
    store.save(sid, id);
    store.edit(sid, id);
    store.setDraft(sid, id, "Changed my mind");
    store.cancel(sid, id);
    expect(list()[0]).toMatchObject({ body: "Keep me", draft: undefined });
  });

  it("keeps drafts per session and removes only the given comments", () => {
    const store = useDiffReviewStore.getState();
    store.start(sid, base);
    store.start(sid, { ...base, path: "src/b.ts" });
    store.start("s2", base);
    const [first] = list();
    store.remove(sid, [first?.id ?? ""]);
    expect(list().map((c) => c.path)).toEqual(["src/b.ts"]);
    expect(sessionComments(useDiffReviewStore.getState(), "s2")).toHaveLength(1);
    store.clear("s2");
  });
});

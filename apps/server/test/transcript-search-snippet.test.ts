import type { Item } from "@codeden/contracts";
import { describe, expect, it } from "vitest";
import { indexedText } from "../src/services/search/item-text";
import { snippetParts } from "../src/services/search/snippet";

describe("indexed text", () => {
  it("drops the characters search uses to mark matches", () => {
    const marked: Item = {
      id: "i1",
      status: "completed",
      kind: "assistant_message",
      text: "a\u0002b\u0003c",
    };
    expect(indexedText(marked)).toBe("abc");
  });
});

describe("snippets", () => {
  const O = "\u0002";
  const C = "\u0003";

  it("returns short text whole, with the matches marked and whitespace collapsed", () => {
    expect(snippetParts(`Fix the ${O}cart${C}\n\n  hook`)).toEqual([
      { text: "Fix the ", match: false },
      { text: "cart", match: true },
      { text: " hook", match: false },
    ]);
  });

  it("cuts long text around the first match, between words, with ellipses", () => {
    const before = "lorem ipsum ".repeat(30);
    const after = " dolor sit amet".repeat(30);
    const parts = snippetParts(`${before}${O}webhook${C}${after}`);
    const text = parts.map((p) => p.text).join("");
    expect(parts.find((p) => p.match)?.text).toBe("webhook");
    expect(text.startsWith("…")).toBe(true);
    expect(text.endsWith("…")).toBe(true);
    expect(text.length).toBeLessThanOrEqual(162);
    // Cuts land between words.
    expect(text).toMatch(/^…(lorem|ipsum) /);
    expect(text).toMatch(/ (dolor|sit|amet)…$/);
  });

  it("keeps a match near the end inside the snippet", () => {
    const parts = snippetParts(`${"word ".repeat(100)}${O}tail${C}`);
    expect(parts.at(-1)).toEqual({ text: "tail", match: true });
    expect(parts[0]?.text.startsWith("…")).toBe(true);
  });
});

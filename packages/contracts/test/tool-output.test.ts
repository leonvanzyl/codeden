import { describe, expect, it } from "vitest";
import { ToolOutputResponse } from "../src";
import { appendToolOutput, utf8ByteLength } from "../src/tool-output";

describe("ToolOutputResponse", () => {
  it("round-trips, and says whether the stored copy is cut", () => {
    const value = {
      itemId: "c1",
      text: "tail\n",
      totalBytes: 5,
      truncated: true,
      outputBytes: 2_000_000,
    };
    expect(ToolOutputResponse.parse(JSON.parse(JSON.stringify(value)))).toEqual(value);
    expect(() => ToolOutputResponse.parse({ itemId: "c1", text: "", totalBytes: 0 })).toThrow();
  });
});

describe("utf8ByteLength", () => {
  it("counts bytes as Node does, lone surrogates included", () => {
    for (const s of ["", "ascii", "é ü", "€ ✓", "😀 🚀", "a\ud83d", "\ude00b", "\ud83d\ud83d"]) {
      expect(utf8ByteLength(s), JSON.stringify(s)).toBe(Buffer.byteLength(s, "utf8"));
    }
  });
});

describe("appendToolOutput", () => {
  it("keeps short output whole, and cuts an oversized chunk or a split surrogate pair cleanly", () => {
    expect(appendToolOutput(appendToolOutput(undefined, "a\n", 10), "b\n", 10)).toEqual({
      text: "a\nb\n",
      truncated: false,
      totalBytes: 4,
    });
    expect(appendToolOutput({ text: "abc", truncated: false }, "0123456789xy", 10)).toEqual({
      text: "23456789xy",
      truncated: true,
      totalBytes: 15,
    });
    // "😀" is two UTF-16 units (4 UTF-8 bytes); a cut between them drops the lone half.
    expect(appendToolOutput(undefined, "😀abc", 4)).toEqual({
      text: "abc",
      truncated: true,
      totalBytes: 7,
    });
  });

  it("adds to a total it was given rather than counting the kept text again", () => {
    const cut = { text: "tail", truncated: true, totalBytes: 2_000_000 };
    expect(appendToolOutput(cut, "!\n", 100)).toEqual({
      text: "tail!\n",
      truncated: true,
      totalBytes: 2_000_002,
    });
  });
});

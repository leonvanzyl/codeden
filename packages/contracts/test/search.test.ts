import { describe, expect, it } from "vitest";
import {
  cleanSearchQuery,
  foldSearchText,
  searchMatchRanges,
  searchTerms,
  TranscriptSearchQuery,
  TranscriptSearchResponse,
} from "../src";

const roundTrip = <T>(schema: { parse: (v: unknown) => T }, value: T) =>
  expect(schema.parse(JSON.parse(JSON.stringify(value)))).toEqual(value);

describe("transcript search contracts", () => {
  it("round-trips a response with a tool call hit, a subagent anchor and a next page", () => {
    roundTrip(TranscriptSearchResponse, {
      query: "prisma migrate",
      hits: [
        {
          sessionId: "s1",
          threadId: "t-child",
          itemId: "i9",
          anchorItemId: "i3",
          kind: "tool_call",
          toolKind: "command",
          snippet: [
            { text: "$ npx ", match: false },
            { text: "prisma migrate", match: true },
            { text: " dev", match: false },
          ],
          ts: "2026-11-12T10:00:00.000Z",
        },
      ],
      nextCursor: "1762941600000000",
    });
    roundTrip(TranscriptSearchResponse, { query: "cart", hits: [], nextCursor: null });
  });

  it("parses query strings: trims, defaults and caps the limit", () => {
    expect(TranscriptSearchQuery.parse({ q: "  webhook retry " })).toEqual({
      q: "webhook retry",
      includeArchived: true,
      limit: 20,
    });
    expect(TranscriptSearchQuery.parse({ q: "cart", limit: "5", projectId: "p1" })).toEqual({
      q: "cart",
      includeArchived: true,
      limit: 5,
      projectId: "p1",
    });
    expect(TranscriptSearchQuery.safeParse({ q: "cart", limit: "101" }).success).toBe(false);
    expect(TranscriptSearchQuery.safeParse({ q: "   " }).success).toBe(false);
    expect(TranscriptSearchQuery.safeParse({ q: "x".repeat(201) }).success).toBe(false);
  });

  it("parses the role and archived filters and the cursor from a query string", () => {
    expect(
      TranscriptSearchQuery.parse({
        q: "deploy",
        role: "pm",
        includeArchived: "false",
        cursor: "1762941600000000",
      }),
    ).toEqual({
      q: "deploy",
      role: "pm",
      includeArchived: false,
      cursor: "1762941600000000",
      limit: 20,
    });
    expect(TranscriptSearchQuery.parse({ q: "deploy", includeArchived: "true" })).toMatchObject({
      includeArchived: true,
    });
    expect(TranscriptSearchQuery.parse({ q: "deploy", includeArchived: false })).toMatchObject({
      includeArchived: false,
    });
    for (const bad of [
      { role: "boss" },
      { includeArchived: "yes" },
      { cursor: "abc" },
      { cursor: "-1" },
      { cursor: "1".repeat(17) },
    ]) {
      const parsed = TranscriptSearchQuery.safeParse({ q: "deploy", ...bad });
      expect(parsed.success, JSON.stringify(bad)).toBe(false);
    }
  });
});

describe("transcript search terms", () => {
  it("drops control characters, NUL included, and splits on whitespace", () => {
    expect(cleanSearchQuery(" cart\u0000hook\u0007 ")).toBe("cart hook");
    expect(searchTerms("cart\u0000hook cart\tHOOK")).toEqual(["cart", "hook", "HOOK"]);
    expect(searchTerms("\u0000\u001f")).toEqual([]);
  });

  it("puts accented letters in one form, so either spelling finds the other", () => {
    expect(searchTerms("café")).toEqual(["café"]);
  });

  it("folds case and accents for any script the index folds", () => {
    expect(foldSearchText("Prêt: ÉA build")).toBe("pret: ea build");
    expect(foldSearchText("Ångström ÇA")).toBe("angstrom ca");
    expect(foldSearchText("ΟΔΟΣ")).toBe("οδοσ");
    expect(foldSearchText("useCartHook")).toBe("usecarthook");
  });

  it("finds every term's ranges in the original text, ignoring case and accents", () => {
    const text = "Prêt: ÉA build, then éa again";
    const ranges = searchMatchRanges(text, ["pret", "ea"]);
    expect(ranges.map(([a, b]) => text.slice(a, b))).toEqual(["Prêt", "ÉA", "éa"]);
    // Overlapping terms merge; a missing term adds nothing.
    expect(searchMatchRanges("carthook", ["cart", "rtho", "zzz"])).toEqual([[0, 6]]);
    // Surrogate pairs stay whole.
    const emoji = "ship 🚀 it";
    expect(searchMatchRanges(emoji, ["🚀"]).map(([a, b]) => emoji.slice(a, b))).toEqual(["🚀"]);
  });
});

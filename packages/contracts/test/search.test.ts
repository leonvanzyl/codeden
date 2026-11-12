import { describe, expect, it } from "vitest";
import { TranscriptSearchQuery, TranscriptSearchResponse } from "../src";

const roundTrip = <T>(schema: { parse: (v: unknown) => T }, value: T) =>
  expect(schema.parse(JSON.parse(JSON.stringify(value)))).toEqual(value);

describe("transcript search contracts", () => {
  it("round-trips a response with a tool call hit and a subagent anchor", () => {
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
      truncated: false,
    });
  });

  it("parses query strings: trims, defaults and caps the limit", () => {
    expect(TranscriptSearchQuery.parse({ q: "  webhook retry " })).toEqual({
      q: "webhook retry",
      limit: 20,
    });
    expect(TranscriptSearchQuery.parse({ q: "cart", limit: "5", projectId: "p1" })).toEqual({
      q: "cart",
      limit: 5,
      projectId: "p1",
    });
    expect(TranscriptSearchQuery.safeParse({ q: "cart", limit: "101" }).success).toBe(false);
    expect(TranscriptSearchQuery.safeParse({ q: "   " }).success).toBe(false);
    expect(TranscriptSearchQuery.safeParse({ q: "x".repeat(201) }).success).toBe(false);
  });
});

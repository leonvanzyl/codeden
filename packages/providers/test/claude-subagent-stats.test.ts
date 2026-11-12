import { describe, expect, it } from "vitest";
import {
  statsFromTaskNotification,
  statsFromToolUseResult,
  statsFromUsageTrailer,
} from "../src/claude/subagent-stats";

const trailer = (body: string) => `Done\nagentId: x\n<usage>${body}</usage>`;

describe("subagent figures", () => {
  it("rounds decimals in the trailer the same way as the structured result", () => {
    const fromTrailer = statsFromUsageTrailer(
      trailer("total_tokens: 12.7\ntool_uses: 1.9\nduration_ms: 99.8"),
    );
    const fromResult = statsFromToolUseResult({
      totalTokens: 12.7,
      totalToolUseCount: 1.9,
      totalDurationMs: 99.8,
    });
    expect(fromTrailer).toEqual({ totalTokens: 13, toolUses: 2, durationMs: 100 });
    expect(fromTrailer).toEqual(fromResult);
  });

  it("rejects trailer values that are not complete, finite, non-negative numbers", () => {
    expect(
      statsFromUsageTrailer(trailer("total_tokens: 12garbage\ntool_uses: -3\nduration_ms: 1e999")),
    ).toBeUndefined();
    expect(statsFromUsageTrailer(trailer("total_tokens: NaN\ntool_uses: 4"))).toEqual({
      toolUses: 4,
    });
    expect(statsFromUsageTrailer(trailer("total_tokens:\ntool_uses: 4"))).toEqual({ toolUses: 4 });
    expect(statsFromUsageTrailer("Done, no trailer")).toBeUndefined();
  });

  it("keeps only valid figures from a background task's usage", () => {
    expect(
      statsFromTaskNotification({ usage: { total_tokens: 5, tool_uses: -1, duration_ms: "9" } }),
    ).toEqual({ totalTokens: 5 });
    expect(statsFromTaskNotification({ summary: "done" })).toBeUndefined();
  });
});

import { describe, expect, it } from "vitest";
import { forkOriginText } from "@/lib/fork-origin";

describe("forkOriginText", () => {
  it("names a fork from a turn by its turn number, even when its checkpoint's differs", () => {
    // Turn 1's checkpoint failed to write, so turn 2's is checkpoint 1.
    const text = forkOriginText({ sessionId: "s1", checkpoint: 1, turnId: "b", turnNumber: 2 });
    expect(text).toEqual({
      upTo: "as they were after turn 2",
      code: "Code: its files after turn 2",
      conversation: "Conversation: up to the end of turn 2",
    });
  });

  it("names no number when the turn's number is unknown", () => {
    const text = forkOriginText({ sessionId: "s1", checkpoint: 1, turnId: "b" });
    expect(text.upTo).toBe("as they were after the turn it was forked from");
    expect(text.code).toBe("Code: its files at the end of that turn");
    expect(text.conversation).toBe("Conversation: up to the end of the turn it was forked from");
    expect(JSON.stringify(text)).not.toMatch(/turn 1/);
  });

  it("describes a whole-session fork as before", () => {
    expect(forkOriginText({ sessionId: "s1", checkpoint: 3 })).toEqual({
      upTo: "so far",
      code: "Code: its files after turn 3",
      conversation: null,
    });
    expect(forkOriginText({ sessionId: "s1", checkpoint: null }).code).toBe("Code: its branch");
    expect(forkOriginText({ sessionId: "s1", checkpoint: 0 }).code).toBe(
      "Code: its files when it started",
    );
  });
});

import { defaultSettings, type EventEnvelope } from "@codeden/contracts";
import { describe, expect, it } from "vitest";
import { describeTrigger } from "@/components/automations/meta";
import { applyTrigger, detectTrigger } from "@/components/composer/trigger";
import { countLines, normalizePatch } from "@/lib/api/mock/fixtures/patches";
import { inboxItems } from "@/lib/api/mock/fixtures/sessions";
import { MockWorld } from "@/lib/api/mock/world";
import { cronError, describeCron, nextRuns } from "@/lib/cron";
import { ageShort, duration, subagentStatsParts, until } from "@/lib/format";
import { groupInbox, inboxCounts } from "@/lib/inbox";
import { matchesCombo } from "@/lib/shortcuts";
import { applyDomainEvent } from "@/lib/snapshot-reducer";
import { inQuietHours, shouldReadAloud, stripForSpeech } from "@/lib/voice/speech-text";

describe("applyDomainEvent", () => {
  it("upserts sessions and inbox items and ignores stale events", () => {
    const snap = new MockWorld().snapshot;
    const session = { ...snap.sessions[0], title: "Renamed" } as (typeof snap.sessions)[number];
    const env = {
      seq: snap.seq + 1,
      ts: new Date().toISOString(),
      sessionId: null,
      type: "session.updated",
      payload: { session },
    } as EventEnvelope;
    const next = applyDomainEvent(snap, env);
    expect(next.sessions[0]?.title).toBe("Renamed");
    expect(next.seq).toBe(snap.seq + 1);
    expect(applyDomainEvent(next, env)).toBe(next);
  });
});

describe("composer triggers", () => {
  it("detects @ mentions after whitespace", () => {
    expect(detectTrigger("look at @src/ch", 15)).toEqual({
      kind: "mention",
      query: "src/ch",
      start: 8,
    });
    expect(detectTrigger("email@x", 7)).toBeNull();
  });
  it("detects / commands only at the start", () => {
    expect(detectTrigger("/pl", 3)).toEqual({ kind: "command", query: "pl", start: 0 });
    expect(detectTrigger("a /pl", 5)).toBeNull();
  });
  it("replaces the trigger and moves the caret", () => {
    const t = detectTrigger("see @us", 7);
    if (!t) throw new Error("expected trigger");
    expect(applyTrigger("see @us", 7, t, "@src/useCart.ts")).toEqual({
      text: "see @src/useCart.ts ",
      caret: 20,
    });
  });
});

describe("read aloud", () => {
  it("strips markdown and code", () => {
    const md =
      "## Done\n\nFixed **the flake** in `useCart`.\n\n```ts\nconst x = 1;\n```\n\n- See [PR](https://x.y)";
    expect(stripForSpeech(md)).toBe("Done Fixed the flake in useCart. See PR");
  });
  it("cuts long text to a few sentences", () => {
    expect(stripForSpeech("One. Two. Three. Four. Five.", 2)).toBe("One. Two.");
  });
  it("handles quiet hours across midnight", () => {
    const q = { start: "22:00", end: "07:00" };
    expect(inQuietHours(q, new Date(2026, 10, 7, 23, 30))).toBe(true);
    expect(inQuietHours(q, new Date(2026, 10, 7, 6, 59))).toBe(true);
    expect(inQuietHours(q, new Date(2026, 10, 7, 12, 0))).toBe(false);
  });
  it("respects enabled, focus and quiet hours", () => {
    const s = defaultSettings();
    const noon = new Date(2026, 10, 7, 12, 0);
    expect(shouldReadAloud(s, { now: noon, focused: false })).toBe(false);
    s.voice.readAloud.enabled = true;
    expect(shouldReadAloud(s, { now: noon, focused: true })).toBe(true);
    s.voice.readAloud.onlyWhenUnfocused = true;
    expect(shouldReadAloud(s, { now: noon, focused: true })).toBe(false);
    s.voice.readAloud.quietHours = { start: "11:00", end: "13:00" };
    expect(shouldReadAloud(s, { now: noon, focused: false })).toBe(false);
  });
});

describe("inbox grouping", () => {
  it("puts asks first and drops empty groups", () => {
    const groups = groupInbox(inboxItems);
    expect(groups.map((g) => g.id)).toEqual([
      "approval",
      "question",
      "pr_review",
      "run_failed",
      "triage",
      "automation_result",
    ]);
    expect(groupInbox(inboxItems, "problems").map((g) => g.id)).toEqual(["run_failed"]);
  });
  it("counts tabs including conflicts", () => {
    expect(inboxCounts(inboxItems, 1)).toEqual({ all: 7, asks: 4, reviews: 2, problems: 1 });
  });
  it("shows worktrees that couldn't be removed with the problems", () => {
    const base = inboxItems.find((i) => i.kind === "run_failed");
    if (!base) throw new Error("fixture");
    const items = [...inboxItems, { ...base, id: "cleanup", kind: "cleanup_failed" as const }];
    expect(groupInbox(items, "problems").map((g) => g.id)).toEqual([
      "run_failed",
      "cleanup_failed",
    ]);
  });
});

describe("shortcuts", () => {
  const key = (k: Partial<KeyboardEvent>) => ({
    key: "",
    code: "",
    ctrlKey: false,
    metaKey: false,
    shiftKey: false,
    altKey: false,
    ...k,
  });
  it("matches modifier combos", () => {
    expect(matchesCombo(key({ key: "k", ctrlKey: true }), "mod+k")).toBe(true);
    expect(matchesCombo(key({ key: "k" }), "mod+k")).toBe(false);
    expect(matchesCombo(key({ key: "L", ctrlKey: true, shiftKey: true }), "mod+shift+l")).toBe(
      true,
    );
    expect(matchesCombo(key({ key: "¡", code: "Digit1", altKey: true }), "alt+1")).toBe(true);
    expect(matchesCombo(key({ key: "\\", code: "Backslash", ctrlKey: true }), "mod+\\")).toBe(true);
  });
});

describe("formatting", () => {
  const now = Date.parse("2026-11-07T12:00:00.000Z");
  it("formats ages, durations and upcoming times", () => {
    expect(ageShort("2026-11-07T11:57:00.000Z", now)).toBe("3m");
    expect(duration(96_000)).toBe("1m 36s");
    expect(duration(4200)).toBe("4.2s");
    expect(until("2026-11-07T12:38:00.000Z", now)).toBe("in 38 min");
  });
  it("formats a subagent's reported figures, only those present", () => {
    expect(subagentStatsParts({ totalTokens: 48_213, toolUses: 23, durationMs: 72_000 })).toEqual([
      "48.2k tokens",
      "23 tool calls",
      "1m 12s",
    ]);
    expect(subagentStatsParts({ totalTokens: 1_250_000, toolUses: 1 })).toEqual([
      "1.3M tokens",
      "1 tool call",
    ]);
    expect(subagentStatsParts({ totalTokens: 640, durationMs: 4200 })).toEqual([
      "640 tokens",
      "4.2s",
    ]);
    expect(subagentStatsParts({})).toEqual([]);
    expect(subagentStatsParts(undefined)).toEqual([]);
  });
  it("describes automation triggers", () => {
    expect(describeTrigger({ type: "cron", expression: "0 9 * * 1" })).toBe(
      "Every Monday at 09:00",
    );
    expect(describeTrigger({ type: "cron", expression: "0 6 * * *" })).toBe("Every day at 06:00");
    expect(describeTrigger({ type: "event", event: "pr.opened" })).toBe(
      "When a pull request is opened",
    );
    expect(describeTrigger({ type: "manual" })).toBe("Only when you run it");
  });
  it("describes cron expressions in plain English", () => {
    expect(describeCron("*/15 * * * *")).toBe("Every 15 minutes");
    expect(describeCron("30 * * * *")).toBe("Every hour at :30");
    expect(describeCron("0 */6 * * *")).toBe("Every 6 hours at :00");
    expect(describeCron("30 9 * * 1-5")).toBe("Every weekday at 09:30");
    expect(describeCron("0 3 * * 1,4")).toBe("Mondays and Thursdays at 03:00");
    expect(describeCron("0 4 1 * *")).toBe("Monthly on the 1st at 04:00");
    expect(describeCron("0 4 1,15 * *")).toBe("Monthly on the 1st and 15th at 04:00");
    expect(describeCron("0 4 1 1 *")).toBe("Custom schedule");
  });
  it("validates cron expressions and previews the next runs", () => {
    expect(cronError("0 3 * * 1")).toBeNull();
    expect(cronError("not cron")).not.toBeNull();
    const runs = nextRuns("0 3 * * *", "UTC", 2);
    expect(runs).toHaveLength(2);
    expect(runs[0]?.getUTCHours()).toBe(3);
    expect(nextRuns("bad", "UTC", 2)).toEqual([]);
  });
});

describe("fixture patches", () => {
  it("recomputes hunk headers", () => {
    const patch = normalizePatch("--- a/x\n+++ b/x\n@@ -1,9 +1,9 @@\n a\n-b\n+c\n\n d\n");
    expect(patch).toContain("@@ -1,4 +1,4 @@");
    expect(countLines(patch)).toEqual({ additions: 1, deletions: 1 });
  });
});

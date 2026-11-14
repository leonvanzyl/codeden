import type { Session } from "@codeden/contracts";
import { describe, expect, it } from "vitest";
import { sessions as fixtureSessions } from "@/lib/api/mock/fixtures/sessions";
import { forkOriginText, isHandoff, relatedSessions } from "@/lib/fork-origin";

const base = fixtureSessions.find((s) => s.role === "agent" && s.projectId) as Session;
const at = (minute: number) => `2026-11-14T10:${String(minute).padStart(2, "0")}:00.000Z`;
const session = (id: string, patch: Partial<Session> = {}): Session => ({
  ...base,
  id,
  projectId: "p1",
  forkedFrom: null,
  createdAt: at(0),
  ...patch,
});

describe("relatedSessions", () => {
  const source = session("src");
  const fork = session("fork", {
    forkedFrom: { sessionId: "src", checkpoint: 2 },
    createdAt: at(1),
  });
  const sibling = session("sib", {
    forkedFrom: { sessionId: "src", checkpoint: 2 },
    createdAt: at(2),
  });
  const handoff = session("hand", {
    forkedFrom: { sessionId: "src", checkpoint: 3, kind: "handoff" },
    createdAt: at(3),
  });
  const grandchild = session("grand", { forkedFrom: { sessionId: "fork", checkpoint: 1 } });
  const unrelated = session("other");
  const elsewhere = session("elsewhere", {
    projectId: "p2",
    forkedFrom: { sessionId: "src", checkpoint: 1 },
  });
  const all = [source, fork, sibling, handoff, grandchild, unrelated, elsewhere];
  const names = (s: Session) => relatedSessions(s, all).map((r) => `${r.relation}:${r.session.id}`);

  it("lists a fork's source, its own forks, then its siblings newest first", () => {
    expect(names(fork)).toEqual(["source:src", "fork:grand", "sibling:hand", "sibling:sib"]);
  });

  it("lists a source's forks and handoffs newest first, from its own project only", () => {
    expect(names(source)).toEqual(["handoff:hand", "fork:sib", "fork:fork"]);
  });

  it("lists nothing for a session with no relatives or no project", () => {
    expect(names(unrelated)).toEqual([]);
    expect(relatedSessions({ ...fork, projectId: null }, all)).toEqual([]);
  });
});

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

  it("says a handoff's conversation is a new one, opened with a brief", () => {
    const origin = { sessionId: "s1", checkpoint: 2, kind: "handoff" as const };
    expect(isHandoff(origin)).toBe(true);
    expect(isHandoff({ sessionId: "s1", checkpoint: 2 })).toBe(false);
    expect(forkOriginText(origin)).toEqual({
      upTo: "so far",
      code: "Code: its files after turn 2",
      conversation: "Conversation: a new one, opened with a brief of its work",
    });
  });
});

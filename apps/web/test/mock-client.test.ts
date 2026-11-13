import { TranscriptSearchResponse, type UiServerMessage } from "@codeden/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createMockClient } from "@/lib/api/mock";
import { transcriptFromSnapshot } from "@/lib/transcript/reducer";

describe("mock client", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("plays an approval continuation and resolves the inbox item", async () => {
    const client = createMockClient();
    const messages: UiServerMessage[] = [];
    client.subscribe(0, (m) => messages.push(m));
    await client.respond("s-checkout", "req-push", { kind: "approval", decision: "allow_once" });
    await vi.advanceTimersByTimeAsync(20_000);

    const snapP = client.getSnapshot();
    const sessionP = client.getSessionSnapshot("s-checkout");
    await vi.advanceTimersByTimeAsync(500);
    const [snap, session] = await Promise.all([snapP, sessionP]);

    const t = transcriptFromSnapshot(session);
    expect(t.items["ck-approval"]?.item).toMatchObject({
      status: "completed",
      decision: "allow_once",
    });
    expect(t.turns["ck-turn-2"]?.status).toBe("completed");
    expect(snap.inbox.find((i) => i.id === "ib-approval")?.status).toBe("resolved");
    expect(snap.sessions.find((s) => s.id === "s-checkout")?.status).toBe("idle");
    expect(messages.some((m) => m.type === "events")).toBe(true);
  });

  it("reports a conflict instead of starting duplicate work", async () => {
    const client = createMockClient();
    const result = await client.startSession({
      projectId: "p-storefront",
      input: { text: "Audit" },
      workKey: "automation:security-audit",
    });
    expect(result.status).toBe("conflict");
    if (result.status === "conflict") expect(result.existing[0]?.sessionId).toBe("s-audit");
  });

  it("starts a session and runs a scripted turn", async () => {
    const client = createMockClient();
    const result = await client.startSession({
      projectId: "p-notes",
      input: { text: "Add a search command" },
      workKey: "request:search",
    });
    expect(result.status).toBe("started");
    if (result.status !== "started") return;
    await vi.advanceTimersByTimeAsync(30_000);
    const p = client.getSessionSnapshot(result.sessionId);
    await vi.advanceTimersByTimeAsync(500);
    const t = transcriptFromSnapshot(await p);
    const kinds = Object.values(t.items).map((e) => e.item.kind);
    expect(kinds).toEqual(
      expect.arrayContaining([
        "user_message",
        "reasoning",
        "tool_call",
        "assistant_message",
        "followups",
      ]),
    );
  });

  it("validates settings patches", async () => {
    const client = createMockClient();
    const p = client.updateSettings({ voice: { readAloud: { enabled: false } } });
    const settings = await p;
    expect(settings.voice.readAloud.enabled).toBe(false);
    expect(settings.voice.dictation.engine).toBe("browser");
  });

  it("searches transcripts like the server: every term, highlighted, case-insensitively", async () => {
    const client = createMockClient();
    const p = client.searchTranscripts({ q: "WEBHOOKS retried" });
    const short = client.searchTranscripts({ q: "pr" });
    await vi.advanceTimersByTimeAsync(500);
    const result = TranscriptSearchResponse.parse(await p);
    const hit = result.hits.find((h) => h.sessionId === "s-webhooks");
    expect(hit).toMatchObject({ kind: "user_message", anchorItemId: hit?.itemId });
    expect(hit?.snippet.filter((s) => s.match).map((s) => s.text.toLowerCase())).toEqual(
      expect.arrayContaining(["webhooks", "retried"]),
    );
    expect((await short).hits).toEqual([]);
  });

  it("filters transcript search by role and archived state, newest first, a page at a time", async () => {
    const client = createMockClient();
    const all = client.searchTranscripts({ q: "the", limit: 3 });
    const pms = client.searchTranscripts({ q: "the", role: "pm" });
    await vi.advanceTimersByTimeAsync(500);
    const first = TranscriptSearchResponse.parse(await all);
    expect(first.hits).toHaveLength(3);
    const times = first.hits.map((h) => h.ts);
    expect(times).toEqual([...times].sort().reverse());
    expect(first.nextCursor).not.toBeNull();
    const next = client.searchTranscripts({ q: "the", limit: 3, cursor: first.nextCursor ?? "" });
    await vi.advanceTimersByTimeAsync(500);
    const second = TranscriptSearchResponse.parse(await next);
    const ids = (r: typeof first) => r.hits.map((h) => `${h.sessionId}/${h.itemId}`);
    expect(ids(second).some((id) => ids(first).includes(id))).toBe(false);

    const snapshot = client.getSnapshot();
    await vi.advanceTimersByTimeAsync(500);
    const roleOf = new Map((await snapshot).sessions.map((s) => [s.id, s.role]));
    const pmHits = TranscriptSearchResponse.parse(await pms).hits;
    expect(pmHits.every((h) => roleOf.get(h.sessionId) === "pm")).toBe(true);
  });
});

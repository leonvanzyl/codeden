import type { RawEventEnvelope, Role, Session } from "@codeden/contracts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { deriveNotices } from "../src/services/orchestration/notices";
import { sampleSession } from "./helpers";
import { type Harness, startHarness, waitUntil } from "./support/harness";

const ts = "2026-11-10T10:00:00.000Z";

/** Work a PM started for the orchestrator reports back to it (§8.2 steps 5-6). */
describe("reportTo: orchestrator", () => {
  const forOrchestrator: Session = {
    ...sampleSession,
    id: "a1",
    projectId: "p1",
    rootThreadId: "t1",
    startedBy: { kind: "pm", id: "pm1", reportTo: "orchestrator" },
    result: { outcome: "success", summary: "Audit done: 2 findings", at: ts },
  };
  const unfinished: Session = { ...forOrchestrator, id: "a2", result: null };
  const pmOnly: Session = { ...forOrchestrator, id: "a3", startedBy: { kind: "pm", id: "pm1" } };
  const sessions = new Map([forOrchestrator, unfinished, pmOnly].map((s) => [s.id, s]));
  let seq = 0;
  const ev = (type: string, sessionId: string | null, payload: unknown): RawEventEnvelope => ({
    seq: ++seq,
    sessionId,
    type,
    payload,
    ts,
  });
  const turnDone = (id: string, turnId: string) =>
    ev("agent.turn.completed", id, { type: "turn.completed", threadId: "t1", turnId });
  const failed = (id: string) =>
    ev("inbox.created", null, {
      item: { id: `f-${id}`, kind: "run_failed", title: "Run failed", body: "boom", sessionId: id },
    });

  it("also tells the orchestrator when the work is finished or failed", () => {
    const out = deriveNotices(
      [
        turnDone("a1", "u1"),
        turnDone("a2", "u2"),
        turnDone("a3", "u3"),
        failed("a2"),
        failed("a3"),
      ],
      { session: (id) => sessions.get(id), finalMessage: () => "Done" },
    );
    expect(out.map((d) => [d.notice.id, d.notice.target, d.wake])).toEqual([
      ["session.finished:a1:u1", "pm", true],
      ["session.finished:orchestrator:a1:2026-11-10T10:00:00.000Z", "orchestrator", true],
      ["session.finished:a2:u2", "pm", true],
      ["session.finished:a3:u3", "pm", true],
      ["session.failed:f-a2", "pm", true],
      ["session.failed:orchestrator:f-a2", "orchestrator", true],
      ["session.failed:f-a3", "pm", true],
    ]);
    const toOrchestrator = out[1]?.notice;
    expect(toOrchestrator?.type === "session.finished" && toOrchestrator.data.summary).toBe(
      "Audit done: 2 findings",
    );
  });

  describe("through the PM's start_session", () => {
    let h: Harness;
    const PM = "pm-report";
    const call = (role: Role, name: string, args: unknown, sessionId: string, projectId: string) =>
      h.server.services.tools.call(name, args, {
        role,
        sessionId,
        projectId,
        caller: "mcp",
        signal: new AbortController().signal,
      });

    beforeAll(async () => {
      h = await startHarness({ orchestration: { wake: { debounceMs: 50, maxWaitMs: 300 } } });
    });
    afterAll(async () => {
      await h?.close();
    });

    it("wakes the orchestrator with the result once the agent finishes", async () => {
      const res = await call(
        "pm",
        "start_session",
        {
          prompt: "Run the audit",
          purpose: "Security audit",
          workKey: "request:audit",
          reportTo: "orchestrator",
        },
        PM,
        h.projectId,
      );
      const started = JSON.parse(res.text) as { status: string; sessionId: string };
      expect(started.status).toBe("started");
      const id = started.sessionId;
      await waitUntil(async () =>
        (await h.detail(id)).session.status === "idle" ? true : undefined,
      );
      expect((await h.detail(id)).session.startedBy).toEqual({
        kind: "pm",
        id: PM,
        reportTo: "orchestrator",
      });
      const { notices } = h.server.services.orchestration;
      // A turn without a result is the PM's business only.
      expect(notices.list({ target: "orchestrator" })).toEqual([]);

      await call(
        "agent",
        "finish",
        { outcome: "success", summary: "No findings" },
        id,
        h.projectId,
      );
      await call("pm", "message_session", { sessionId: id, text: "Thanks" }, PM, h.projectId);
      const reported = await waitUntil(() =>
        notices.list({ target: "orchestrator" }).find((n) => n.type === "session.finished"),
      );
      expect(reported.type === "session.finished" && reported.data.summary).toBe("No findings");
      // The orchestrator is woken with it.
      const orchestrator = await waitUntil(() =>
        h.server.services.orchestration.roles.find("orchestrator", null),
      );
      await waitUntil(() =>
        notices.list({ target: "orchestrator" }).every((n) => n.deliveredAt) ? true : undefined,
      );
      expect(orchestrator.role).toBe("orchestrator");
    });
  });
});

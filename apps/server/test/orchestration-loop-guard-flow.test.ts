import {
  type ItemRecord,
  type Role,
  StartSessionResponse,
  ThreadItemsPage,
} from "@codeden/contracts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type Harness, startHarness, waitUntil } from "./support/harness";

describe("orchestration loop guard (§8.2) with a real runner", () => {
  let h: Harness;
  let pmId: string;
  let orchestratorId: string;

  const call = (role: Role, name: string, args: unknown, sessionId: string) =>
    h.server.services.tools.call(name, args, {
      role,
      sessionId,
      projectId: role === "pm" ? h.projectId : null,
      caller: "mcp",
      signal: new AbortController().signal,
    });
  const items = async (sessionId: string): Promise<ItemRecord[]> => {
    const d = await h.detail(sessionId);
    if (!d.session.rootThreadId) return [];
    const res = await h.api(
      "GET",
      `/sessions/${sessionId}/threads/${d.session.rootThreadId}/items?limit=500`,
    );
    return ThreadItemsPage.parse(res.body).items;
  };
  const userTexts = async (sessionId: string) =>
    (await items(sessionId)).flatMap((r) =>
      r.item.kind === "user_message" ? [r.item.input.text] : [],
    );
  const idle = (id: string) =>
    waitUntil(async () => ((await h.detail(id)).session.status === "idle" ? true : undefined));
  const received = (id: string, text: string) =>
    waitUntil(async () => ((await userTexts(id)).some((t) => t.includes(text)) ? true : undefined));
  const wakesOf = async (id: string) =>
    (await userTexts(id)).filter((t) => t.includes("Automatic wake-up")).length;
  const pmMessage = (text: string) =>
    call("orchestrator", "message_pm", { projectId: h.projectId, text }, orchestratorId);

  beforeAll(async () => {
    h = await startHarness({
      // Two wakes per minute, so a couple of session reports fill the PM's window.
      orchestration: { wake: { debounceMs: 50, maxWaitMs: 300, maxWakes: 2, windowMs: 60_000 } },
    });
    const res = await h.api("POST", `/orchestration/projects/${h.projectId}/pm`);
    pmId = (res.body as { session: { id: string } }).session.id;
    await idle(pmId);
  });
  afterAll(async () => {
    await h?.close();
  });

  it("delivers a user's request to a PM that was only woken by its own sessions' reports", async () => {
    // The PM's own agent session reports twice: each finished turn wakes the PM.
    const started = StartSessionResponse.parse(
      (
        await h.api("POST", "/sessions", {
          projectId: h.projectId,
          provider: "fake",
          purpose: "Background work",
          workKey: "issue:11",
          startedBy: { kind: "pm", id: pmId },
          input: { text: "work" },
        })
      ).body,
    );
    if (started.status !== "started") throw new Error("expected started");
    await waitUntil(async () => ((await wakesOf(pmId)) >= 1 ? true : undefined), 30_000);
    await idle(started.sessionId);
    await idle(pmId);
    await h.api("POST", `/sessions/${started.sessionId}/messages`, { input: { text: "more" } });
    await waitUntil(async () => ((await wakesOf(pmId)) >= 2 ? true : undefined), 30_000);
    await idle(pmId);
    // The PM's notice wakes are at their limit: further reports are batched for later.
    expect(h.server.services.orchestration.wakes.allowed(`pm:${h.projectId}`)).toBe(false);

    // The user asks the orchestrator, which hands the task to the PM in that turn.
    const sent = await h.api("POST", "/orchestration/orchestrator/messages", {
      input: { text: "Assign the login bug to the project" },
    });
    orchestratorId = (sent.body as { sessionId: string }).sessionId;
    await received(orchestratorId, "Assign the login bug to the project");
    await idle(orchestratorId);
    const res = await pmMessage("Please fix the login bug");
    expect(res.isError).toBe(false);
    expect(res.text).toContain("Message sent to the PM");
    expect(res.text).not.toContain("loop guard");
    await received(pmId, "Please fix the login bug");
    await idle(pmId);
    // The user's request reset the PM's counts: its sessions' next reports wake it again.
    expect(h.server.services.orchestration.wakes.allowed(`pm:${h.projectId}`)).toBe(true);
  });

  it("paces an orchestrator <-> PM ping-pong without the user, queueing instead of refusing", async () => {
    const o = h.server.services.orchestration;
    // The PM writes to the orchestrator, which is woken automatically (no user in this turn).
    await call("pm", "message_orchestrator", { text: "Need a decision on issue 11" }, pmId);
    await received(orchestratorId, "Need a decision on issue 11");
    await idle(orchestratorId);

    for (const text of ["Decision: go ahead", "Also update the docs"]) {
      const res = await pmMessage(text);
      expect(res.text).toContain("Message sent to the PM");
      await received(pmId, text);
      await idle(pmId);
    }
    // A third automatic message in the window is held back, not refused.
    const held = await pmMessage("And add a changelog entry");
    expect(held.isError).toBe(false);
    expect(held.text).toContain("Queued: CodeDen delivers this to the PM");
    expect(held.text).toContain("do not send it again");
    expect(held.text).not.toMatch(/ask the user|wait a few minutes|try again later/i);
    // So is a question, which then returns at once instead of waiting for the PM.
    const asked = await call(
      "orchestrator",
      "ask_pm",
      { projectId: h.projectId, question: "Is the changelog done?" },
      orchestratorId,
    );
    expect(asked.isError).toBe(false);
    expect(asked.text).toMatch(/^pending: Queued:/);
    expect(asked.text).not.toMatch(/ask the user/i);
    const waiting = o.notices.undelivered("pm", h.projectId);
    expect(waiting.map((n) => n.type)).toEqual(["orchestrator.message", "orchestrator.message"]);
    expect(o.loops.relays.isPending(`pm:${h.projectId}`)).toBe(true);

    // The PM's next wake (here: a report from its session) delivers the held messages.
    o.notify({
      id: "session.failed:loop-guard-test",
      type: "session.failed",
      projectId: h.projectId,
      target: "pm",
      sessionId: null,
      title: "Failed: docs",
      data: {
        sessionId: "s-docs",
        workKey: "issue:12",
        purpose: "Docs",
        startedBy: { kind: "pm", id: pmId },
        error: "boom",
      },
    });
    await received(pmId, "And add a changelog entry");
    const wake = (await userTexts(pmId)).find((t) => t.includes("And add a changelog entry"));
    expect(wake).toContain("Is the changelog done?");
    expect(o.notices.undelivered("pm", h.projectId)).toEqual([]);
    // The held question is answered from that turn, as a message to the orchestrator.
    await waitUntil(() =>
      o.notices
        .list({ target: "orchestrator" })
        .some(
          (n) => n.type === "pm.message" && n.data.text.startsWith("Answer to your earlier ask_pm"),
        ),
    );
  });
});

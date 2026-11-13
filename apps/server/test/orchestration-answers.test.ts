import { InboxItem, type Role, StartSessionResponse } from "@codeden/contracts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { renderNotices } from "../src/services/orchestration/digest";
import { type Harness, startHarness, waitUntil } from "./support/harness";

/** A PM answers the questions of its project's agent sessions (§8.2 step 5). */
describe("answer_question", () => {
  let h: Harness;
  const PM = "pm-answers";

  const call = (role: Role, name: string, args: unknown, sessionId: string, projectId: string) =>
    h.server.services.tools.call(name, args, {
      role,
      sessionId,
      projectId,
      caller: "mcp",
      signal: new AbortController().signal,
    });

  /** An agent session the PM started, idle after its first turn. */
  const agent = async (startedBy: { kind: string; id?: string }, text = "hello") => {
    const res = await h.api("POST", "/sessions", {
      projectId: h.projectId,
      provider: "fake",
      purpose: `Work ${Math.random()}`,
      startedBy,
      input: { text },
    });
    const started = StartSessionResponse.parse(res.body);
    if (started.status !== "started") throw new Error(`not started: ${started.status}`);
    const want = text.includes("[approval]") ? "waiting" : "idle";
    await waitUntil(async () =>
      (await h.detail(started.sessionId)).session.status === want ? true : undefined,
    );
    return started.sessionId;
  };

  const openItem = (sessionId: string, kind: "question" | "approval") =>
    waitUntil(async () => {
      const items = ((await h.api("GET", `/inbox?sessionId=${sessionId}`)).body as unknown[]).map(
        (i) => InboxItem.parse(i),
      );
      return items.find((i) => i.kind === kind && i.status === "open");
    });

  const inboxItem = (id: string) => h.server.services.inbox.get(id);

  beforeAll(async () => {
    h = await startHarness({ askUserWaitMs: 3_000 });
  }, 60_000);
  afterAll(async () => {
    await h?.close();
  });

  it("answers a question its agent is waiting on: the agent gets it and the inbox item closes", async () => {
    const id = await agent({ kind: "pm", id: PM });
    const asking = call("agent", "ask_user", { question: "Zod or Valibot?" }, id, h.projectId);
    const item = await openItem(id, "question");

    const res = await call(
      "pm",
      "answer_question",
      { inboxItemId: item.id, answer: "Zod: the project already uses it" },
      PM,
      h.projectId,
    );
    expect(res.isError).toBe(false);
    const asked = await asking;
    expect(asked.text).toContain("Your project manager answered");
    expect(asked.text).toContain("Zod: the project already uses it");
    const closed = inboxItem(item.id);
    expect(closed.status).toBe("resolved");
    expect(closed.resolution).toMatchObject({ decidedBy: "pm" });
  });

  it("answers a question that already went to the inbox: it arrives as a message from the PM", async () => {
    const id = await agent({ kind: "automation", id: "nightly" });
    const pending = await call("agent", "ask_user", { question: "Ship it?" }, id, h.projectId);
    expect(pending.text).toMatch(/^pending/);
    const item = await openItem(id, "question");

    await call("pm", "answer_question", { inboxItemId: item.id, answer: "Yes" }, PM, h.projectId);
    expect(inboxItem(item.id).status).toBe("resolved");
    // The Fake provider echoes the message it received.
    await waitUntil(async () => {
      const snap = (await h.api("GET", `/sessions/${id}/snapshot`)).body as {
        items: Array<{ item: { kind: string; text?: string; input?: { from?: string } } }>;
      };
      return snap.items.some(
        (i) =>
          i.item.kind === "user_message" &&
          i.item.input?.from === "pm" &&
          snap.items.some(
            (j) => j.item.kind === "assistant_message" && j.item.text?.includes("Q: Ship it?"),
          ),
      )
        ? true
        : undefined;
    });
  });

  it("refuses approvals, other projects', user-started and answered items", async () => {
    const answer = (inboxItemId: string, projectId = h.projectId) =>
      call("pm", "answer_question", { inboxItemId, answer: "yes" }, PM, projectId);

    const gated = await agent({ kind: "pm", id: PM }, "go [approval]");
    const approval = await openItem(gated, "approval");
    const refusedApproval = await answer(approval.id);
    expect(refusedApproval.isError).toBe(true);
    expect(refusedApproval.text).toMatch(/approval/i);
    expect(inboxItem(approval.id).status).toBe("open");

    const id = await agent({ kind: "pm", id: PM });
    void call("agent", "ask_user", { question: "Which port?" }, id, h.projectId);
    const question = await openItem(id, "question");
    const otherProject = await answer(question.id, "another-project");
    expect(otherProject.isError).toBe(true);
    expect(inboxItem(question.id).status).toBe("open");

    const mine = await agent({ kind: "user" });
    void call("agent", "ask_user", { question: "Which colour?" }, mine, h.projectId);
    const users = await openItem(mine, "question");
    const refusedUser = await answer(users.id);
    expect(refusedUser.isError).toBe(true);
    expect(refusedUser.text).toMatch(/user started/i);
    expect(inboxItem(users.id).status).toBe("open");

    expect((await answer(question.id)).isError).toBe(false);
    const again = await answer(question.id);
    expect(again.isError).toBe(true);
    expect(again.text).toMatch(/already/i);
    expect((await answer("inbox:nope")).isError).toBe(true);
  });

  it("tells the PM which inbox item a question is and that it can answer it", () => {
    const text = renderNotices([
      {
        id: "session.needs_input:inbox:s1:ask-1",
        type: "session.needs_input",
        projectId: "p1",
        target: "pm",
        sessionId: "s1-full-session-id",
        title: "Needs input: Fix typo",
        createdAt: "2026-11-10T10:00:00.000Z",
        deliveredAt: null,
        data: {
          sessionId: "s1-full-session-id",
          workKey: "issue:3",
          purpose: "Fix typo",
          startedBy: { kind: "pm" },
          inboxItemId: "inbox:s1:ask-1",
          kind: "question",
          question: "Zod or Valibot?",
        },
      },
    ]);
    expect(text).toContain("inbox:s1:ask-1");
    expect(text).toContain("answer_question");
  });
});

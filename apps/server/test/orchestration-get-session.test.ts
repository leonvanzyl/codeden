import { type Role, type Session, StartSessionResponse } from "@codeden/contracts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sampleSession } from "./helpers";
import { type Harness, startHarness, waitUntil } from "./support/harness";

/** The PM reads what one of its sessions said and is waiting on (§8.4). */
describe("get_session and session id prefixes", () => {
  let h: Harness;
  const PM = "pm-get";

  const call = (role: Role, name: string, args: unknown, sessionId: string, projectId: string) =>
    h.server.services.tools.call(name, args, {
      role,
      sessionId,
      projectId,
      caller: "mcp",
      signal: new AbortController().signal,
    });

  beforeAll(async () => {
    h = await startHarness({ askUserWaitMs: 60_000 });
  });
  afterAll(async () => {
    await h?.close();
  });

  it("returns the last message, what the session waits on with inbox ids, and its result", async () => {
    const res = await h.api("POST", "/sessions", {
      projectId: h.projectId,
      provider: "fake",
      purpose: "Pick a validator",
      startedBy: { kind: "pm", id: PM },
      input: { text: "Which validator should we use?" },
    });
    const started = StartSessionResponse.parse(res.body);
    if (started.status !== "started") throw new Error(started.status);
    const id = started.sessionId;
    await waitUntil(async () =>
      (await h.detail(id)).session.status === "idle" ? true : undefined,
    );
    void call(
      "agent",
      "ask_user",
      { question: "Zod or Valibot?", options: [{ label: "Zod" }, { label: "Valibot" }] },
      id,
      h.projectId,
    );
    await waitUntil(() =>
      h.server.services.inbox.list({ sessionId: id }).some((i) => i.kind === "question")
        ? true
        : undefined,
    );
    await call(
      "agent",
      "finish",
      { outcome: "partial", summary: "Waiting on a choice" },
      id,
      h.projectId,
    );

    // A unique prefix (as the digest shows it) is enough.
    const out = await call("pm", "get_session", { sessionId: id.slice(0, 8) }, PM, h.projectId);
    expect(out.isError).toBe(false);
    const detail = JSON.parse(out.text);
    expect(detail.session).toMatchObject({ id, purpose: "Pick a validator" });
    expect(detail.session.result).toMatchObject({ outcome: "partial" });
    expect(detail.lastMessage).toContain("Which validator should we use?");
    expect(detail.waitingOn).toHaveLength(1);
    const [question] = detail.waitingOn;
    expect(question).toMatchObject({
      kind: "question",
      questions: [{ question: "Zod or Valibot?", options: ["Zod", "Valibot"] }],
    });
    expect(h.server.services.inbox.get(question.inboxItemId).sessionId).toBe(id);

    // message_session takes the prefix too.
    const sent = await call(
      "pm",
      "message_session",
      { sessionId: id.slice(0, 8), text: "Use Zod" },
      PM,
      h.projectId,
    );
    expect(sent.isError).toBe(false);
  });

  it("refuses an ambiguous prefix, a short one, and other projects' sessions", async () => {
    const twin = (suffix: string): Session => ({
      ...sampleSession,
      id: `abcd1234-0000-4000-8000-00000000000${suffix}`,
      projectId: h.projectId,
      status: "idle",
    });
    h.server.services.store.append(
      ["1", "2"].map((s) => ({
        type: "session.created" as const,
        sessionId: twin(s).id,
        payload: { session: twin(s) },
      })),
    );
    const ambiguous = await call("pm", "get_session", { sessionId: "abcd1234" }, PM, h.projectId);
    expect(ambiguous.isError).toBe(true);
    expect(ambiguous.text).toMatch(/more than one/i);
    const exact = await call("pm", "get_session", { sessionId: twin("1").id }, PM, h.projectId);
    expect(exact.isError).toBe(false);
    const short = await call("pm", "get_session", { sessionId: "abc" }, PM, h.projectId);
    expect(short.isError).toBe(true);
    const elsewhere = await call(
      "pm",
      "get_session",
      { sessionId: twin("1").id },
      PM,
      "another-project",
    );
    expect(elsewhere.isError).toBe(true);
  });
});

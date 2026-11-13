import { type Role, ThreadItemsPage, type UserInput } from "@codeden/contracts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type Harness, startHarness, waitUntil } from "./support/harness";

describe("messages from a PM or the orchestrator record their sender", () => {
  let h: Harness;

  beforeAll(async () => {
    h = await startHarness();
  }, 60_000);
  afterAll(async () => {
    await h?.close();
  });

  const call = (role: Role, name: string, args: unknown, projectId: string | null) =>
    h.server.services.tools.call(name, args, {
      role,
      sessionId: `${role}-test`,
      projectId,
      caller: "mcp",
      signal: new AbortController().signal,
    });

  /** The inputs of a session's persisted user messages, oldest first. */
  const userInputs = async (sessionId: string): Promise<UserInput[]> => {
    const d = await h.detail(sessionId);
    if (!d.session.rootThreadId) return [];
    const res = await h.api(
      "GET",
      `/sessions/${sessionId}/threads/${d.session.rootThreadId}/items?limit=500`,
    );
    return ThreadItemsPage.parse(res.body).items.flatMap((r) =>
      r.item.kind === "user_message" ? [r.item.input] : [],
    );
  };

  it("persists a PM's message_session as from the PM, still named for the agent", async () => {
    const agentId = await h.startFakeSession("start");
    const res = await call(
      "pm",
      "message_session",
      { sessionId: agentId, text: "Use **pnpm**, not npm" },
      h.projectId,
    );
    expect(res.isError).toBe(false);
    const input = await waitUntil(async () =>
      (await userInputs(agentId)).find((i) => i.text.includes("pnpm")),
    );
    expect(input.from).toBe("pm");
    expect(input.text).toBe("Message from your project manager:\nUse **pnpm**, not npm");
    // The user's own message records no sender.
    expect((await userInputs(agentId))[0]).toEqual({ text: "start", attachments: [] });
  });

  it("persists the opening brief of a PM's start_session as from the PM", async () => {
    // Issue #53: the brief a PM starts a session with was recorded without a sender, so the
    // transcript showed it as the user's plain text (raw Markdown).
    const res = await call(
      "pm",
      "start_session",
      {
        prompt: "## Goal\n\nAdd a **counter**. Run `pnpm test`.",
        purpose: "Add a counter",
        workKey: "request:opening-brief",
        provider: "fake",
      },
      h.projectId,
    );
    expect(res.isError).toBe(false);
    const sessionId = await waitUntil(
      () =>
        h.server.services.sessionRepo
          .list({ projectId: h.projectId, role: "agent", workKey: "request:opening-brief" })
          .at(0)?.id,
    );
    const input = await waitUntil(async () => (await userInputs(sessionId)).at(0));
    expect(input.from).toBe("pm");
  });

  it("persists the orchestrator's message_pm as from the orchestrator", async () => {
    const res = await call(
      "orchestrator",
      "message_pm",
      { projectId: h.projectId, text: "Bump the version" },
      null,
    );
    expect(res.isError).toBe(false);
    const pm = await waitUntil(() => h.server.services.orchestration.roles.find("pm", h.projectId));
    const input = await waitUntil(
      async () => (await userInputs(pm.id)).find((i) => i.text.includes("Bump the version")),
      30_000,
    );
    expect(input.from).toBe("orchestrator");
    // The status digest comes first; the sender line stays right before the message.
    expect(input.text).toContain("<codeden_status project=");
    expect(input.text.endsWith("Message from the orchestrator:\nBump the version")).toBe(true);
  });
});

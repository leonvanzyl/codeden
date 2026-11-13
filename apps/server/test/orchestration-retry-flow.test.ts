import {
  type ItemRecord,
  NOTICE_BATCH_CODE,
  RoleMessageResponse,
  ThreadItemsPage,
} from "@codeden/contracts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type Harness, startHarness, waitUntil } from "./support/harness";

/** A PM turn that carried updates fails (an overloaded model): the updates are not lost. */
describe("role session retries after a failed turn (§8.2)", () => {
  let h: Harness;

  beforeAll(async () => {
    h = await startHarness({
      orchestration: { wake: { debounceMs: 50, maxWaitMs: 300 }, failedTurnRetryMs: [300, 300] },
    });
  });
  afterAll(async () => {
    await h?.close();
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

  it("returns the updates and wakes the PM again, a bounded number of times", async () => {
    const sent = RoleMessageResponse.parse(
      (
        await h.api("POST", `/orchestration/projects/${h.projectId}/pm/messages`, {
          input: { text: "hello pm" },
        })
      ).body,
    );
    const pmId = sent.sessionId;
    await waitUntil(async () => {
      const d = await h.detail(pmId);
      const said = (await items(pmId)).some((r) => r.item.kind === "user_message");
      return d.session.status === "idle" && said ? true : undefined;
    });

    // The Fake provider fails any turn whose input contains "[fail]".
    const { orchestration } = h.server.services;
    orchestration.notify({
      id: "orchestrator.message:retry-test",
      type: "orchestrator.message",
      projectId: h.projectId,
      target: "pm",
      sessionId: null,
      title: "Message from the orchestrator",
      data: { fromSessionId: null, text: "Look at this [fail]" },
    });

    // The first wake and two retries each carry the update, and each turn fails.
    const batches = await waitUntil(async () => {
      const found = (await items(pmId)).filter(
        (r) => r.item.kind === "notice" && r.item.code === NOTICE_BATCH_CODE,
      );
      return found.length >= 3 ? found : undefined;
    });
    expect(batches).toHaveLength(3);
    await waitUntil(async () =>
      (await h.detail(pmId)).session.status === "failed" ? true : undefined,
    );
    // Out of retries: the update waits, undelivered, for the PM's next message.
    await new Promise((r) => setTimeout(r, 1_000));
    expect((await items(pmId)).filter((r) => r.item.kind === "notice")).toHaveLength(3);
    const waiting = orchestration.notices.undelivered("pm", h.projectId);
    expect(waiting.map((n) => n.id)).toContain("orchestrator.message:retry-test");
  });
});

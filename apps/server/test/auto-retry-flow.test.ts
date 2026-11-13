import { afterAll, beforeAll, expect, it } from "vitest";
import { type Harness, startHarness, waitUntil } from "./support/harness";

let h: Harness;

beforeAll(async () => {
  h = await startHarness({ autoRetry: { delaysMs: [50, 50, 50], usageMarginMs: 50 } });
});

afterAll(async () => {
  await h?.close();
});

const messages = (id: string) => {
  const session = h.server.services.sessionRepo.get(id);
  if (!session.rootThreadId) return [];
  return h.server.services.sessionRepo
    .threadPage(id, session.rootThreadId, { limit: 200 })
    .items.flatMap((r) => (r.item.kind === "user_message" ? [r.item.input] : []));
};

it("continues a session whose turn failed on an overloaded API, without a failed run", async () => {
  const id = await h.startFakeSession("Do the work [fail:transient]");
  // The Fake answers the continue message normally.
  await waitUntil(async () => (messages(id).length >= 2 ? true : undefined));
  const detail = await waitUntil(async () => {
    const d = await h.detail(id);
    return d.session.status === "idle" && messages(id).length === 2 ? d : undefined;
  });
  expect(messages(id)[1]).toMatchObject({
    text: "Previous turn stopped (Scripted overload); continue where you left off.",
  });
  expect(detail.session.status).toBe("idle");
  expect(h.server.services.inbox.list({ sessionId: id }).map((i) => i.kind)).toEqual([]);
});

it("continues a session after its usage limit resets", async () => {
  const id = await h.startFakeSession("Do the work [fail:usage]");
  await waitUntil(async () => (messages(id).length >= 2 ? true : undefined), 20_000);
  expect(messages(id)[1]?.text).toBe(
    "Previous turn stopped (usage limit reached); continue where you left off.",
  );
});

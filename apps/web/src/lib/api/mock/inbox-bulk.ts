import { type InboxItem, inboxRestorable, inboxWaitsOnYou } from "@codeden/contracts";
import type { CodeDenClient } from "../client";
import type { MockWorld } from "./world";

type MockInboxBulkApi = Pick<CodeDenClient, "dismissInbox" | "restoreInbox">;

/**
 * The inbox's bulk dismiss and its Undo in the mock (#407). Like the server: what waits on the
 * user stays, and Undo reopens only items a bulk dismiss closed (or the PM resolved).
 */
export function mockInboxBulkApi(world: MockWorld): MockInboxBulkApi {
  const update = (item: InboxItem) =>
    world.emitDomain({ type: "inbox.updated", sessionId: null, payload: { item } });
  const find = (id: string) => world.snapshot.inbox.find((i) => i.id === id);

  return {
    async dismissInbox(itemIds) {
      const ids: string[] = [];
      let kept = 0;
      for (const id of new Set(itemIds)) {
        const item = find(id);
        if (item?.status !== "open") continue;
        if (inboxWaitsOnYou(item)) {
          kept++;
          continue;
        }
        const now = new Date().toISOString();
        update({
          ...item,
          status: "dismissed",
          resolution: { bulk: true },
          resolvedAt: now,
          updatedAt: now,
        });
        ids.push(id);
      }
      return { dismissed: ids.length, ids, kept };
    },

    async restoreInbox(itemIds) {
      const ids: string[] = [];
      for (const id of new Set(itemIds)) {
        const item = find(id);
        if (!item || !inboxRestorable(item)) continue;
        update({
          ...item,
          status: "open",
          resolution: null,
          resolvedAt: null,
          updatedAt: new Date().toISOString(),
        });
        ids.push(id);
      }
      return { restored: ids.length, ids };
    },
  };
}

import { DismissInboxRequest, ListInboxQuery, ResolveInboxRequest } from "@codeden/contracts";
import { Hono } from "hono";
import type { AppServices } from "../services/container";
import { retryRunFailed } from "../services/inbox-retry";
import { jsonBody, queryOf } from "./validate";

/** `/api/inbox`: list, counts, resolve in place, retry a failed run, bulk dismiss (§11.1). */
export function inboxRoutes(s: AppServices) {
  return new Hono()
    .get("/", queryOf(ListInboxQuery), (c) => c.json(s.inbox.list(c.req.valid("query"))))
    .get("/counts", (c) => c.json(s.inbox.counts()))
    .post("/dismiss", jsonBody(DismissInboxRequest), (c) => {
      const { ids, note } = c.req.valid("json");
      return c.json({ dismissed: s.inbox.dismissMany(ids, note) });
    })
    .get("/:id", (c) => c.json(s.inbox.get(c.req.param("id"))))
    .post("/:id/resolve", jsonBody(ResolveInboxRequest), async (c) =>
      c.json(await s.inbox.resolve(c.req.param("id"), c.req.valid("json"))),
    )
    .post("/:id/retry", async (c) => {
      const item = await retryRunFailed(
        {
          inbox: s.inbox,
          repo: s.sessionRepo,
          sessions: s.sessions,
          runnable: (provider) => s.factory.providerRunnableNow(provider),
        },
        c.req.param("id"),
      );
      return c.json({ item });
    });
}

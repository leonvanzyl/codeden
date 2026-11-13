import {
  ArchiveSessionRequest,
  EditQueuedMessageRequest,
  ForkSessionRequest,
  type ForkSessionResponse,
  ListSessionsQuery,
  type QueuedMessageList,
  RespondRequest,
  SendMessageRequest,
  StartSessionRequest,
  SteerRequest,
  ThreadItemsQuery,
  type ToolOutputResponse,
  UpdateSessionRequest,
} from "@codeden/contracts";
import { Hono } from "hono";
import type { AppServices } from "../services/container";
import { badRequest, notFound } from "../services/errors";
import { clientItemRecord } from "../services/sessions/client-items";
import { jsonBody, queryOf } from "./validate";

/**
 * `/api/sessions`: start (with conflict handling), message, steer, interrupt, respond, stop,
 * fork, archive (removes the worktree, §9), unarchive and the queued-message tray.
 */
export function sessionRoutes(s: AppServices) {
  return (
    new Hono()
      .get("/", queryOf(ListSessionsQuery), (c) => c.json(s.sessionRepo.list(c.req.valid("query"))))
      .post("/", jsonBody(StartSessionRequest), async (c) => {
        const req = c.req.valid("json");
        const result = await s.sessions.start(req);
        if (result.status !== "conflict") {
          // A new version of a request that had an open conflict: that conflict is done.
          s.orchestration.conflicts.closeReplaced(req, result);
          return c.json(result, 200);
        }
        // Persist the conflict (inbox item) so it can be resolved later (§8.4); it replaces the
        // open conflict of an earlier version of the same request.
        const record = s.orchestration.conflicts.record(req, result.existing);
        return c.json({ ...result, conflictId: record.id }, 409);
      })
      .get("/:id", (c) => c.json(s.sessions.detail(c.req.param("id"))))
      .patch("/:id", jsonBody(UpdateSessionRequest), async (c) =>
        c.json(await s.sessions.update(c.req.param("id"), c.req.valid("json"))),
      )
      .post("/:id/messages", jsonBody(SendMessageRequest), async (c) =>
        c.json(await s.sessions.send(c.req.param("id"), c.req.valid("json"))),
      )
      .post("/:id/steer", jsonBody(SteerRequest), async (c) => {
        await s.sessions.steer(c.req.param("id"), c.req.valid("json").input);
        return c.json({ ok: true as const });
      })
      .post("/:id/interrupt", async (c) => {
        await s.sessions.interrupt(c.req.param("id"));
        return c.json({ ok: true as const });
      })
      .post("/:id/respond", jsonBody(RespondRequest), async (c) => {
        await s.sessions.respond(c.req.param("id"), c.req.valid("json"));
        return c.json({ ok: true as const });
      })
      .post("/:id/stop", async (c) => c.json(await s.sessions.stop(c.req.param("id"))))
      // A new session continuing this one's conversation and code (§9); 409 when it can't.
      .post("/:id/fork", jsonBody(ForkSessionRequest), async (c) => {
        const body: ForkSessionResponse = await s.sessions.fork(
          c.req.param("id"),
          c.req.valid("json"),
        );
        return c.json(body);
      })
      .post("/:id/archive", jsonBody(ArchiveSessionRequest), async (c) =>
        c.json(await s.worktreeCleanup.archive(c.req.param("id"), c.req.valid("json"))),
      )
      .post("/:id/unarchive", (c) => c.json(s.worktreeCleanup.unarchive(c.req.param("id"))))
      // The queued-message tray. Each answers 409 `already_sent` once delivery took the message.
      .get("/:id/queue", (c) => {
        const body: QueuedMessageList = { messages: s.queue.list(c.req.param("id")) };
        return c.json(body);
      })
      .patch("/:id/queue/:messageId", jsonBody(EditQueuedMessageRequest), (c) =>
        c.json(s.queue.edit(c.req.param("id"), c.req.param("messageId"), c.req.valid("json").text)),
      )
      .delete("/:id/queue/:messageId", (c) => {
        s.queue.delete(c.req.param("id"), c.req.param("messageId"));
        return c.json({ ok: true as const });
      })
      .post("/:id/queue/:messageId/send-now", async (c) =>
        c.json(await s.queue.sendNow(c.req.param("id"), c.req.param("messageId"))),
      )
      .get("/:id/threads/:threadId/items", queryOf(ThreadItemsQuery), (c) => {
        const id = c.req.param("id");
        s.sessionRepo.get(id);
        const page = s.sessionRepo.threadPage(id, c.req.param("threadId"), c.req.valid("query"));
        return c.json({ ...page, items: page.items.map((r) => clientItemRecord(r, s.artifacts)) });
      })
      .get("/:id/items/:itemId/output", (c) => {
        const record = s.sessionRepo.item(c.req.param("id"), c.req.param("itemId"));
        if (!record) throw notFound("No such item", "item_not_found");
        const { item } = record;
        if (item.kind !== "tool_call") throw badRequest("Only tool calls have output", "no_output");
        const text = item.output?.text ?? "";
        const totalBytes = Buffer.byteLength(text, "utf8");
        const body: ToolOutputResponse = {
          itemId: item.id,
          text,
          totalBytes,
          truncated: item.output?.truncated ?? false,
          outputBytes: Math.max(totalBytes, item.output?.totalBytes ?? totalBytes),
        };
        return c.json(body);
      })
  );
}

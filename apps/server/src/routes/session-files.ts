import { SessionFileQuery } from "@codeden/contracts";
import { Hono } from "hono";
import type { AppServices } from "../services/container";
import { listSessionFiles, readSessionFile } from "../services/files/session-files";
import { queryOf } from "./validate";

/**
 * `/api/sessions/:id/files`: read-only file tree and viewer for the session's working folder
 * (§12.3), on the server's disk or its runner's (`WorkspaceFs`).
 */
export function sessionFileRoutes(s: AppServices) {
  const files = (id: string) => s.workspaceFs(s.sessionRepo.get(id));
  return new Hono()
    .get("/:id/files", async (c) => c.json(await listSessionFiles(files(c.req.param("id")))))
    .get("/:id/files/content", queryOf(SessionFileQuery), async (c) =>
      c.json(await readSessionFile(files(c.req.param("id")), c.req.valid("query").path)),
    );
}

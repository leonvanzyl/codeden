import {
  CreateProjectRequest,
  ProjectCommandsQuery,
  ReorderProjectsRequest,
  type SessionFileList,
  type SlashCommandList,
  UpdateProjectRequest,
} from "@codeden/contracts";
import { Hono } from "hono";
import { z } from "zod";
import type { AppServices } from "../services/container";
import { listFolderFiles } from "../services/files/session-files";
import { jsonBody, queryOf } from "./validate";

/**
 * `/api/projects`: add from a folder or clone, list, reorder, update (and pin), archive, and
 * re-detect the folder's git checkout and GitHub remote (`refresh`, `disconnect-github`).
 * `commands` and `files` feed the composer's `/` and `@` menus in the New session draft, before
 * the session and its worktree exist: they read the project folder.
 */
export function projectRoutes(s: AppServices) {
  return new Hono()
    .get("/", queryOf(z.object({ archived: z.enum(["true", "false"]).optional() })), (c) =>
      c.json(s.projects.list({ includeArchived: c.req.valid("query").archived === "true" })),
    )
    .post("/", jsonBody(CreateProjectRequest), async (c) =>
      c.json(await s.projects.create(c.req.valid("json")), 201),
    )
    .put("/order", jsonBody(ReorderProjectsRequest), (c) =>
      c.json({ projects: s.projects.reorder(c.req.valid("json").projectIds) }),
    )
    .get("/:id", (c) => c.json(s.projects.get(c.req.param("id"))))
    .patch("/:id", jsonBody(UpdateProjectRequest), (c) =>
      c.json(s.projects.update(c.req.param("id"), c.req.valid("json"))),
    )
    .get("/:id/commands", queryOf(ProjectCommandsQuery), (c) =>
      c.json<SlashCommandList>(
        s.agentConfig.projectSlashCommands(c.req.param("id"), c.req.valid("query").provider),
      ),
    )
    .get("/:id/files", (c) =>
      c.json<SessionFileList>(
        listFolderFiles(s.projects.get(c.req.param("id")).path, s.paths.home),
      ),
    )
    .post("/:id/refresh", async (c) => c.json(await s.redetector.refresh(c.req.param("id"))))
    .post("/:id/disconnect-github", async (c) =>
      c.json(await s.projects.disconnectGithub(c.req.param("id"))),
    )
    .delete("/:id", (c) => {
      s.projects.archive(c.req.param("id"));
      return c.json({ ok: true as const });
    });
}

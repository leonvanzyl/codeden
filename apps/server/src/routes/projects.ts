import {
  ArchivedSessionsQuery,
  CreateProjectRequest,
  checksOf,
  type ProjectChecksResponse,
  ProjectCommandsQuery,
  ReorderProjectsRequest,
  type SessionFileList,
  type SlashCommandList,
  TechDebtAction,
  UpdateProjectRequest,
} from "@codeden/contracts";
import { Hono } from "hono";
import { z } from "zod";
import type { AppServices } from "../services/container";
import { listFolderFiles } from "../services/files/session-files";
import { readProjectConfig } from "../services/projects/project-config";
import { archivedSessionsPage } from "../services/sessions/archived";
import { jsonBody, queryOf } from "./validate";

/**
 * `/api/projects`: add from a folder or clone, list, reorder, update (and pin), archive, and
 * re-detect the folder's git checkout and GitHub remote (`refresh`, `disconnect-github`).
 * `sessions/archived` pages through the project's archived sessions (the snapshot carries only
 * the recent ones).
 * `commands` and `files` feed the composer's `/` and `@` menus in the New session draft, before
 * the session and its worktree exist: they read the project folder. `checks` lists the project's
 * checks a new session would freeze, for "Keep going until checks pass" (§9 Project checks).
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
    .patch("/:id", jsonBody(UpdateProjectRequest), async (c) => {
      const patch = c.req.valid("json");
      // Docker must be there to switch a project to it (checked now, not cached).
      if (patch.execution) {
        await s.sandboxes.assertUsable(s.projects.get(c.req.param("id")), patch.execution.backend);
      }
      return c.json(s.projects.update(c.req.param("id"), patch));
    })
    .get("/:id/tech-debt", async (c) =>
      c.json(await s.techDebt.list(s.projects.get(c.req.param("id")))),
    )
    .post("/:id/tech-debt", jsonBody(TechDebtAction), async (c) =>
      c.json(await s.techDebt.act(s.projects.get(c.req.param("id")), c.req.valid("json"))),
    )
    .get("/:id/commands", queryOf(ProjectCommandsQuery), (c) =>
      c.json<SlashCommandList>(
        s.agentConfig.projectSlashCommands(c.req.param("id"), c.req.valid("query").provider),
      ),
    )
    .get("/:id/sessions/archived", queryOf(ArchivedSessionsQuery), (c) => {
      const project = s.projects.get(c.req.param("id"));
      return c.json(archivedSessionsPage(s.db, project.id, c.req.valid("query")));
    })
    .get("/:id/files", (c) =>
      c.json<SessionFileList>(
        listFolderFiles(s.projects.get(c.req.param("id")).path, s.paths.home),
      ),
    )
    .get("/:id/checks", (c) =>
      c.json<ProjectChecksResponse>({
        checks: checksOf(readProjectConfig(s.projects.get(c.req.param("id")).path)),
      }),
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

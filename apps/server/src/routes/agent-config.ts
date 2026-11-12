import {
  AgentConfigDeleteQuery,
  AgentConfigDiffRequest,
  AgentConfigListQuery,
  AgentConfigLocator,
  AgentConfigWriteRequest,
  HookChangeRequest,
  McpServerDiffRequest,
  McpServerTarget,
  McpServerUpsertRequest,
} from "@codeden/contracts";
import { Hono } from "hono";
import type { AppServices } from "../services/container";
import { jsonBody, queryOf } from "./validate";

/**
 * `/api/agent-config` (§12.4): provider memory files, skills, subagents, MCP servers and hooks
 * in their native files. Every overwrite and delete is backed up first; `diff` routes preview.
 */
export function agentConfigRoutes(s: AppServices) {
  const ac = s.agentConfig;
  return new Hono()
    .get("/files", queryOf(AgentConfigListQuery), (c) => c.json(ac.list(c.req.valid("query"))))
    .get("/file", queryOf(AgentConfigLocator), (c) => c.json(ac.files.read(c.req.valid("query"))))
    .put("/file", jsonBody(AgentConfigWriteRequest), (c) => {
      const { content, expectedSha256, ...locator } = c.req.valid("json");
      return c.json(ac.files.write(locator, content, { expectedSha256 }));
    })
    .post("/file", jsonBody(AgentConfigWriteRequest), (c) => {
      const { content, ...locator } = c.req.valid("json");
      return c.json(ac.files.write(locator, content, { create: true }));
    })
    .delete("/file", queryOf(AgentConfigDeleteQuery), (c) => {
      const { folder, ...locator } = c.req.valid("query");
      return c.json(ac.files.delete(locator, { folder: folder === "1" }));
    })
    .post("/diff", jsonBody(AgentConfigDiffRequest), (c) => {
      const { content, ...locator } = c.req.valid("json");
      return c.json(ac.files.diff(locator, content));
    })
    .get("/mcp", queryOf(AgentConfigListQuery.pick({ projectId: true })), (c) =>
      c.json({ servers: ac.mcpList(c.req.valid("query").projectId) }),
    )
    .put("/mcp", jsonBody(McpServerUpsertRequest), (c) => c.json(ac.mcpUpsert(c.req.valid("json"))))
    .delete("/mcp", queryOf(McpServerTarget), (c) => c.json(ac.mcpDelete(c.req.valid("query"))))
    .post("/mcp/diff", jsonBody(McpServerDiffRequest), (c) =>
      c.json(ac.mcpDiff(c.req.valid("json"))),
    )
    .get("/hooks", queryOf(AgentConfigListQuery.pick({ projectId: true })), (c) =>
      c.json(ac.hooks.list(c.req.valid("query").projectId)),
    )
    .post("/hooks/diff", jsonBody(HookChangeRequest), (c) =>
      c.json(ac.hooks.diff(c.req.valid("json"))),
    )
    .post("/hooks", jsonBody(HookChangeRequest), (c) =>
      c.json(ac.hooks.apply(c.req.valid("json"))),
    );
}

/** `GET /api/sessions/:id/agent-config/loaded`. */
export function sessionAgentConfigRoutes(s: AppServices) {
  return new Hono().get("/:id/agent-config/loaded", (c) =>
    c.json(s.agentConfig.loaded(c.req.param("id"))),
  );
}

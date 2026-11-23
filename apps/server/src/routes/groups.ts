import {
  CreateGroupRequest,
  type DeleteGroupResponse,
  type GroupMemoryResponse,
  type GroupResponse,
  type ListGroupsResponse,
  UpdateGroupRequest,
  WriteGroupMemoryRequest,
} from "@codeden/contracts";
import { Hono } from "hono";
import type { AppServices } from "../services/container";
import { jsonBody } from "./validate";

/**
 * `/api/groups` (DESIGN.md "Project groups"): list, create, change (name, description, skills)
 * and delete groups, and read and write a group's memory as the user. Projects join and leave
 * a group through `PATCH /api/projects/:id` (`groupId`).
 */
export function groupRoutes(s: AppServices) {
  return new Hono()
    .get("/", (c) => c.json<ListGroupsResponse>({ groups: s.groups.list() }))
    .post("/", jsonBody(CreateGroupRequest), (c) =>
      c.json<GroupResponse>({ group: s.groups.create(c.req.valid("json")) }, 201),
    )
    .patch("/:id", jsonBody(UpdateGroupRequest), (c) =>
      c.json<GroupResponse>({ group: s.groups.update(c.req.param("id"), c.req.valid("json")) }),
    )
    .delete("/:id", (c) => c.json<DeleteGroupResponse>(s.groups.delete(c.req.param("id"))))
    .get("/:id/memory", (c) =>
      c.json<GroupMemoryResponse>({ memory: s.groups.memory.read(c.req.param("id")) }),
    )
    .put("/:id/memory", jsonBody(WriteGroupMemoryRequest), (c) => {
      const memory = s.groups.memory.write(c.req.param("id"), c.req.valid("json"), {
        projectId: null,
        sessionId: null,
      });
      return c.json<GroupMemoryResponse>({ memory });
    });
}

import { z } from "zod";
import { Id } from "./common";
import { GroupMemory, GroupSkills, MemoryWriteMode, ProjectGroup } from "./entities/project-group";

/**
 * HTTP shapes for project groups (`/api/groups`). A project joins or leaves a group through
 * `PATCH /api/projects/:id` (`UpdateProjectRequest.groupId`).
 */

/** `GET /api/groups`: every group, by name. */
export const ListGroupsResponse = z.object({ groups: z.array(ProjectGroup) });
export type ListGroupsResponse = z.infer<typeof ListGroupsResponse>;

/** `POST /api/groups`. */
export const CreateGroupRequest = z.object({
  name: z.string().trim().min(1).max(100),
  description: z.string().trim().max(2000).nullable().optional(),
  skills: GroupSkills.optional(),
});
export type CreateGroupRequest = z.infer<typeof CreateGroupRequest>;

/** `PATCH /api/groups/:id`: what is given changes; `skills` replaces the whole list. */
export const UpdateGroupRequest = z.object({
  name: z.string().trim().min(1).max(100).optional(),
  description: z.string().trim().max(2000).nullable().optional(),
  skills: GroupSkills.optional(),
});
export type UpdateGroupRequest = z.infer<typeof UpdateGroupRequest>;

/** `POST /api/groups` and `PATCH /api/groups/:id` response. */
export const GroupResponse = z.object({ group: ProjectGroup });
export type GroupResponse = z.infer<typeof GroupResponse>;

/**
 * `DELETE /api/groups/:id` response: the projects that were members (now in no group). The
 * group's memory is deleted with it.
 */
export const DeleteGroupResponse = z.object({ unassignedProjectIds: z.array(Id) });
export type DeleteGroupResponse = z.infer<typeof DeleteGroupResponse>;

/**
 * `PUT /api/groups/:id/memory`. With `baseRevision`, a write is refused (`409
 * memory_changed`) when the memory changed since that revision was read; the UI's editor and
 * `replace` from agents pass it so nobody overwrites a write they never saw.
 */
export const WriteGroupMemoryRequest = z.object({
  content: z.string().max(200_000),
  mode: MemoryWriteMode.default("replace"),
  baseRevision: z.int().nonnegative().optional(),
});
export type WriteGroupMemoryRequest = z.infer<typeof WriteGroupMemoryRequest>;

/** `GET` and `PUT /api/groups/:id/memory` response. */
export const GroupMemoryResponse = z.object({ memory: GroupMemory });
export type GroupMemoryResponse = z.infer<typeof GroupMemoryResponse>;

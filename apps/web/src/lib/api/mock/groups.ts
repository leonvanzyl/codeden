import {
  type GroupMemory,
  GroupSkills,
  nextMemoryContent,
  type ProjectGroup,
} from "@codeden/contracts";
import type { GroupsApi } from "../groups-api";
import { ApiRequestError } from "../http";
import { uid } from "./live";
import type { MockWorld } from "./world";

const delay = <T>(value: T, ms = 80): Promise<T> =>
  new Promise((resolve) => setTimeout(() => resolve(structuredClone(value)), ms));

/** In-memory project groups for the mock client: the same events and 409/404 answers as the server. */
export function mockGroupsApi(world: MockWorld): GroupsApi {
  const memories = new Map<string, GroupMemory>();
  const find = (id: string): ProjectGroup => {
    const group = world.snapshot.groups.find((g) => g.id === id);
    if (!group) throw new ApiRequestError(404, "group_not_found", "That group doesn't exist");
    return group;
  };
  const memoryOf = (id: string): GroupMemory =>
    memories.get(id) ?? { groupId: id, content: "", revision: 0, updatedAt: null };
  const save = (group: ProjectGroup) =>
    world.emitDomain({ type: "project_group.saved", sessionId: null, payload: { group } });

  return {
    async create(req) {
      const now = new Date().toISOString();
      const group: ProjectGroup = {
        id: uid("grp"),
        name: req.name,
        description: req.description || null,
        skills: req.skills ?? [],
        createdAt: now,
        updatedAt: now,
      };
      save(group);
      return delay(group);
    },
    async update(id, req) {
      const group = find(id);
      const skills = req.skills === undefined ? group.skills : GroupSkills.parse(req.skills);
      const next: ProjectGroup = {
        ...group,
        name: req.name ?? group.name,
        description: req.description === undefined ? group.description : req.description || null,
        skills,
        updatedAt: new Date().toISOString(),
      };
      save(next);
      return delay(next);
    },
    async remove(id) {
      find(id);
      const members = world.snapshot.projects.filter((p) => p.groupId === id);
      for (const project of members) {
        world.emitDomain({
          type: "project.updated",
          sessionId: null,
          payload: { project: { ...project, groupId: null } },
        });
      }
      memories.delete(id);
      world.emitDomain({
        type: "project_group.deleted",
        sessionId: null,
        payload: { groupId: id },
      });
      return delay({ unassignedProjectIds: members.map((p) => p.id) });
    },
    async memory(id) {
      find(id);
      return delay(memoryOf(id));
    },
    async writeMemory(id, req) {
      find(id);
      const current = memoryOf(id);
      if (req.baseRevision !== undefined && req.baseRevision !== current.revision) {
        throw new ApiRequestError(409, "memory_changed", "The memory changed since you loaded it");
      }
      const next: GroupMemory = {
        groupId: id,
        content: nextMemoryContent(current.content, req.content, req.mode ?? "replace"),
        revision: current.revision + 1,
        updatedAt: new Date().toISOString(),
      };
      memories.set(id, next);
      world.emitDomain({
        type: "project_group.memory_written",
        sessionId: null,
        payload: {
          groupId: id,
          mode: req.mode ?? "replace",
          content: req.content,
          revision: next.revision,
          by: { sessionId: null, projectId: null },
        },
      });
      return delay(next);
    },
  };
}

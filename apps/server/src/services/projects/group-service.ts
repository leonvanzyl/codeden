import { randomUUID } from "node:crypto";
import {
  type CreateGroupRequest,
  type DeleteGroupResponse,
  type GroupMemory,
  type NewEvent,
  type Project,
  type ProjectGroup,
  renderSkillFile,
  type SharedSkillFile,
  type UpdateGroupRequest,
} from "@codeden/contracts";
import { asc, eq } from "drizzle-orm";
import type { Db } from "../../db/client";
import { rowToProject } from "../../db/rows";
import { projectGroups, projects } from "../../db/schema";
import type { EventStore } from "../../events/store";
import { notFound } from "../errors";
import { GroupMemoryStore, type MemoryWrite } from "./group-memory";
import { rowToGroup } from "./group-projection";

export interface ProjectGroupServiceDeps {
  db: Db;
  store: EventStore;
}

/**
 * Project groups (DESIGN.md "Project groups"): create, change and delete groups, the skills
 * their members' agent sessions get, and the memory they share. A project joins or leaves a
 * group through `ProjectService.update` (`groupId`).
 */
export class ProjectGroupService {
  readonly memory: GroupMemoryStore;

  constructor(private readonly deps: ProjectGroupServiceDeps) {
    this.memory = new GroupMemoryStore(deps.db, deps.store, (id) => this.get(id));
  }

  /** Every group, by name. */
  list(): ProjectGroup[] {
    return this.deps.db
      .select()
      .from(projectGroups)
      .orderBy(asc(projectGroups.name), asc(projectGroups.id))
      .all()
      .map(rowToGroup);
  }

  find(id: string): ProjectGroup | null {
    const row = this.deps.db.select().from(projectGroups).where(eq(projectGroups.id, id)).get();
    return row ? rowToGroup(row) : null;
  }

  get(id: string): ProjectGroup {
    const group = this.find(id);
    if (!group) throw notFound(`No project group ${id}`, "group_not_found");
    return group;
  }

  create(req: CreateGroupRequest): ProjectGroup {
    const now = new Date().toISOString();
    const group: ProjectGroup = {
      id: randomUUID(),
      name: req.name,
      description: req.description || null,
      skills: req.skills ?? [],
      createdAt: now,
      updatedAt: now,
    };
    this.save(group);
    return group;
  }

  update(id: string, patch: UpdateGroupRequest): ProjectGroup {
    const current = this.get(id);
    const next: ProjectGroup = {
      ...current,
      ...(patch.name !== undefined ? { name: patch.name } : {}),
      ...(patch.description !== undefined ? { description: patch.description || null } : {}),
      ...(patch.skills !== undefined ? { skills: patch.skills } : {}),
      updatedAt: new Date().toISOString(),
    };
    this.save(next);
    return next;
  }

  /**
   * Delete a group: every member (archived ones too) leaves it, then the group and its memory
   * go, in one append. Sessions opened from now on get neither its skills nor its memory.
   */
  delete(id: string): DeleteGroupResponse {
    this.get(id);
    const members = this.members(id, { includeArchived: true });
    const now = new Date().toISOString();
    const events: NewEvent[] = members.map((p) => ({
      type: "project.updated",
      sessionId: null,
      payload: { project: { ...p, groupId: null, updatedAt: now } },
    }));
    events.push({ type: "project_group.deleted", sessionId: null, payload: { groupId: id } });
    this.deps.store.append(events);
    return { unassignedProjectIds: members.map((p) => p.id) };
  }

  /** The group's member projects. */
  members(groupId: string, opts: { includeArchived?: boolean } = {}): Project[] {
    return this.deps.db
      .select()
      .from(projects)
      .where(eq(projects.groupId, groupId))
      .all()
      .map(rowToProject)
      .filter((p) => opts.includeArchived || p.archivedAt === null);
  }

  /** The group a project belongs to; null when it is in none (or the project is unknown). */
  groupOf(projectId: string | null): ProjectGroup | null {
    if (!projectId) return null;
    const row = this.deps.db
      .select({ groupId: projects.groupId })
      .from(projects)
      .where(eq(projects.id, projectId))
      .get();
    return row?.groupId ? this.find(row.groupId) : null;
  }

  /**
   * The skill files a project's agent sessions get from its group (`SessionOptions.sharedSkills`);
   * empty when it is in none. The runner skips a name the workspace has a skill of its own for.
   */
  sharedSkillsFor(projectId: string | null): SharedSkillFile[] {
    return (this.groupOf(projectId)?.skills ?? []).map(renderSkillFile);
  }

  /** A member project's group memory; refused when the project is in no group. */
  readMemoryFor(projectId: string): { group: ProjectGroup; memory: GroupMemory } {
    const group = this.requireGroupOf(projectId);
    return { group, memory: this.memory.read(group.id) };
  }

  /** Write to a member project's group memory on behalf of one of its sessions. */
  writeMemoryFor(
    projectId: string,
    sessionId: string | null,
    write: MemoryWrite,
  ): { group: ProjectGroup; memory: GroupMemory } {
    const group = this.requireGroupOf(projectId);
    return { group, memory: this.memory.write(group.id, write, { projectId, sessionId }) };
  }

  private requireGroupOf(projectId: string): ProjectGroup {
    const group = this.groupOf(projectId);
    if (!group) throw notFound("This project is not in a project group", "no_group");
    return group;
  }

  private save(group: ProjectGroup): void {
    this.deps.store.append([{ type: "project_group.saved", sessionId: null, payload: { group } }]);
  }
}

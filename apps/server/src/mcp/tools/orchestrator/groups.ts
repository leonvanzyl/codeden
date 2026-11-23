import { GroupSkill, GroupSkillName, GroupSkills, type ProjectGroup } from "@codeden/contracts";
import { z } from "zod";
import type { AppServices } from "../../../services/container";
import { defineTool, ToolError } from "../../define";
import { projectFor } from "../shared/helpers";

function compactGroup(services: AppServices, g: ProjectGroup) {
  return {
    id: g.id,
    name: g.name,
    description: g.description,
    skills: g.skills.map((s) => ({ name: s.name, description: s.description })),
    projects: services.groups.members(g.id).map((p) => ({ id: p.id, name: p.name })),
  };
}

const skillsInput = GroupSkills.describe(
  "The group's whole skill list (replaces it): each { name (lowercase-hyphenated folder name), description (when to use it), body (Markdown instructions) }. Agent sessions of every member project get them; a project's own skill of the same name wins.",
);

/** `list_groups` (DESIGN.md "Project groups"): every group with its members and skills. */
export const listGroups = defineTool({
  name: "list_groups",
  description:
    "List the project groups: id, name, description, skill names and member projects. Projects in a group share its skills and one memory store.",
  roles: ["orchestrator"],
  scope: "global",
  input: z.object({}),
  handler: async (_input, { services }) => ({
    groups: services.groups.list().map((g) => compactGroup(services, g)),
  }),
});

/** `create_group`: a new, empty project group. */
export const createGroup = defineTool({
  name: "create_group",
  description:
    "Create a project group. Only when the user asked for it. Add projects with assign_project_group.",
  roles: ["orchestrator"],
  scope: "global",
  input: z.object({
    name: z.string().trim().min(1).max(100),
    description: z.string().trim().max(2000).optional(),
    skills: skillsInput.optional(),
  }),
  handler: async (input, { services }) => ({
    group: compactGroup(services, services.groups.create(input)),
  }),
});

/** `update_group`: rename, describe, or add, change and remove skills by name. */
export const updateGroup = defineTool({
  name: "update_group",
  description:
    "Change a project group's name, description (null clears it) or skills. setSkills adds skills or replaces those of the same name; removeSkills removes skills by name; the group's other skills stay. Skill changes reach agent sessions opened from now on.",
  roles: ["orchestrator"],
  scope: "global",
  input: z.object({
    groupId: z.string().min(1),
    name: z.string().trim().min(1).max(100).optional(),
    description: z.string().trim().max(2000).nullable().optional(),
    setSkills: z
      .array(GroupSkill)
      .max(50)
      .optional()
      .describe(
        "Skills to add or replace by name: { name (lowercase-hyphenated folder name), description (when to use it), body (Markdown instructions) }",
      ),
    removeSkills: z.array(GroupSkillName).max(50).optional(),
  }),
  handler: async ({ groupId, setSkills, removeSkills, ...patch }, { services }) => {
    if (!setSkills && !removeSkills && Object.values(patch).every((v) => v === undefined)) {
      throw new ToolError("Nothing to change");
    }
    const current = services.groups.get(groupId);
    const unknown = (removeSkills ?? []).filter((n) => !current.skills.some((s) => s.name === n));
    if (unknown.length > 0) throw new ToolError(`No skill named ${unknown.join(", ")}`);
    const skills =
      setSkills || removeSkills ? mergeSkills(current.skills, setSkills, removeSkills) : undefined;
    const parsed = GroupSkills.safeParse(skills ?? current.skills);
    if (!parsed.success) throw new ToolError(z.prettifyError(parsed.error));
    return { group: compactGroup(services, services.groups.update(groupId, { ...patch, skills })) };
  },
});

/** The group's skills with `set` added or replaced by name and `remove` taken out, in order. */
function mergeSkills(skills: GroupSkill[], set: GroupSkill[] = [], remove: string[] = []) {
  const incoming = new Map(set.map((s) => [s.name, s]));
  const kept = skills.filter((s) => !remove.includes(s.name)).map((s) => incoming.get(s.name) ?? s);
  const added = set.filter((s) => !skills.some((k) => k.name === s.name));
  return [...kept, ...added];
}

/** `assign_project_group`: put a project in a group (it leaves its old one), or null for none. */
export const assignProjectGroup = defineTool({
  name: "assign_project_group",
  description:
    "Put a project in a project group (a project is in at most one; it leaves its current group), or take it out with groupId null. Applies to sessions opened from now on.",
  roles: ["orchestrator"],
  scope: "global",
  input: z.object({ projectId: z.string().min(1), groupId: z.string().min(1).nullable() }),
  handler: async ({ projectId, groupId }, { services }) => {
    projectFor(services, projectId);
    const project = services.projects.update(projectId, { groupId });
    return { projectId: project.id, name: project.name, groupId: project.groupId };
  },
});

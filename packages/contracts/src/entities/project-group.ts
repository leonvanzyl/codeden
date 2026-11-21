import { z } from "zod";
import { Id, Timestamp } from "../common";

/**
 * Project groups (DESIGN.md "Project groups"): a named set of projects that share skills and one
 * memory store. A project belongs to at most one group (`Project.groupId`).
 */

/** A skill's folder name: what the provider lists and the `/` menu offers. */
export const GroupSkillName = z
  .string()
  .regex(/^[a-z0-9][a-z0-9-]{0,63}$/, "Use lowercase letters, digits and hyphens (max 64)");
export type GroupSkillName = z.infer<typeof GroupSkillName>;

/**
 * A skill set on a group. Agent sessions of every member project get it as a native skill
 * (`<skill dir>/<name>/SKILL.md` in their workspace, see `renderSkillFile`), unless the project
 * has a skill of the same name: the project's wins.
 */
export const GroupSkill = z.object({
  name: GroupSkillName,
  /** When to use the skill; the provider shows it to the model to decide. */
  description: z.string().trim().min(1).max(1024),
  /** The instructions, Markdown, without front matter. */
  body: z.string().max(100_000),
});
export type GroupSkill = z.infer<typeof GroupSkill>;

/** A group's skills: at most 50, names unique. */
export const GroupSkills = z
  .array(GroupSkill)
  .max(50)
  .refine((skills) => new Set(skills.map((s) => s.name)).size === skills.length, {
    message: "Skill names must be unique within a group",
  });

export const ProjectGroup = z.object({
  id: Id,
  name: z.string().trim().min(1).max(100),
  description: z.string().max(2000).nullable(),
  skills: GroupSkills.default([]),
  createdAt: Timestamp,
  updatedAt: Timestamp,
});
export type ProjectGroup = z.infer<typeof ProjectGroup>;

/** Group memory is limited like project notes. */
export const GROUP_MEMORY_MAX_BYTES = 200_000;

/**
 * A group's shared memory: Markdown that the PMs and agent sessions of every member project read
 * and write. `revision` counts the writes, so a `replace` based on an older read is refused
 * instead of losing what another project wrote in between.
 */
export const GroupMemory = z.object({
  groupId: Id,
  content: z.string(),
  revision: z.int().nonnegative(),
  /** The last write; null before the first. */
  updatedAt: Timestamp.nullable(),
});
export type GroupMemory = z.infer<typeof GroupMemory>;

/** `append` adds a section after what is there; `replace` rewrites the memory. */
export const MemoryWriteMode = z.enum(["append", "replace"]);
export type MemoryWriteMode = z.infer<typeof MemoryWriteMode>;

/** Who wrote to a group's memory: the user (no session), or a PM or agent session. */
export const MemoryWriter = z.object({
  sessionId: Id.nullable(),
  projectId: Id.nullable(),
});
export type MemoryWriter = z.infer<typeof MemoryWriter>;

/**
 * The text a write leaves: `replace` the new content, `append` the current content and a blank
 * line before the new section. Shared by the service (size check) and the projection.
 */
export function nextMemoryContent(current: string, content: string, mode: MemoryWriteMode) {
  if (mode === "append" && current.trim()) {
    return `${current.trimEnd()}\n\n${content.trim()}\n`;
  }
  return content.trim() ? `${content.trim()}\n` : "";
}

/**
 * A skill file a session gets in its workspace (`SessionOptions.sharedSkills`): the folder name
 * and the whole `SKILL.md`, front matter included.
 */
export const SharedSkillFile = z.object({
  name: GroupSkillName,
  content: z.string().max(110_000),
});
export type SharedSkillFile = z.infer<typeof SharedSkillFile>;

/** A group skill as the provider's `SKILL.md`: front matter (name, description), then the body. */
export function renderSkillFile(skill: GroupSkill): SharedSkillFile {
  // A JSON string is a valid YAML double-quoted scalar, so any description survives.
  const front = `---\nname: ${skill.name}\ndescription: ${JSON.stringify(skill.description)}\n---\n`;
  const body = skill.body.trim();
  return { name: skill.name, content: body ? `${front}\n${body}\n` : front };
}

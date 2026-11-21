import { GroupSkill, GroupSkillName } from "@codeden/contracts";

export interface SkillErrors {
  name?: string;
  description?: string;
  body?: string;
}

/**
 * Problems with a skill being saved, from the same schema the server checks. `others` are the
 * group's other skills' names (a name must be unique within the group).
 */
export function skillErrors(skill: GroupSkill, others: readonly string[]): SkillErrors {
  const errors: SkillErrors = {};
  const parsed = GroupSkill.safeParse(skill);
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      const field = issue.path[0];
      if (field === "name" || field === "description" || field === "body") {
        errors[field] ??= issue.message;
      }
    }
  }
  if (!skill.name) errors.name = "Give the skill a name";
  else if (!errors.name && !GroupSkillName.safeParse(skill.name).success) {
    errors.name = "Use lowercase letters, digits and hyphens (max 64)";
  } else if (!errors.name && others.includes(skill.name)) {
    errors.name = "Another skill in this group has this name";
  }
  if (!skill.description.trim()) errors.description = "Say when the agent should use the skill";
  return errors;
}

export const hasErrors = (errors: SkillErrors) => Object.keys(errors).length > 0;

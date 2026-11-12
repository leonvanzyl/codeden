import { z } from "zod";
import {
  AgentConfigDiff,
  AgentConfigFile,
  AgentConfigLocator,
  AgentConfigProvider,
  AgentConfigScope,
} from "./agent-config";
import { Id } from "./common";

/**
 * Skills (§12.4) and the switch that turns one off, written to each provider's own setting:
 * - Claude Code: `skillOverrides` in its settings files (`~/.claude/settings.json`,
 *   `.claude/settings.json`, `.claude/settings.local.json`) maps a skill name to `"on"`,
 *   `"name-only"`, `"user-invocable-only"` or `"off"`; a name no file sets is `"on"`. The most
 *   specific file that sets a name wins (local, then project, then user).
 * - Codex: `[[skills.config]]` entries in `~/.codex/config.toml`, each with a `path` (the
 *   skill's `SKILL.md`) or a `name`, and `enabled`. Entries apply in order; the last one that
 *   selects a skill decides it.
 *
 * A switch edits the file that already decides the skill, or else the provider's user-level
 * file, so it reaches every session (worktrees included). Codex user skills are selected by
 * path, project skills by name (their path differs in every worktree).
 *
 * Routes: `GET /api/agent-config/skills?projectId=`, `POST /api/agent-config/skills/diff`
 * (-> `SkillSwitchDiff`) and `POST /api/agent-config/skills` (-> `SkillSwitchResponse`), both
 * taking a `SkillSwitchRequest`.
 */

/** Claude Code's partial states: the skill is on, but Claude sees less of it. */
export const SkillVisibility = z.enum(["name-only", "user-invocable-only"]);
export type SkillVisibility = z.infer<typeof SkillVisibility>;

/** A skill folder (its `SKILL.md`) and whether its provider's native setting switches it off. */
export const AgentSkill = z.object({
  provider: AgentConfigProvider,
  scope: AgentConfigScope,
  name: z.string(),
  description: z.string().optional(),
  file: AgentConfigFile,
  /** False when the provider's native setting turns the skill off where it is listed. */
  enabled: z.boolean(),
  /**
   * Claude Code only: `"name-only"` (Claude sees the name without the description) or
   * `"user-invocable-only"` (Claude doesn't see it; you can still type `/name`).
   */
  visibility: SkillVisibility.optional(),
  /** The native file whose entry decides the state; null when no entry names the skill. */
  setIn: z.string().nullable(),
});
export type AgentSkill = z.infer<typeof AgentSkill>;

/**
 * `GET /api/agent-config/skills?projectId=`: the user's skills, plus the project's when given,
 * each with its state for the project's checkout (user settings only without a project).
 */
export const AgentSkillListResponse = z.object({ skills: z.array(AgentSkill) });
export type AgentSkillListResponse = z.infer<typeof AgentSkillListResponse>;

/**
 * Switch one listed skill on or off. The skill is addressed by its `SKILL.md` locator, as
 * listed for `listProjectId` (the page's project, whose settings files apply; user only when
 * absent). A skill that isn't in that list is refused with 404 `skill_not_found`.
 */
export const SkillSwitchRequest = AgentConfigLocator.extend({
  provider: AgentConfigProvider,
  enabled: z.boolean(),
  listProjectId: Id.optional(),
});
export type SkillSwitchRequest = z.infer<typeof SkillSwitchRequest>;

/** The diff a switch would make, and the scope of the file it writes. */
export const SkillSwitchDiff = AgentConfigDiff.extend({
  /** `user`: applies in every project; `project`: shared with the repository; `local`: you, here. */
  scope: AgentConfigScope,
});
export type SkillSwitchDiff = z.infer<typeof SkillSwitchDiff>;

/** Result of a switch; `file` is null when nothing needed to change. */
export const SkillSwitchResponse = z.object({
  file: z.string().nullable(),
  /** The copy of the file taken before writing; null for a new file or no change. */
  backupPath: z.string().nullable(),
  /** The skills after the change, for the request's `listProjectId`. */
  skills: z.array(AgentSkill),
});
export type SkillSwitchResponse = z.infer<typeof SkillSwitchResponse>;

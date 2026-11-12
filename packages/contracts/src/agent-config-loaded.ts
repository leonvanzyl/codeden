import { z } from "zod";
import {
  AgentConfigFile,
  AgentConfigProvider,
  AgentConfigScope,
  McpServerEntry,
} from "./agent-config";
import { HookEntry, HookSource } from "./agent-config-hooks";
import { Id } from "./common";

/**
 * What's loaded (§12.4): for one session, the memory files, skills, subagents, MCP servers and
 * hooks its provider takes from its working directory. Computed from each provider's discovery
 * rules (not reported by the provider).
 */

/** A skill folder (its `SKILL.md`). */
export const AgentSkill = z.object({
  provider: AgentConfigProvider,
  scope: AgentConfigScope,
  name: z.string(),
  description: z.string().optional(),
  file: AgentConfigFile,
});
export type AgentSkill = z.infer<typeof AgentSkill>;

/**
 * The hooks that apply to a session's working folder. For Claude Code: `~/.claude/settings.json`,
 * the working folder's own `.claude/settings.json` (no parent fallback), and
 * `.claude/settings.local.json` at the repository root (the main checkout's root for a
 * worktree), or beside the shared file on Windows and outside a git repository.
 */
export const LoadedHooks = z.object({
  /** The settings files that apply, lowest precedence first (user, project, local). */
  sources: z.array(HookSource),
  /** The hooks those files define, in the same order. Hooks on CodeDen's shelf don't run and aren't listed. */
  hooks: z.array(HookEntry),
  /**
   * The settings file whose `disableAllHooks: true` wins after precedence (local over project
   * over user), so none of the listed hooks run; null when hooks are on.
   */
  disabledBy: z.string().nullable(),
});
export type LoadedHooks = z.infer<typeof LoadedHooks>;

/**
 * `GET /api/sessions/:id/agent-config/loaded`: what the session's provider loads into its
 * context from its working directory, in load order.
 */
export const LoadedAgentConfig = z.object({
  sessionId: Id,
  provider: z.string(),
  cwd: z.string(),
  /** Memory, rule and auto-memory files that exist, broadest scope first. */
  memory: z.array(AgentConfigFile),
  skills: z.array(AgentSkill),
  subagents: z.array(AgentConfigFile),
  /** Enabled MCP servers, including CodeDen's own. */
  mcpServers: z.array(McpServerEntry),
  /** Hooks from the provider's settings files; null when its native config has no hooks. */
  hooks: LoadedHooks.nullable(),
});
export type LoadedAgentConfig = z.infer<typeof LoadedAgentConfig>;

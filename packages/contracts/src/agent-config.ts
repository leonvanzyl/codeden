import { z } from "zod";
import { Id, Timestamp } from "./common";

/**
 * Agent configuration screens (§12.4): each provider's own memory files, skills, subagents,
 * MCP servers and hooks (`agent-config-hooks.ts`), edited in place in their native files with
 * a diff preview and a backup before every overwrite or delete. Routes live under
 * `/api/agent-config`.
 */

export const AgentConfigProvider = z.enum(["claude", "codex"]);
export type AgentConfigProvider = z.infer<typeof AgentConfigProvider>;

/** Agent-config screens that exist only for some providers. */
export interface AgentConfigFeatures {
  /** CodeDen lists and edits this provider's hooks (`/api/agent-config/hooks`). */
  hooks: boolean;
  /**
   * The provider's native config can switch a skill off, and CodeDen writes that setting
   * (`/api/agent-config/skills`, `agent-config-skills.ts`).
   */
  skillSwitches: boolean;
}

/**
 * Which optional agent-config screens each provider has. The UI reads this to decide which
 * tabs and choices to offer, and never branches on a provider id (Principle 5).
 */
export const agentConfigFeatures: Record<AgentConfigProvider, AgentConfigFeatures> = {
  claude: { hooks: true, skillSwitches: true },
  codex: { hooks: false, skillSwitches: true },
};

/** The providers that have a given agent-config feature. */
export const providersWith = (feature: keyof AgentConfigFeatures): AgentConfigProvider[] =>
  AgentConfigProvider.options.filter((p) => agentConfigFeatures[p][feature]);

/**
 * - `memory`: CLAUDE.md / CLAUDE.local.md / AGENTS.md files.
 * - `rule`: `.claude/rules/**.md`.
 * - `auto_memory`: files in Claude's auto-memory folder (`MEMORY.md` is the index).
 * - `skill`: a skill's `SKILL.md`. - `subagent`: a subagent definition.
 */
export const AgentConfigKind = z.enum(["memory", "rule", "auto_memory", "skill", "subagent"]);
export type AgentConfigKind = z.infer<typeof AgentConfigKind>;

/** `user`: the user's home config. `project`: shared in the repo. `local`: personal, per project. */
export const AgentConfigScope = z.enum(["user", "project", "local"]);
export type AgentConfigScope = z.infer<typeof AgentConfigScope>;

/**
 * Where a file lives: `home` (relative to the user's home), `project` (relative to a
 * project's checkout) or `auto_memory` (relative to the project's Claude auto-memory folder).
 * Only known agent-config locations are accepted (CLAUDE.md, AGENTS.md, rules, skills,
 * subagents, auto memory); anything else is refused.
 */
export const AgentConfigLocator = z.object({
  root: z.enum(["home", "project", "auto_memory"]),
  /** Required for `project` and `auto_memory`. */
  projectId: Id.optional(),
  /** Relative to the root, `/`-separated. */
  path: z.string().min(1).max(1_000),
});
export type AgentConfigLocator = z.infer<typeof AgentConfigLocator>;

/** One discovered file. */
export const AgentConfigFile = AgentConfigLocator.extend({
  provider: AgentConfigProvider,
  kind: AgentConfigKind,
  scope: AgentConfigScope,
  /** Display name: the file name, or the skill/subagent name. */
  name: z.string(),
  /** `description` from the front matter (skills, subagents). */
  description: z.string().optional(),
  absolutePath: z.string(),
  exists: z.boolean(),
  sizeBytes: z.int().nonnegative(),
  modifiedAt: Timestamp.nullable(),
  /** Loaded only when the agent reads files in that folder (nested CLAUDE.md). */
  onDemand: z.boolean().optional(),
});
export type AgentConfigFile = z.infer<typeof AgentConfigFile>;

/** `GET /api/agent-config/files?projectId=&provider=&kind=`. */
export const AgentConfigListQuery = z.object({
  projectId: Id.optional(),
  provider: AgentConfigProvider.optional(),
  kind: AgentConfigKind.optional(),
});
export type AgentConfigListQuery = z.infer<typeof AgentConfigListQuery>;

export const AgentConfigListResponse = z.object({
  files: z.array(AgentConfigFile),
  /** Claude's auto-memory folder for the project (when `projectId` was given). */
  autoMemoryDir: z.string().nullable(),
});
export type AgentConfigListResponse = z.infer<typeof AgentConfigListResponse>;

/** `GET /api/agent-config/file?root=&projectId=&path=`. Missing files read as empty. */
export const AgentConfigFileContent = AgentConfigLocator.extend({
  absolutePath: z.string(),
  exists: z.boolean(),
  content: z.string(),
  sha256: z.string().nullable(),
});
export type AgentConfigFileContent = z.infer<typeof AgentConfigFileContent>;

/**
 * `PUT /api/agent-config/file` (create or overwrite) and `POST /api/agent-config/file`
 * (create only, 409 `file_exists` if present). `expectedSha256` guards against overwriting
 * a file that changed since the editor loaded it (409 `file_changed`).
 */
export const AgentConfigWriteRequest = AgentConfigLocator.extend({
  content: z.string().max(2 * 1024 * 1024),
  expectedSha256: z.string().nullable().optional(),
});
export type AgentConfigWriteRequest = z.infer<typeof AgentConfigWriteRequest>;

/** Result of a write or delete; `backupPath` is the copy taken first (null for new files). */
export const AgentConfigWriteResponse = z.object({
  file: AgentConfigFileContent,
  backupPath: z.string().nullable(),
});
export type AgentConfigWriteResponse = z.infer<typeof AgentConfigWriteResponse>;

/** `DELETE /api/agent-config/file?root=&projectId=&path=` (`&folder=1` deletes a skill folder). */
export const AgentConfigDeleteQuery = AgentConfigLocator.extend({
  folder: z.enum(["0", "1"]).optional(),
});
export type AgentConfigDeleteQuery = z.infer<typeof AgentConfigDeleteQuery>;

export const AgentConfigDeleteResponse = z.object({
  deleted: z.boolean(),
  backupPath: z.string().nullable(),
});
export type AgentConfigDeleteResponse = z.infer<typeof AgentConfigDeleteResponse>;

/** A unified diff preview of a proposed change. */
export const AgentConfigDiff = z.object({
  absolutePath: z.string(),
  exists: z.boolean(),
  patch: z.string(),
  additions: z.int().nonnegative(),
  deletions: z.int().nonnegative(),
  changed: z.boolean(),
});
export type AgentConfigDiff = z.infer<typeof AgentConfigDiff>;

/** `POST /api/agent-config/diff`: preview writing `content` (body: `AgentConfigWriteRequest`). */
export const AgentConfigDiffRequest = AgentConfigLocator.extend({
  content: z.string().max(2 * 1024 * 1024),
});
export type AgentConfigDiffRequest = z.infer<typeof AgentConfigDiffRequest>;

// ------------------------------------------------------------------------- MCP servers

/** Where an MCP server is configured. */
export const McpConfigScope = z.enum(["user", "local", "project"]);
export type McpConfigScope = z.infer<typeof McpConfigScope>;

/** A provider-neutral MCP server definition. Unknown native fields are kept in `extra`. */
export const McpServerSpec = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("stdio"),
    command: z.string().min(1),
    args: z.array(z.string()).optional(),
    env: z.record(z.string(), z.string()).optional(),
    cwd: z.string().optional(),
    enabled: z.boolean().optional(),
    extra: z.record(z.string(), z.unknown()).optional(),
  }),
  z.object({
    type: z.enum(["http", "sse"]),
    url: z.string().min(1),
    headers: z.record(z.string(), z.string()).optional(),
    /** Codex: name of the environment variable that holds a bearer token. */
    bearerTokenEnvVar: z.string().optional(),
    enabled: z.boolean().optional(),
    extra: z.record(z.string(), z.unknown()).optional(),
  }),
]);
export type McpServerSpec = z.infer<typeof McpServerSpec>;

/** One configured MCP server. `codeden` entries are CodeDen's own server (read-only). */
export const McpServerEntry = z.object({
  provider: z.enum(["claude", "codex", "codeden"]),
  scope: McpConfigScope,
  name: z.string(),
  spec: McpServerSpec,
  /** The native file it is defined in. */
  file: z.string(),
  /** Project the entry belongs to (`local` and `project` scopes). */
  projectId: Id.nullable(),
});
export type McpServerEntry = z.infer<typeof McpServerEntry>;

/** `GET /api/agent-config/mcp?projectId=`. */
export const McpServerListResponse = z.object({ servers: z.array(McpServerEntry) });
export type McpServerListResponse = z.infer<typeof McpServerListResponse>;

/**
 * Target of an MCP edit. Claude: `user` (~/.claude.json), `local` (~/.claude.json, this
 * project) and `project` (`.mcp.json`). Codex: `user` (~/.codex/config.toml).
 */
export const McpServerTarget = z.object({
  provider: AgentConfigProvider,
  scope: McpConfigScope,
  projectId: Id.optional(),
  name: z
    .string()
    .min(1)
    .max(100)
    .regex(/^[A-Za-z0-9_.-]+$/),
});
export type McpServerTarget = z.infer<typeof McpServerTarget>;

/** `PUT /api/agent-config/mcp`: add or replace one server (other settings are kept). */
export const McpServerUpsertRequest = McpServerTarget.extend({ spec: McpServerSpec });
export type McpServerUpsertRequest = z.infer<typeof McpServerUpsertRequest>;

/** `POST /api/agent-config/mcp/diff`: preview an upsert (with `spec`) or a removal (without). */
export const McpServerDiffRequest = McpServerTarget.extend({ spec: McpServerSpec.optional() });
export type McpServerDiffRequest = z.infer<typeof McpServerDiffRequest>;

/** Result of an MCP upsert or delete. */
export const McpServerWriteResponse = z.object({
  file: z.string(),
  backupPath: z.string().nullable(),
  servers: z.array(McpServerEntry),
});
export type McpServerWriteResponse = z.infer<typeof McpServerWriteResponse>;

// The "what's loaded" view of a session is in `agent-config-loaded.ts`.

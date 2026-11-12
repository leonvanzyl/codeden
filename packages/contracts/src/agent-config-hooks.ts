import { z } from "zod";
import { AgentConfigProvider, AgentConfigScope } from "./agent-config";
import { Id, Timestamp } from "./common";

/**
 * Hooks (§12.4): commands a provider runs on lifecycle events (before or after a tool call, on
 * prompt submit, on stop, at session start, …). Claude Code keeps them in the `hooks` key of its
 * settings files: `~/.claude/settings.json` (user), `.claude/settings.json` (project, shared)
 * and `.claude/settings.local.json` (local). CodeDen edits only that key, in place, with a diff
 * preview and a backup. Only providers with `agentConfigFeatures[p].hooks` are listed.
 *
 * Native shape: `hooks: { [event]: [{ matcher?, hooks: [handler, …] }, …] }`.
 *
 * Claude Code has no per-hook switch, so "disable" takes the hook out of the file and keeps it
 * on CodeDen's shelf (`<codeden home>/agent-config/disabled-hooks.json`); "enable" writes it
 * back. The settings file always shows exactly what runs.
 *
 * Routes: `GET /api/agent-config/hooks?projectId=`, `POST /api/agent-config/hooks/diff` and
 * `POST /api/agent-config/hooks` (both take a `HookChangeRequest`).
 */

/** Claude Code's documented hook events, most used first. Suggestions only: any name is kept. */
export const KNOWN_CLAUDE_HOOK_EVENTS = [
  "PreToolUse",
  "PostToolUse",
  "PostToolUseFailure",
  "UserPromptSubmit",
  "Stop",
  "SubagentStop",
  "SessionStart",
  "SessionEnd",
  "Notification",
  "PermissionRequest",
  "PermissionDenied",
  "PreCompact",
  "PostCompact",
  "SubagentStart",
  "StopFailure",
  "PostToolBatch",
  "UserPromptExpansion",
  "MessageDisplay",
  "TaskCreated",
  "TaskCompleted",
  "TeammateIdle",
  "InstructionsLoaded",
  "ConfigChange",
  "CwdChanged",
  "FileChanged",
  "WorktreeCreate",
  "WorktreeRemove",
  "Elicitation",
  "ElicitationResult",
  "Setup",
] as const;

/** A hook event name as written in a request (`PreToolUse`, …). */
export const HookEventName = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[A-Za-z]+$/);

/**
 * One hook handler, as stored natively. `type` is `command`, `http`, `mcp_tool`, `prompt`,
 * `agent` or a newer type. Every other native field (`if`, `statusMessage`, `async`, `headers`,
 * `allowedEnvVars`, …) is kept as is.
 */
export const HookHandler = z.looseObject({
  type: z.string().min(1).max(40),
  /** `command` hooks: the shell command. */
  command: z.string().optional(),
  /** `http` hooks: the URL the event is posted to. */
  url: z.string().optional(),
  /** `prompt` and `agent` hooks: the prompt. */
  prompt: z.string().optional(),
  /** Seconds before the hook is cancelled (the provider's default when absent). */
  timeout: z.number().optional(),
});
export type HookHandler = z.infer<typeof HookHandler>;

/** The field each editable hook type can't do without. */
export const HOOK_TYPE_MAIN_FIELD = {
  command: "command",
  http: "url",
  prompt: "prompt",
  agent: "prompt",
} as const satisfies Record<string, "command" | "url" | "prompt">;

/** A handler to write: its type's main field is set and the timeout is positive. */
export const HookHandlerInput = HookHandler.superRefine((h, ctx) => {
  const field = (HOOK_TYPE_MAIN_FIELD as Record<string, "command" | "url" | "prompt">)[h.type];
  if (field && !h[field]?.trim()) {
    ctx.addIssue({ code: "custom", path: [field], message: `A ${h.type} hook needs a ${field}` });
  }
  if (h.timeout !== undefined && !(h.timeout > 0)) {
    ctx.addIssue({ code: "custom", path: ["timeout"], message: "The timeout must be positive" });
  }
});

/** One settings file that holds hooks. */
export const HookSource = z.object({
  provider: AgentConfigProvider,
  scope: AgentConfigScope,
  /** Project the file belongs to (`project` and `local` scopes). */
  projectId: Id.nullable(),
  /** Absolute path of the settings file. */
  file: z.string(),
  exists: z.boolean(),
  /** The file sets `disableAllHooks: true`: none of its hooks run. */
  disableAllHooks: z.boolean(),
  /**
   * Set when the file can't be used: it doesn't parse, or it resolves (through a link) outside
   * its scope's folder. Its hooks are then not listed and it can't be written.
   */
  error: z.string().optional(),
});
export type HookSource = z.infer<typeof HookSource>;

/**
 * One hook handler. Active hooks are addressed by their position in `hooks[event]`
 * (`groupIndex`, `handlerIndex`); disabled ones live on CodeDen's shelf (`shelfId`).
 */
export const HookEntry = z.object({
  provider: AgentConfigProvider,
  scope: AgentConfigScope,
  projectId: Id.nullable(),
  /** The settings file it is (or, when disabled, was) defined in. */
  file: z.string(),
  event: z.string(),
  /**
   * Tool name or regex the group matches, exactly as written; null when the group has none or
   * an empty one (matches all).
   */
  matcher: z.string().nullable(),
  handler: HookHandler,
  /** False for a hook CodeDen took out of the file; it does not run. */
  enabled: z.boolean(),
  groupIndex: z.int().nonnegative().optional(),
  handlerIndex: z.int().nonnegative().optional(),
  shelfId: z.string().optional(),
});
export type HookEntry = z.infer<typeof HookEntry>;

/** `GET /api/agent-config/hooks?projectId=`: user hooks, plus the project's when given. */
export const HookListResponse = z.object({
  sources: z.array(HookSource),
  hooks: z.array(HookEntry),
});
export type HookListResponse = z.infer<typeof HookListResponse>;

/**
 * An active hook as listed: its file (provider, scope, project) and position, plus the handler
 * as it was read. A change is refused with 409 `hook_changed` if the handler there differs now.
 */
export const HookTarget = z.object({
  provider: AgentConfigProvider,
  scope: AgentConfigScope,
  projectId: Id.optional(),
  event: z.string().min(1).max(64),
  groupIndex: z.int().nonnegative(),
  handlerIndex: z.int().nonnegative(),
  expected: HookHandler,
});
export type HookTarget = z.infer<typeof HookTarget>;

/** A disabled hook on CodeDen's shelf. */
export const ShelvedHookRef = z.object({ shelfId: z.string().min(1).max(100) });
export type ShelvedHookRef = z.infer<typeof ShelvedHookRef>;

/** Where a hook goes: event, optional matcher, handler. */
const HookPlacement = {
  event: HookEventName,
  /**
   * Tool name or regex, written exactly as given (whitespace can matter in a regex). Omitted or
   * empty: the group has no matcher (matches everything).
   */
  matcher: z.string().max(1_000).optional(),
  handler: HookHandlerInput,
};

/** Every change also says which list to return in `HookWriteResponse.hooks`. */
const HookListView = {
  /** The project whose hooks to list in the response (the page's selection); user only if absent. */
  listProjectId: Id.optional(),
};

/**
 * A change to one hook, previewed with `POST /api/agent-config/hooks/diff` (-> `AgentConfigDiff`)
 * and applied with `POST /api/agent-config/hooks` (-> `HookWriteResponse`):
 * - `add`: append to the first group in `event` with the same matcher, or a new group.
 * - `update`: replace in place, or move when the event or matcher changes.
 * - `remove`: delete from the file, or drop a disabled hook from the shelf.
 * - `disable`: take it out of the file onto CodeDen's shelf. `enable`: write it back.
 * Groups and events left empty are removed.
 */
export const HookChangeRequest = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("add"),
    provider: AgentConfigProvider,
    scope: AgentConfigScope,
    projectId: Id.optional(),
    ...HookPlacement,
    ...HookListView,
  }),
  z.object({
    action: z.literal("update"),
    target: HookTarget,
    ...HookPlacement,
    ...HookListView,
  }),
  z.object({
    action: z.literal("remove"),
    target: z.union([HookTarget, ShelvedHookRef]),
    ...HookListView,
  }),
  z.object({ action: z.literal("disable"), target: HookTarget, ...HookListView }),
  z.object({ action: z.literal("enable"), target: ShelvedHookRef, ...HookListView }),
]);
export type HookChangeRequest = z.infer<typeof HookChangeRequest>;

/**
 * A hook taken out of its settings file by "disable", kept on CodeDen's shelf
 * (`<codeden home>/agent-config/disabled-hooks.json`, `{ "hooks": ShelvedHook[] }`) until it is
 * enabled (written back to the same scope) or removed.
 */
export const ShelvedHook = z.object({
  id: z.string().min(1).max(100),
  provider: AgentConfigProvider,
  scope: AgentConfigScope,
  projectId: Id.nullable(),
  /** The settings file it came from (shown in the list). */
  file: z.string(),
  event: z.string().min(1),
  matcher: z.string().nullable(),
  handler: HookHandler,
  disabledAt: Timestamp,
});
export type ShelvedHook = z.infer<typeof ShelvedHook>;

/** Result of a hook change; `backupPath` is the copy of the settings file taken first. */
export const HookWriteResponse = z.object({
  /** The settings file written, or null when only the shelf changed. */
  file: z.string().nullable(),
  backupPath: z.string().nullable(),
  /** The hooks after the change, for the request's `listProjectId`. */
  hooks: HookListResponse,
});
export type HookWriteResponse = z.infer<typeof HookWriteResponse>;

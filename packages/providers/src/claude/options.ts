import { readFileSync } from "node:fs";
import type {
  CanUseTool,
  EffortLevel,
  HookCallbackMatcher,
  HookEvent,
  Options,
  SDKUserMessage,
  McpServerConfig as SdkMcpServerConfig,
} from "@anthropic-ai/claude-agent-sdk";
import {
  CODEDEN_VERSION,
  type McpServerConfig,
  type ReasoningEffort,
  type SessionOptions,
  type UserInput,
} from "@codeden/contracts";
import { agentEnv } from "../util/agent-env";
import type { ResolvedCommand } from "../util/exec";
import { explicitModel } from "../util/model";
import { permissionModeFor } from "./permissions";
import { EDIT_TOOLS } from "./tools";

/** Map a CodeDen effort to Claude's effort levels (`minimal` has no Claude equivalent). */
export function claudeEffort(effort: ReasoningEffort | undefined): EffortLevel | undefined {
  if (!effort) return undefined;
  return effort === "minimal" ? "low" : effort;
}

/** CodeDen MCP server configs -> Claude `mcpServers`. */
export function claudeMcpServers(
  servers: readonly McpServerConfig[],
): Record<string, SdkMcpServerConfig> {
  const out: Record<string, SdkMcpServerConfig> = {};
  for (const server of servers) {
    out[server.name] =
      server.transport === "http"
        ? { type: "http", url: server.url, ...(server.headers ? { headers: server.headers } : {}) }
        : {
            type: "stdio",
            command: server.command,
            args: server.args,
            ...(server.env ? { env: server.env } : {}),
          };
  }
  return out;
}

/** Allow every tool of trusted MCP servers (CodeDen's own) without permission prompts. */
export function trustedMcpTools(
  servers: readonly McpServerConfig[],
): Pick<Options, "allowedTools"> {
  const allowed = servers
    .filter((s) => s.transport === "http" && s.trusted)
    .map((s) => `mcp__${s.name}`);
  return allowed.length > 0 ? { allowedTools: allowed } : {};
}

/** Point the SDK at the user's installed `claude` (native binary or JS entry point). */
export function executableOptions(
  cmd: ResolvedCommand,
): Pick<Options, "pathToClaudeCodeExecutable" | "executable"> {
  if (cmd.kind === "native") return { pathToClaudeCodeExecutable: cmd.path };
  if (cmd.kind === "node-script")
    return { pathToClaudeCodeExecutable: cmd.script, executable: "node" };
  throw new Error(
    `Cannot launch ${cmd.path} directly. Install Claude Code with its native installer or npm.`,
  );
}

/**
 * Environment for the Claude process: the user's env (`agentEnv`) plus session extras. The
 * entrypoint is always `sdk-ts`, which keeps CodeDen's sessions out of Claude Code's own
 * `/resume` pickers. The SDK only sets it when unset, so a CodeDen started from a Claude Code
 * terminal would otherwise pass on that terminal's `cli`.
 */
export function claudeEnv(
  extra: Record<string, string> | undefined,
): Record<string, string | undefined> {
  return {
    ...agentEnv(extra),
    CLAUDE_AGENT_SDK_CLIENT_APP: `codeden/${CODEDEN_VERSION}`,
    CLAUDE_CODE_ENTRYPOINT: "sdk-ts",
  };
}

export interface QueryOptionsInput {
  session: SessionOptions;
  executable: ResolvedCommand;
  canUseTool: CanUseTool;
  hooks: Partial<Record<HookEvent, HookCallbackMatcher[]>>;
  abortController: AbortController;
  resume?: string;
  stderr?: (data: string) => void;
}

/** Build the `query()` options for a session (§7.2). */
export function buildQueryOptions(input: QueryOptionsInput): Options {
  const { session } = input;
  const permissionMode = permissionModeFor(session.autonomy, session.planMode);
  // Under Full, a session that starts in plan mode switches to `bypassPermissions` once the
  // plan is approved, which the CLI only accepts when it was launched allowing it.
  const bypass = permissionModeFor(session.autonomy, false) === "bypassPermissions";
  const effort = claudeEffort(session.effort);
  return {
    ...executableOptions(input.executable),
    cwd: session.cwd,
    additionalDirectories: session.additionalDirectories,
    ...(explicitModel(session.model) ? { model: explicitModel(session.model) } : {}),
    ...(effort ? { effort } : {}),
    permissionMode,
    ...(bypass ? { allowDangerouslySkipPermissions: true } : {}),
    includePartialMessages: true,
    forwardSubagentText: true,
    ...(input.resume ? { resume: input.resume } : {}),
    // Read-only sessions (orchestrator, PMs) never get the edit tools (§11.2).
    ...(session.readOnly ? { disallowedTools: [...EDIT_TOOLS] } : {}),
    mcpServers: claudeMcpServers(session.mcpServers),
    ...trustedMcpTools(session.mcpServers),
    systemPrompt: {
      type: "preset",
      preset: "claude_code",
      ...(session.systemPrompt ? { append: session.systemPrompt } : {}),
    },
    env: claudeEnv(session.env),
    canUseTool: input.canUseTool,
    hooks: input.hooks,
    abortController: input.abortController,
    ...(input.stderr ? { stderr: input.stderr } : {}),
  };
}

type ContentBlock =
  | { type: "text"; text: string }
  | { type: "image"; source: { type: "base64"; media_type: string; data: string } };

/** Convert CodeDen `UserInput` (text, images, file references) to an SDK user message. */
export function toSdkUserMessage(input: UserInput): SDKUserMessage {
  const blocks: ContentBlock[] = [];
  const fileRefs: string[] = [];
  for (const attachment of input.attachments) {
    if (attachment.type === "file") {
      fileRefs.push(attachment.path);
      continue;
    }
    const source = attachment.source;
    if (source.type === "base64") {
      blocks.push({
        type: "image",
        source: { type: "base64", media_type: attachment.mediaType, data: source.data },
      });
    } else if (source.type === "path") {
      const data = readFileSync(source.path).toString("base64");
      blocks.push({
        type: "image",
        source: { type: "base64", media_type: attachment.mediaType, data },
      });
    } else {
      throw new Error("Artifact attachments must be resolved to a path or base64 before sending");
    }
  }
  const text = fileRefs.length
    ? `${input.text}\n\nAttached files:\n${fileRefs.map((p) => `- ${p}`).join("\n")}`
    : input.text;
  const content = blocks.length ? [{ type: "text" as const, text }, ...blocks] : text;
  return {
    type: "user",
    message: { role: "user", content: content as SDKUserMessage["message"]["content"] },
    parent_tool_use_id: null,
  };
}

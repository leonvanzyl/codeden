/**
 * The subset of the Agent Client Protocol (ACP, protocol version 1) CodeDen speaks as a
 * client: JSON-RPC 2.0 over the agent's stdio, one message per line. Typed by hand from the
 * specification (https://agentclientprotocol.com) rather than through an SDK, so unknown
 * update kinds and vendor fields pass through untouched. Fields agents may leave out are
 * optional; everything read from the agent is checked before use.
 */

/** The protocol version CodeDen negotiates. */
export const ACP_PROTOCOL_VERSION = 1;

export type AcpRequestId = number | string;

/** `initialize` result: what the agent supports. */
export interface AcpInitializeResult {
  protocolVersion?: number;
  agentCapabilities?: {
    loadSession?: boolean;
    promptCapabilities?: { image?: boolean; audio?: boolean; embeddedContext?: boolean };
    mcpCapabilities?: { http?: boolean; sse?: boolean };
    /**
     * Session features beyond version 1's core. `subagents` (an object) means the agent runs
     * its subagents as child sessions, because the client opted in (`clientCapabilities`).
     */
    sessionCapabilities?: { subagents?: unknown; list?: unknown } | null;
  };
  authMethods?: { id: string; name?: string; description?: string }[];
  agentInfo?: { name?: string; version?: string };
}

/** An MCP server handed to the agent in `session/new` and `session/load`. */
export type AcpMcpServer =
  | { type: "http"; name: string; url: string; headers: { name: string; value: string }[] }
  | {
      name: string;
      command: string;
      args: string[];
      env: { name: string; value: string }[];
    };

/** A session mode (`agent`, `plan`, `ask`, ...). */
export interface AcpMode {
  id: string;
  name?: string;
  description?: string;
}

/** One value of a `select` config option. */
export interface AcpConfigValue {
  value: string;
  name?: string;
  description?: string;
}

/**
 * A session config option (mode, model, thought level, ...). Version 1 names it `id`; later
 * drafts `configId`. `options` may be grouped (`{ group, name, options }`).
 */
export interface AcpConfigOption {
  id?: string;
  configId?: string;
  name?: string;
  category?: string;
  type?: string;
  currentValue?: unknown;
  options?: (AcpConfigValue | { group?: string; name?: string; options?: AcpConfigValue[] })[];
}

/** `session/new` and `session/load` results (all optional; `session/load` may return `{}`). */
export interface AcpSessionSetup {
  sessionId?: string;
  modes?: { currentModeId?: string; availableModes?: AcpMode[] } | null;
  models?: {
    currentModelId?: string;
    availableModels?: { modelId: string; name?: string; description?: string }[];
  } | null;
  configOptions?: AcpConfigOption[] | null;
}

/** A content block in a prompt or a message chunk. */
export type AcpContentBlock =
  | { type: "text"; text: string }
  | { type: "image"; mimeType: string; data: string; uri?: string }
  | { type: "resource_link"; uri: string; name: string; mimeType?: string }
  | { type: string; [key: string]: unknown };

/** `session/prompt` result. */
export interface AcpPromptResult {
  stopReason?: "end_turn" | "max_tokens" | "max_turn_requests" | "refusal" | "cancelled" | string;
  /** Token counts, where the agent reports them (an unstable addition to version 1). */
  usage?: {
    inputTokens?: number;
    outputTokens?: number;
    thoughtTokens?: number;
    cachedReadTokens?: number;
    cachedWriteTokens?: number;
    totalTokens?: number;
  } | null;
}

/** What a tool call does; drives how it is shown and how its permission is judged. */
export type AcpToolKind =
  | "read"
  | "edit"
  | "delete"
  | "move"
  | "search"
  | "execute"
  | "think"
  | "fetch"
  | "switch_mode"
  | "other";

export type AcpToolStatus = "pending" | "in_progress" | "completed" | "failed";

/** Content a tool call produced: text or other content, a diff, or an embedded terminal. */
export type AcpToolContent =
  | { type: "content"; content: AcpContentBlock }
  | { type: "diff"; path: string; oldText?: string | null; newText: string }
  | { type: "terminal"; terminalId: string }
  | { type: string; [key: string]: unknown };

/** A tool call as `tool_call` reports it, and the fields a `tool_call_update` may patch. */
export interface AcpToolCall {
  toolCallId: string;
  title?: string | null;
  kind?: AcpToolKind | string | null;
  status?: AcpToolStatus | null;
  content?: AcpToolContent[] | null;
  locations?: { path: string; line?: number | null }[] | null;
  rawInput?: unknown;
  rawOutput?: unknown;
}

/** One entry of an agent's `plan` update. */
export interface AcpPlanEntry {
  content: string;
  priority?: string;
  status?: "pending" | "in_progress" | "completed" | string;
}

/** The `update` of a `session/update` notification. Unknown kinds are ignored. */
export type AcpSessionUpdate =
  | { sessionUpdate: "user_message_chunk"; content: AcpContentBlock }
  | { sessionUpdate: "agent_message_chunk"; content: AcpContentBlock; messageId?: string }
  | { sessionUpdate: "agent_thought_chunk"; content: AcpContentBlock; messageId?: string }
  | ({ sessionUpdate: "tool_call" } & AcpToolCall)
  | ({ sessionUpdate: "tool_call_update" } & AcpToolCall)
  | { sessionUpdate: "plan"; entries: AcpPlanEntry[] }
  | { sessionUpdate: "current_mode_update"; currentModeId: string }
  | { sessionUpdate: "config_option_update"; configOptions: AcpConfigOption[] }
  | {
      sessionUpdate: "available_commands_update";
      availableCommands: { name: string; description?: string }[];
    }
  | {
      sessionUpdate: "usage_update";
      used?: number;
      size?: number;
      cost?: { amount?: number; currency?: string } | null;
    }
  | AcpSubagentSpawned
  | AcpSubagentStateUpdate
  | { sessionUpdate: string; [key: string]: unknown };

/**
 * A subagent started as a child session (agents that accepted the `subagents` client
 * capability). Sent on the parent's session; the child's own updates and requests then arrive
 * under `subagentSessionId`. Vendor details (a parent tool call id, the subagent type) may sit
 * in `_meta.<vendor>`.
 */
export interface AcpSubagentSpawned {
  sessionUpdate: "subagent_spawned";
  subagentSessionId: string;
  name?: string;
  task?: string;
  capabilities?: Record<string, unknown> | null;
  _meta?: Record<string, unknown> | null;
}

/** A child session's state changed; `completed`, `failed`, `cancelled` and `disconnected` end it. */
export interface AcpSubagentStateUpdate {
  sessionUpdate: "subagent_state_update";
  subagentSessionId: string;
  state: "completed" | "failed" | "cancelled" | "disconnected" | string;
  _meta?: Record<string, unknown> | null;
}

export interface AcpSessionNotification {
  sessionId: string;
  update: AcpSessionUpdate;
}

/** A permission option offered by `session/request_permission`. */
export interface AcpPermissionOption {
  optionId: string;
  name?: string;
  kind: "allow_once" | "allow_always" | "reject_once" | "reject_always" | string;
}

/** `session/request_permission` params. */
export interface AcpPermissionRequest {
  sessionId: string;
  toolCall: AcpToolCall;
  options: AcpPermissionOption[];
}

/** `session/request_permission` result. */
export interface AcpPermissionResult {
  outcome: { outcome: "selected"; optionId: string } | { outcome: "cancelled" };
}

/** An agent -> client request or notification as it arrived. */
export interface AcpIncoming {
  method: string;
  params: unknown;
}

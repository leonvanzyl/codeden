import { pathToFileURL } from "node:url";
import type { McpServerConfig, ReasoningEffort, UserInput } from "@codeden/contracts";
import { explicitModel } from "../util/model";
import { pluginConfigPath } from "./plugin";
import type { OcModelRef, OcPermissionRule } from "./protocol";

/**
 * The inline config (`OPENCODE_CONFIG_CONTENT`) for a session's server, layered over the
 * user's own OpenCode config: CodeDen's MCP servers and the env-guard plugin.
 */
export function openCodeConfig(opts: {
  mcpServers: readonly McpServerConfig[];
  pluginDir?: string;
}): Record<string, unknown> {
  const servers: Record<string, unknown> = {};
  for (const server of opts.mcpServers) servers[mcpName(server.name)] = mcpServerConfig(server);
  return {
    ...(opts.pluginDir ? { plugins: [pluginConfigPath(opts.pluginDir)] } : {}),
    ...(opts.mcpServers.length ? { mcp: { servers } } : {}),
  };
}

/** MCP server names become tool-name prefixes (`<server>_<tool>`); keep them simple. */
export function mcpName(name: string): string {
  return name.replace(/[^A-Za-z0-9_-]/g, "_");
}

/**
 * One MCP server in OpenCode's v2 config. `codemode: false` lists the tools directly instead
 * of behind OpenCode's `execute` tool, so CodeDen's tools show up (and are approved) as
 * themselves. `oauth: false`: the headers carry CodeDen's bearer token.
 */
export function mcpServerConfig(server: McpServerConfig): Record<string, unknown> {
  if (server.transport === "http") {
    return {
      type: "remote",
      url: server.url,
      ...(server.headers ? { headers: server.headers } : {}),
      oauth: false,
      codemode: false,
      ...(server.toolTimeoutSec ? { timeout: server.toolTimeoutSec * 1000 } : {}),
    };
  }
  return {
    type: "local",
    command: [server.command, ...server.args],
    ...(server.env ? { environment: server.env } : {}),
    codemode: false,
  };
}

/**
 * The session's permission rules (appended after the agent's own, and the last match wins).
 * Every edit, command, path outside the worktree and web fetch asks, and CodeDen decides each
 * ask with its own policy (`OpenCodePolicy`): approved on the spot, refused, or shown to the
 * user. Because the rules never change, an autonomy change applies from the next tool call.
 */
export const SESSION_PERMISSIONS: readonly OcPermissionRule[] = [
  { action: "edit", resource: "*", effect: "ask" },
  { action: "shell", resource: "*", effect: "ask" },
  { action: "external_directory", resource: "*", effect: "ask" },
  { action: "webfetch", resource: "*", effect: "ask" },
];

/**
 * A CodeDen model id (`<providerID>/<modelID>`, as `opencode run -m` takes it) as an OpenCode
 * model reference; undefined for "default" (OpenCode's configured model) or a malformed id.
 * The model id itself may contain slashes (`lmstudio/openai/gpt-oss-20b`).
 */
export function modelRef(
  model: string | null | undefined,
  variant?: string,
): OcModelRef | undefined {
  const id = explicitModel(model);
  if (!id) return undefined;
  const slash = id.indexOf("/");
  if (slash <= 0 || slash === id.length - 1) return undefined;
  return {
    providerID: id.slice(0, slash),
    id: id.slice(slash + 1),
    ...(variant ? { variant } : {}),
  };
}

/** The CodeDen model id for an OpenCode model reference. */
export function modelId(ref: Pick<OcModelRef, "providerID" | "id">): string {
  return `${ref.providerID}/${ref.id}`;
}

/**
 * CodeDen effort -> OpenCode variant. Variants are per model; an effort the model doesn't
 * offer falls back to the closest one below it, then above it, else the model's default.
 */
export function openCodeVariant(
  effort: ReasoningEffort | null | undefined,
  supported?: readonly ReasoningEffort[],
): string | undefined {
  if (!effort) return undefined;
  if (!supported) return effort;
  if (supported.includes(effort)) return effort;
  const order: ReasoningEffort[] = ["minimal", "low", "medium", "high", "xhigh", "max"];
  const at = order.indexOf(effort);
  for (let i = at - 1; i >= 0; i--)
    if (supported.includes(order[i] as ReasoningEffort)) return order[i];
  for (let i = at + 1; i < order.length; i++)
    if (supported.includes(order[i] as ReasoningEffort)) return order[i];
  return undefined;
}

/** `POST /session/:id/prompt` body for a CodeDen `UserInput`. */
export interface OcPromptBody {
  text: string;
  files?: { uri: string; name?: string }[];
  delivery?: "steer" | "queue";
}

/** CodeDen input -> prompt body. Files and images go as `file://` or `data:` URIs. */
export function toPromptBody(input: UserInput, delivery?: "steer" | "queue"): OcPromptBody {
  const files: { uri: string; name?: string }[] = [];
  for (const attachment of input.attachments) {
    if (attachment.type === "file") {
      files.push({
        uri: pathToFileURL(attachment.path).href,
        ...(attachment.name ? { name: attachment.name } : {}),
      });
      continue;
    }
    const source = attachment.source;
    if (source.type === "path") files.push({ uri: pathToFileURL(source.path).href });
    else if (source.type === "base64")
      files.push({ uri: `data:${attachment.mediaType};base64,${source.data}` });
    else
      throw new Error("Artifact attachments must be resolved to a path or base64 before sending");
  }
  return {
    text: input.text,
    ...(files.length ? { files } : {}),
    ...(delivery ? { delivery } : {}),
  };
}

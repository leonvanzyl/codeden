import type {
  AutonomyLevel,
  McpServerConfig,
  ReasoningEffort,
  SessionOptions,
  UserInput,
} from "@codeden/contracts";
import { osTempRoots } from "../policy/paths";
import type { JsonValue } from "./protocol/serde_json/JsonValue";
import type {
  AskForApproval,
  UserInput as CodexUserInput,
  SandboxMode,
  SandboxPolicy,
} from "./protocol/v2";

/**
 * Native sandbox + approval policy per autonomy level (§11.2):
 * - read_only  -> read-only sandbox + `never`: writes fail instead of asking, no network
 * - supervised -> `untrusted`: every command that isn't known-safe and every patch asks
 * - auto       -> workspace-write sandbox + `on-request`: the sandbox confines writes (to the
 *                 worktree, extra roots and the OS temp directory) and network; what Codex asks
 *                 to run outside it goes through CodeDen's risk classifier (`./policy`), so
 *                 `git commit` or `pnpm install` is approved by policy and only risky actions
 *                 reach the user
 * - full       -> workspace-write + `on-request`, with network on: the same, and only writes
 *                 outside the worktree reach the user (with `never`, `git commit` could not run
 *                 at all: the sandbox keeps `.git` read-only)
 */
export function codexPolicy(
  autonomy: AutonomyLevel,
  readOnly = false,
): {
  approvalPolicy: AskForApproval;
  sandbox: SandboxMode;
  networkAccess: boolean;
} {
  // Read-only sessions (orchestrator, PMs, and the `read_only` level, §11.2): the sandbox
  // refuses every write, commits and pushes included; commands such as tests still run.
  if (readOnly || autonomy === "read_only")
    return { approvalPolicy: "never", sandbox: "read-only", networkAccess: false };
  if (autonomy === "supervised")
    return { approvalPolicy: "untrusted", sandbox: "workspace-write", networkAccess: false };
  if (autonomy === "auto")
    return { approvalPolicy: "on-request", sandbox: "workspace-write", networkAccess: false };
  return { approvalPolicy: "on-request", sandbox: "workspace-write", networkAccess: true };
}

type PolicyOptions = Pick<SessionOptions, "autonomy" | "readOnly" | "additionalDirectories">;

/**
 * Extra writable roots for the workspace-write sandbox: the session's additional directories,
 * plus the OS temp directories in `auto` and `full`, so writing a log or scratch file there
 * never needs an approval (§11.2).
 */
export function codexWritableRoots(
  opts: PolicyOptions,
  tempRoots: readonly string[] = osTempRoots(),
): string[] {
  const temp =
    opts.readOnly || opts.autonomy === "read_only" || opts.autonomy === "supervised"
      ? []
      : tempRoots;
  return [...new Set([...opts.additionalDirectories, ...temp])];
}

/**
 * The `turn/start` sandbox override for an autonomy level: the same sandbox `thread/start`
 * configures, so a mid-session change applies from the next turn.
 */
export function codexSandboxPolicy(
  opts: PolicyOptions,
  tempRoots: readonly string[] = osTempRoots(),
): SandboxPolicy {
  const { sandbox, networkAccess } = codexPolicy(opts.autonomy, opts.readOnly);
  if (sandbox === "read-only") return { type: "readOnly", networkAccess };
  return {
    type: "workspaceWrite",
    writableRoots: codexWritableRoots(opts, tempRoots),
    networkAccess,
    excludeTmpdirEnvVar: false,
    excludeSlashTmp: false,
  };
}

/**
 * Config overrides for `thread/start` / `thread/resume` (same semantics as `-c key=value`).
 * Sent over stdin as JSON, so MCP bearer tokens never appear on a command line.
 */
export function codexConfigOverrides(
  opts: SessionOptions,
  tempRoots: readonly string[] = osTempRoots(),
): Record<string, JsonValue> {
  const { networkAccess } = codexPolicy(opts.autonomy, opts.readOnly);
  const config: Record<string, JsonValue> = {
    "sandbox_workspace_write.network_access": networkAccess,
  };
  const roots = codexWritableRoots(opts, tempRoots);
  if (roots.length) config["sandbox_workspace_write.writable_roots"] = roots;
  for (const server of opts.mcpServers) Object.assign(config, mcpOverride(server));
  return config;
}

/** One MCP server as a `mcp_servers.<name>` override. */
export function mcpOverride(server: McpServerConfig): Record<string, JsonValue> {
  const key = `mcp_servers.${server.name}`;
  if (server.transport === "http") {
    return {
      [key]: {
        url: server.url,
        ...(server.headers ? { http_headers: server.headers } : {}),
        ...(server.toolTimeoutSec ? { tool_timeout_sec: server.toolTimeoutSec } : {}),
        // CodeDen's own tools run without per-call approval prompts.
        ...(server.trusted ? { default_tools_approval_mode: "approve" } : {}),
      },
    };
  }
  return {
    [key]: {
      command: server.command,
      args: server.args,
      ...(server.env ? { env: server.env } : {}),
    },
  };
}

/** CodeDen `UserInput` -> Codex turn input. */
export function toCodexInput(input: UserInput): CodexUserInput[] {
  const parts: CodexUserInput[] = [{ type: "text", text: input.text, text_elements: [] }];
  for (const attachment of input.attachments) {
    if (attachment.type === "file") {
      parts.push({
        type: "mention",
        name: attachment.name ?? attachment.path,
        path: attachment.path,
      });
      continue;
    }
    const source = attachment.source;
    if (source.type === "path") parts.push({ type: "localImage", path: source.path });
    else if (source.type === "base64") {
      parts.push({ type: "image", url: `data:${attachment.mediaType};base64,${source.data}` });
    } else {
      throw new Error("Artifact attachments must be resolved to a path or base64 before sending");
    }
  }
  return parts;
}

/**
 * CodeDen effort -> Codex reasoning effort. `max` is sent only to models that list it
 * (`supported`); older models top out at `xhigh`.
 */
export function codexEffort(
  effort: ReasoningEffort | undefined,
  supported?: readonly ReasoningEffort[],
): string | undefined {
  if (!effort) return undefined;
  if (effort !== "max") return effort;
  return supported?.includes("max") ? "max" : "xhigh";
}

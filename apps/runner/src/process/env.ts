import { agentEnv } from "@codeden/providers";

/**
 * Environment for child processes (§15): terminals, setup scripts, git and MCP server tests.
 * The user's environment without CodeDen's own `CODEDEN_*` variables, as agents get it
 * (`agentEnv`), plus `extra`.
 */
export function childEnv(extra: Record<string, string> = {}): Record<string, string> {
  return agentEnv(extra);
}

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

/**
 * Environment variables that carry CodeDen's secrets for one OpenCode server: its password
 * (which can answer the session's own permission requests) and the inline config (which holds
 * the MCP bearer token). The guard plugin removes them from every shell command the agent runs.
 */
export const HIDDEN_ENV_VARS = [
  "OPENCODE_PASSWORD",
  "OPENCODE_SERVER_PASSWORD",
  "OPENCODE_CONFIG_CONTENT",
] as const;

/** The plugin's server entry: an OpenCode v2 server plugin with a shell `create.before` hook. */
export function guardPluginSource(hidden: readonly string[] = HIDDEN_ENV_VARS): string {
  return `// Written by CodeDen: keeps this OpenCode server's secrets out of the agent's shell commands.
const HIDDEN = new Set(${JSON.stringify(hidden.map((name) => name.toUpperCase()))});
export default {
  id: "codeden-env-guard",
  setup: async (ctx) => {
    await ctx.shell.hook("create.before", (event) => {
      for (const key of Object.keys(event.env ?? {})) {
        if (HIDDEN.has(key.toUpperCase())) delete event.env[key];
      }
    });
  },
};
`;
}

let pluginDir: string | undefined;

/**
 * A private directory (created with `mkdtemp`, mode 0700 on POSIX) holding the guard plugin,
 * written once per process and removed when it exits. OpenCode loads local plugins from a
 * directory, through its `server.js`.
 */
export function guardPluginDir(): string {
  if (pluginDir) return pluginDir;
  const dir = mkdtempSync(path.join(tmpdir(), "codeden-opencode-"));
  writeFileSync(path.join(dir, "server.js"), guardPluginSource(), { mode: 0o600 });
  process.once("exit", () => {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // Best effort: a leftover temp folder is harmless.
    }
  });
  pluginDir = dir;
  return dir;
}

/** The plugin path as OpenCode's config expects it (forward slashes on every OS). */
export function pluginConfigPath(dir: string): string {
  return dir.replace(/\\/g, "/");
}

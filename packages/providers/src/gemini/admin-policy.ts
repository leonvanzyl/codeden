import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

/**
 * The admin policy CodeDen starts Gemini CLI with (`--admin-policy`, §11.2). Gemini CLI turns
 * its settings' allow-lists (`tools.allowed`, MCP servers marked `trust` or listed in
 * `mcp.allowed`) and user and workspace policy files into rules that run tools without asking.
 * Admin rules outrank all of them, so with these Gemini CLI still asks before every command,
 * and before every edit and MCP tool outside plan mode, and CodeDen's approval policy decides
 * each one. In plan mode Gemini CLI's own plan rules stay in charge of edits and MCP tools (they
 * allow its plan file); commands ask there too, and CodeDen lets read-only ones run.
 *
 * Gemini CLI ignores `--admin-policy` when the machine has system policies of its own (a
 * `.toml` in its system policies folder): an administrator's policy wins.
 */
export const GEMINI_ADMIN_POLICY = `# Written by CodeDen for its Gemini CLI sessions; rewritten when a session starts.
# Admin rules outrank the allow rules Gemini CLI builds from settings files and from
# user and workspace policy files, so these tools still ask and CodeDen decides each call.

[[rule]]
toolName = "run_shell_command"
decision = "ask_user"
priority = 999

[[rule]]
toolName = ["write_file", "replace"]
decision = "ask_user"
priority = 999
modes = ["default", "autoEdit", "yolo"]

[[rule]]
toolName = "*"
mcpName = "*"
decision = "ask_user"
priority = 999
modes = ["default", "autoEdit", "yolo"]
`;

/** Where the policy goes: CodeDen's data directory, else a folder in the OS temp directory. */
export function geminiAdminPolicyPath(codedenHome?: string): string {
  const dir = codedenHome
    ? path.join(codedenHome, "gemini")
    : path.join(tmpdir(), "codeden-gemini");
  return path.join(dir, "admin-policy.toml");
}

/**
 * Write the policy (unless the file already holds it) and return its path. The file is replaced
 * whole (written beside it, then renamed), so a session starting meanwhile never reads half of it.
 * Throws when it can't be written: a session never starts without it.
 */
export function writeGeminiAdminPolicy(codedenHome?: string): string {
  const file = geminiAdminPolicyPath(codedenHome);
  const current = (() => {
    try {
      return readFileSync(file, "utf8");
    } catch {
      return undefined;
    }
  })();
  if (current === GEMINI_ADMIN_POLICY) return file;
  mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(temp, GEMINI_ADMIN_POLICY, "utf8");
  renameSync(temp, file);
  return file;
}

/** The arguments that start Gemini CLI's ACP server under CodeDen's admin policy. */
export function geminiSessionArgs(base: readonly string[], policyFile: string): string[] {
  return [...base, "--admin-policy", policyFile];
}

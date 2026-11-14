import path from "node:path";
import { CHECK_RULES, field, listRules, readSettingsFile, stringList } from "../acp/allow-lists";

/** Gemini CLI's project settings, relative to the worktree. */
export const GEMINI_PROJECT_SETTINGS = ".gemini/settings.json";

/**
 * The settings of a Gemini CLI settings file that run tools without asking: `tools.allowed`,
 * `tools.autoAccept`, `mcp.allowed` and MCP servers marked `trust` (and their older top-level
 * names `allowedTools`, `autoAccept` and `allowMCPServers`). Pure.
 */
export function geminiAllowRules(settings: unknown): string[] {
  const tools = field(settings, "tools");
  const mcp = field(settings, "mcp");
  const rules: string[] = [];
  const list = (name: string, values: string[]) => {
    if (values.length) rules.push(`${name} (${values.join(", ")})`);
  };
  list("tools.allowed", stringList(field(tools, "allowed")));
  list("allowedTools", stringList(field(settings, "allowedTools")));
  if (field(tools, "autoAccept") === true) rules.push("tools.autoAccept");
  if (field(settings, "autoAccept") === true) rules.push("autoAccept");
  list("mcp.allowed", stringList(field(mcp, "allowed")));
  list("allowMCPServers", stringList(field(settings, "allowMCPServers")));
  const servers = field(settings, "mcpServers");
  if (servers && typeof servers === "object" && !Array.isArray(servers)) {
    for (const [name, server] of Object.entries(servers)) {
      if (field(server, "trust") === true) rules.push(`mcpServers.${name}.trust`);
    }
  }
  return rules;
}

/**
 * The warning for Gemini CLI settings in the worktree that run tools without asking, or
 * undefined when there are none. CodeDen starts Gemini CLI with an admin policy that still asks
 * before commands, edits and MCP tools (`./admin-policy`), so the warning is about the rest
 * (§11.2). A file that isn't JSON but mentions an allow setting is reported too.
 */
export function geminiAllowListNotice(cwd: string): string | undefined {
  const file = readSettingsFile(path.join(cwd, GEMINI_PROJECT_SETTINGS));
  if (!file.exists) return undefined;
  let rules: string;
  if (file.data === undefined) {
    if (!/allowed|autoAccept|allowMCPServers|"trust"/i.test(file.text)) return undefined;
    rules = "CodeDen couldn't read them";
  } else {
    const found = geminiAllowRules(file.data);
    if (!found.length) return undefined;
    rules = listRules(found);
  }
  return `This worktree has Gemini CLI settings that run tools without asking, \`${GEMINI_PROJECT_SETTINGS}\`: ${rules}. CodeDen starts Gemini CLI so that commands, edits and MCP tools still ask, but anything else these settings allow runs without CodeDen seeing it. ${CHECK_RULES}`;
}

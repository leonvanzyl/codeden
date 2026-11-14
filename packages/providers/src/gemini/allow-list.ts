import { readdirSync } from "node:fs";
import path from "node:path";
import {
  CHECK_RULES,
  field,
  listRules,
  readSettingsFile,
  readSmallFile,
  stringList,
  UNREADABLE,
} from "../acp/allow-lists";

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

/** Gemini CLI's project policy folder, relative to the worktree. */
export const GEMINI_PROJECT_POLICIES = ".gemini/policies";

/** A policy rule that runs a tool without asking. */
const ALLOW_DECISION = /^\s*decision\s*=\s*["']allow["']/im;

/**
 * The project's policy files with an `allow` rule, relative to the worktree, by name. Only small
 * regular files are read (`readSmallFile`); others are skipped.
 */
export function geminiAllowPolicies(cwd: string): string[] {
  const dir = path.join(cwd, GEMINI_PROJECT_POLICIES);
  let names: string[];
  try {
    names = readdirSync(dir)
      .filter((n) => n.toLowerCase().endsWith(".toml"))
      .sort();
  } catch {
    return [];
  }
  return names
    .filter((name) => {
      const text = readSmallFile(path.join(dir, name));
      return typeof text === "string" && ALLOW_DECISION.test(text);
    })
    .map((name) => `${GEMINI_PROJECT_POLICIES}/${name}`);
}

/** What the project's settings file allows, for the warning; undefined when nothing. */
function settingsRules(cwd: string): string | undefined {
  const file = readSettingsFile(path.join(cwd, GEMINI_PROJECT_SETTINGS));
  if (!file.exists) return undefined;
  if (file.text === null) return UNREADABLE;
  if (file.data === undefined) {
    return /allowed|autoAccept|allowMCPServers|"trust"/i.test(file.text)
      ? "CodeDen couldn't read them"
      : undefined;
  }
  const found = geminiAllowRules(file.data);
  return found.length ? listRules(found) : undefined;
}

/**
 * The warning for Gemini CLI settings in the worktree that run tools without asking (its
 * `.gemini/settings.json`, and `allow` rules in its `.gemini/policies`), or undefined when there
 * are none. CodeDen starts Gemini CLI with an admin policy that still asks before commands, and
 * before edits and MCP tools outside plan mode (`./admin-policy`), so the warning is about the
 * rest (§11.2). A settings file that isn't JSON but mentions an allow setting is reported too.
 */
export function geminiAllowListNotice(cwd: string): string | undefined {
  const parts: string[] = [];
  const settings = settingsRules(cwd);
  if (settings) parts.push(`\`${GEMINI_PROJECT_SETTINGS}\`: ${settings}`);
  const policies = geminiAllowPolicies(cwd);
  if (policies.length) {
    parts.push(`allow rules in ${listRules(policies.map((p) => `\`${p}\``))}`);
  }
  if (!parts.length) return undefined;
  return `This worktree has Gemini CLI settings that run tools without asking: ${parts.join("; ")}. CodeDen starts Gemini CLI so that commands still ask, and edits and MCP tools outside plan mode, but anything else these settings allow runs without CodeDen seeing it. ${CHECK_RULES}`;
}

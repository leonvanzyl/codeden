import { readdirSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { parse } from "@decimalturn/toml-patch";
import { field, readSettingsFile, readSmallFile, stringList } from "../acp/allow-lists";

/**
 * The user's own Gemini CLI rules, read so that CodeDen's admin policy can keep them in force
 * (`./admin-policy`, §11.2). Gemini CLI ranks every rule `tier + priority / 1000` and the highest
 * match decides: policy files in the user's `~/.gemini/policies` are tier 4, the project's
 * `.gemini/policies` tier 3, and the rules it makes from settings sit at fixed places in tier 4.
 * Files are read the way the allow-list warning reads them: small regular files only, never
 * throwing.
 */

/** Gemini CLI's approval modes, as policy rules name them. */
export const GEMINI_MODES = ["default", "autoEdit", "yolo", "plan"] as const;
export type GeminiMode = (typeof GEMINI_MODES)[number];

/** A rule of a Gemini CLI policy file: the fields its policy engine reads. */
export interface GeminiPolicyRule {
  toolName: string | string[];
  mcpName?: string;
  subagent?: string;
  argsPattern?: string;
  commandPrefix?: string | string[];
  commandRegex?: string;
  decision: "allow" | "deny" | "ask_user";
  /** 0 to 999 within the rule's tier. */
  priority: number;
  modes?: GeminiMode[];
  interactive?: boolean;
  toolAnnotations?: Record<string, unknown>;
  allowRedirection?: boolean;
  denyMessage?: string;
}

/** A rule and where Gemini CLI ranks it among all tiers: `tier + priority / 1000`. */
export interface RankedRule {
  rule: GeminiPolicyRule;
  rank: number;
}

/** Where a session's Gemini CLI finds the user's rules. */
export interface GeminiRuleSources {
  /** The session's worktree: its `.gemini/settings.json` and `.gemini/policies`. */
  cwd: string;
  /** Gemini CLI's user folder; default `.gemini` in `$GEMINI_CLI_HOME` or the home directory. */
  geminiHome?: string;
}

const WORKSPACE_TIER = 3;
const USER_TIER = 4;
/** Where Gemini CLI ranks the rules it makes from settings (computed as it computes them). */
const SETTINGS_RANK = {
  mcpExcluded: USER_TIER + 0.9,
  toolsExclude: USER_TIER + 0.4,
  toolsAllowed: USER_TIER + 0.3,
  mcpTrusted: USER_TIER + 0.2,
  mcpAllowed: USER_TIER + 0.1,
} as const;
/** The names `tools.allowed` accepts for Gemini CLI's shell tool. */
const SHELL_NAMES = ["run_shell_command", "ShellTool"];

const isString = (v: unknown): v is string => typeof v === "string";
const isStringOrList = (v: unknown): v is string | string[] =>
  isString(v) || (Array.isArray(v) && v.every(isString));
const isMode = (v: unknown): v is GeminiMode => GEMINI_MODES.some((m) => m === v);
const isRecord = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === "object" && !Array.isArray(v);
const optional = (v: unknown, check: (v: unknown) => boolean) => v === undefined || check(v);

/**
 * A rule as Gemini CLI's policy file schema accepts it, or undefined when it doesn't (Gemini CLI
 * then skips the whole file). The old snake_case names are read as the current ones.
 */
function policyRule(value: unknown): GeminiPolicyRule | undefined {
  if (!isRecord(value)) return undefined;
  const { toolName, decision, priority } = value;
  if (!isStringOrList(toolName)) return undefined;
  if (decision !== "allow" && decision !== "deny" && decision !== "ask_user") return undefined;
  if (!Number.isInteger(priority) || (priority as number) < 0 || (priority as number) > 999) {
    return undefined;
  }
  const strings = ["mcpName", "subagent", "argsPattern", "commandRegex", "denyMessage"];
  const booleans = ["interactive", "allowRedirection", "allow_redirection"];
  if (
    ![...strings, "deny_message"].every((key) => optional(value[key], isString)) ||
    !booleans.every((key) => optional(value[key], (v) => typeof v === "boolean")) ||
    !optional(value.commandPrefix, isStringOrList) ||
    !optional(value.modes, (v) => Array.isArray(v) && v.every(isMode)) ||
    !optional(value.toolAnnotations, isRecord)
  ) {
    return undefined;
  }
  const rule: GeminiPolicyRule = { toolName, decision, priority: priority as number };
  const extra: Record<string, unknown> = {
    mcpName: value.mcpName,
    subagent: value.subagent,
    argsPattern: value.argsPattern,
    commandPrefix: value.commandPrefix,
    commandRegex: value.commandRegex,
    modes: value.modes,
    interactive: value.interactive,
    toolAnnotations: value.toolAnnotations,
    allowRedirection: value.allowRedirection ?? value.allow_redirection,
    denyMessage: value.denyMessage ?? value.deny_message,
  };
  for (const [key, v] of Object.entries(extra)) {
    if (v !== undefined) Object.assign(rule, { [key]: v });
  }
  return rule;
}

/**
 * The rules of a policy file, or undefined when Gemini CLI would skip it (not TOML, or a rule its
 * schema rejects). A rule with an empty tool name is dropped on its own, as Gemini CLI drops it.
 */
export function parsePolicyFile(text: string): GeminiPolicyRule[] | undefined {
  let data: unknown;
  try {
    data = parse(text);
  } catch {
    return undefined;
  }
  const list = field(data, "rule");
  if (list === undefined) return [];
  if (!Array.isArray(list)) return undefined;
  const rules: GeminiPolicyRule[] = [];
  for (const value of list) {
    const rule = policyRule(value);
    if (!rule) return undefined;
    if (![rule.toolName].flat().includes("")) rules.push(rule);
  }
  return rules;
}

/** The rules of the `.toml` files in a policies folder, by file name, as Gemini CLI loads them. */
function folderRules(dir: string, tier: number): RankedRule[] {
  let names: string[];
  try {
    names = readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith(".toml"))
      .map((entry) => entry.name)
      .sort();
  } catch {
    return [];
  }
  return names.flatMap((name) => {
    const text = readSmallFile(path.join(dir, name));
    const rules = typeof text === "string" ? parsePolicyFile(text) : undefined;
    return (rules ?? []).map((rule) => ({ rule, rank: tier + rule.priority / 1000 }));
  });
}

/** A settings file's data, or undefined when it is missing or can't be read. */
function settingsOf(file: string): unknown {
  const settings = readSettingsFile(file);
  return settings.exists ? settings.data : undefined;
}

/** A list setting under its current name or its old top-level one; undefined when unset. */
function listSetting(settings: unknown, section: string, key: string, old: string) {
  const value = field(field(settings, section), key) ?? field(settings, old);
  return value === undefined ? undefined : stringList(value);
}

/** The MCP servers a settings file marks `trust`. */
function trustedServers(settings: unknown): Record<string, boolean> {
  const servers = field(settings, "mcpServers");
  if (!isRecord(servers)) return {};
  return Object.fromEntries(
    Object.entries(servers).map(([n, s]) => [n, field(s, "trust") === true]),
  );
}

/** A rule for every tool of an MCP server (`*`: of every server). */
const serverRule = (server: string, decision: "allow" | "deny"): GeminiPolicyRule => ({
  toolName: "*",
  mcpName: server,
  decision,
  priority: 0,
});

/** A rule for a `tools.allowed` entry: a tool, or `run_shell_command(<command prefix>)`. */
function allowedToolRule(entry: string): GeminiPolicyRule | undefined {
  const match = /^([a-zA-Z0-9_-]+)\((.*)\)$/.exec(entry);
  const name = match?.[1] ?? entry;
  if (!SHELL_NAMES.includes(name)) return { toolName: name, decision: "allow", priority: 0 };
  if (match && !match[2]) return undefined;
  return {
    toolName: "run_shell_command",
    ...(match ? { commandPrefix: match[2] } : {}),
    decision: "allow",
    priority: 0,
  };
}

/**
 * The rules Gemini CLI makes from the user's and the project's settings, merged as it merges
 * them: `tools.exclude` from both, the project's `tools.allowed`, `mcp.allowed` and `mcp.excluded`
 * in place of the user's, and each MCP server's entry from the project when it has one.
 */
export function settingsRules(user: unknown, project: unknown): RankedRule[] {
  const replaced = (section: string, key: string, old: string) =>
    listSetting(project, section, key, old) ?? listSetting(user, section, key, old) ?? [];
  const excluded = new Set([
    ...(listSetting(user, "tools", "exclude", "excludeTools") ?? []),
    ...(listSetting(project, "tools", "exclude", "excludeTools") ?? []),
  ]);
  const trusted = { ...trustedServers(user), ...trustedServers(project) };
  const ranked = (rank: number) => (rule: GeminiPolicyRule | undefined) =>
    rule ? [{ rule, rank }] : [];
  return [
    ...replaced("mcp", "excluded", "excludeMCPServers").flatMap((server) =>
      ranked(SETTINGS_RANK.mcpExcluded)(serverRule(server, "deny")),
    ),
    ...[...excluded].flatMap((tool) =>
      ranked(SETTINGS_RANK.toolsExclude)({ toolName: tool, decision: "deny", priority: 0 }),
    ),
    ...replaced("tools", "allowed", "allowedTools").flatMap((entry) =>
      ranked(SETTINGS_RANK.toolsAllowed)(allowedToolRule(entry)),
    ),
    ...Object.entries(trusted).flatMap(([server, trust]) =>
      trust ? ranked(SETTINGS_RANK.mcpTrusted)(serverRule(server, "allow")) : [],
    ),
    ...replaced("mcp", "allowed", "allowMCPServers").flatMap((server) =>
      ranked(SETTINGS_RANK.mcpAllowed)(serverRule(server, "allow")),
    ),
  ];
}

/** Gemini CLI's user folder: `.gemini` in `$GEMINI_CLI_HOME`, else in the home directory. */
export function defaultGeminiHome(): string {
  return path.join(process.env.GEMINI_CLI_HOME || homedir(), ".gemini");
}

/**
 * Every rule of the user's and the project's that Gemini CLI would load, in the order it loads
 * them: the user's policy files, the project's, then the rules from settings. The project's
 * policy files are read even though current Gemini CLI releases leave that tier switched off:
 * CodeDen keeps what they deny (they rank below the user's own rules, so they can only deny or ask).
 */
export function geminiUserRules(sources: GeminiRuleSources): RankedRule[] {
  const home = path.resolve(sources.geminiHome ?? defaultGeminiHome());
  const project = path.resolve(sources.cwd, ".gemini");
  // A session in the home directory: Gemini CLI reads its folder as the user's only.
  const isHome = project === home;
  return [
    ...folderRules(path.join(home, "policies"), USER_TIER),
    ...(isHome ? [] : folderRules(path.join(project, "policies"), WORKSPACE_TIER)),
    ...settingsRules(
      settingsOf(path.join(home, "settings.json")),
      isHome ? undefined : settingsOf(path.join(project, "settings.json")),
    ),
  ];
}

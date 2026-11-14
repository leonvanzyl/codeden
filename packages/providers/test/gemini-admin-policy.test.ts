import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse } from "@decimalturn/toml-patch";
import { describe, expect, it } from "vitest";
import { writeGeminiAdminPolicy } from "../src/gemini/admin-policy";

/**
 * Issue #241: CodeDen's admin policy stops Gemini CLI's allow rules from skipping its approvals,
 * but must leave the user's own deny rules in force.
 */

const folder = (files: Record<string, string>, prefix: string) => {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  for (const [file, text] of Object.entries(files)) {
    mkdirSync(join(dir, file, ".."), { recursive: true });
    writeFileSync(join(dir, file), text);
  }
  return dir;
};

interface Rule {
  toolName: string | string[];
  mcpName?: string;
  commandPrefix?: string | string[];
  commandRegex?: string;
  argsPattern?: string;
  modes?: string[];
  decision: string;
  priority: number;
}

interface Call {
  /** The tool's name; MCP tools by their full name, `mcp_<server>_<tool>`. */
  name: string;
  args: Record<string, unknown>;
  server?: string;
}

/** Arguments as Gemini CLI tests them against `argsPattern`: JSON with sorted keys. */
const stableJson = (args: Record<string, unknown>) =>
  JSON.stringify(Object.fromEntries(Object.entries(args).sort(([a], [b]) => a.localeCompare(b))));

function toolMatches(name: string, rule: Rule, call: Call): boolean {
  if (name === "*") return true;
  const fullName = rule.mcpName && rule.mcpName !== "*" ? `mcp_${rule.mcpName}_${name}` : name;
  if (fullName.endsWith("*")) return call.name.startsWith(fullName.slice(0, -1));
  return call.name === fullName || (rule.mcpName === "*" && call.name === `mcp_${call.server}_${name}`);
}

/** Whether a rule matches a call, as Gemini CLI's policy engine decides it (enough for these rules). */
function matches(rule: Rule, call: Call, mode: string): boolean {
  if (rule.modes?.length && !rule.modes.includes(mode)) return false;
  if (rule.mcpName !== undefined) {
    if (call.server === undefined) return false;
    if (rule.mcpName !== "*" && rule.mcpName !== call.server) return false;
  }
  if (![rule.toolName].flat().some((name) => toolMatches(name, rule, call))) return false;
  const command = typeof call.args.command === "string" ? call.args.command : undefined;
  if (rule.commandPrefix !== undefined) {
    const prefixes = [rule.commandPrefix].flat();
    if (!prefixes.some((p) => command === p || command?.startsWith(`${p} `))) return false;
  }
  if (rule.commandRegex !== undefined) {
    if (!new RegExp(`"command":"${rule.commandRegex}`).test(stableJson(call.args))) return false;
  }
  if (rule.argsPattern !== undefined && !new RegExp(rule.argsPattern).test(stableJson(call.args))) {
    return false;
  }
  return true;
}

/**
 * The decision of CodeDen's admin policy for a call. Admin rules outrank every rule of the user's
 * own (tier 5 against 4 and below), so the highest-priority admin rule that matches decides; only
 * when none does do the user's rules apply.
 */
function adminDecision(policy: string, call: Call, mode = "default"): string | undefined {
  const rules = ((parse(policy) as { rule?: Rule[] }).rule ?? [])
    .map((rule, index) => ({ rule, index }))
    .sort((a, b) => b.rule.priority - a.rule.priority || a.index - b.index);
  return rules.find(({ rule }) => matches(rule, call, mode))?.rule.decision;
}

const shell = (command: string): Call => ({ name: "run_shell_command", args: { command } });
const write = (file_path: string): Call => ({ name: "write_file", args: { content: "x", file_path } });
const mcp = (server: string, tool: string): Call => ({
  name: `mcp_${server}_${tool}`,
  args: {},
  server,
});

describe("Gemini CLI's admin policy and the user's own deny rules", () => {
  it("keeps the user's and the project's deny rules; everything else still asks", () => {
    const geminiHome = folder(
      {
        "policies/deny.toml": [
          "[[rule]]",
          'toolName = "run_shell_command"',
          'commandPrefix = "git push --force"',
          'decision = "deny"',
          "priority = 500",
          "",
          "[[rule]]",
          'toolName = "write_file"',
          "argsPattern = '\\.env'",
          'decision = "deny"',
          "priority = 500",
          "",
        ].join("\n"),
        "settings.json": JSON.stringify({ tools: { exclude: ["replace"] } }),
      },
      "codeden-gemini-home-",
    );
    const cwd = folder(
      { ".gemini/settings.json": JSON.stringify({ mcp: { excluded: ["untrusted"] } }) },
      "codeden-worktree-",
    );
    const home = mkdtempSync(join(tmpdir(), "codeden-home-"));
    const policy = readFileSync(writeGeminiAdminPolicy(home, { cwd, geminiHome }), "utf8");

    const decide = (call: Call) => adminDecision(policy, call);
    expect({
      "git push --force origin main": decide(shell("git push --force origin main")),
      "write_file .env": decide(write(".env")),
      "replace (tools.exclude)": decide({ name: "replace", args: { file_path: "a.ts" } }),
      "untrusted MCP server (mcp.excluded)": decide(mcp("untrusted", "delete")),
      "git status": decide(shell("git status")),
      "write_file src/a.ts": decide(write("src/a.ts")),
      "another MCP server": decide(mcp("docs", "search")),
    }).toEqual({
      "git push --force origin main": "deny",
      "write_file .env": "deny",
      "replace (tools.exclude)": "deny",
      "untrusted MCP server (mcp.excluded)": "deny",
      "git status": "ask_user",
      "write_file src/a.ts": "ask_user",
      "another MCP server": "ask_user",
    });
  });
});

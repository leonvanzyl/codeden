import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse } from "@decimalturn/toml-patch";
import { describe, expect, it } from "vitest";
import { geminiUserRulesPolicy, writeGeminiAdminPolicies } from "../src/gemini/admin-policy";
import { parsePolicyFile, settingsRules } from "../src/gemini/policy-rules";

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
  return (
    call.name === fullName || (rule.mcpName === "*" && call.name === `mcp_${call.server}_${name}`)
  );
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
const write = (file_path: string): Call => ({
  name: "write_file",
  args: { content: "x", file_path },
});
const mcp = (server: string, tool: string): Call => ({
  name: `mcp_${server}_${tool}`,
  args: {},
  server,
});

/** A policy file's text from `[[rule]]` lines. */
const toml = (...rules: string[][]) =>
  rules.map((lines) => ["[[rule]]", ...lines].join("\n")).join("\n\n");

/**
 * The admin policy files CodeDen writes for a session whose Gemini CLI user folder and worktree
 * hold these files, read as one (Gemini CLI loads every `--admin-policy` file into the admin tier).
 */
function adminPolicy(user: Record<string, string>, project: Record<string, string> = {}) {
  const geminiHome = folder(user, "codeden-gemini-home-");
  const cwd = folder(project, "codeden-worktree-");
  const home = mkdtempSync(join(tmpdir(), "codeden-home-"));
  const files = writeGeminiAdminPolicies(home, { cwd, geminiHome });
  const text = files.map((file) => readFileSync(file, "utf8")).join("\n");
  return { files, text, decide: (call: Call, mode?: string) => adminDecision(text, call, mode) };
}

describe("Gemini CLI's admin policy and the user's own deny rules", () => {
  it("keeps the user's and the project's deny rules; everything else still asks", () => {
    const { decide } = adminPolicy(
      {
        "policies/deny.toml": toml(
          [
            'toolName = "run_shell_command"',
            'commandPrefix = "git push --force"',
            'decision = "deny"',
            "priority = 500",
          ],
          [
            'toolName = "write_file"',
            "argsPattern = '\\.env'",
            'decision = "deny"',
            "priority = 500",
          ],
        ),
        "settings.json": JSON.stringify({ tools: { exclude: ["replace"] } }),
      },
      { ".gemini/settings.json": JSON.stringify({ mcp: { excluded: ["untrusted"] } }) },
    );
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

  it("keeps the user's exceptions to a deny rule, as asks", () => {
    const { decide } = adminPolicy({
      "policies/shell.toml": toml(
        ['toolName = "run_shell_command"', 'decision = "deny"', "priority = 100"],
        [
          'toolName = "run_shell_command"',
          'commandPrefix = "git status"',
          'decision = "allow"',
          "priority = 200",
        ],
      ),
      // 4.3 in Gemini CLI's ranking, above the deny's 4.1.
      "settings.json": JSON.stringify({ tools: { allowed: ["run_shell_command(npm test)"] } }),
    });
    expect(decide(shell("git status"))).toBe("ask_user");
    expect(decide(shell("npm test"))).toBe("ask_user");
    expect(decide(shell("rm notes.txt"))).toBe("deny");
  });

  it("ranks the project's policy files below the user's rules, as Gemini CLI does", () => {
    const { decide } = adminPolicy(
      {
        "policies/push.toml": toml([
          'toolName = "run_shell_command"',
          'commandPrefix = "git push"',
          'decision = "deny"',
          "priority = 1",
        ]),
      },
      {
        ".gemini/policies/project.toml": toml(
          [
            'toolName = "run_shell_command"',
            'commandPrefix = "git push"',
            'decision = "allow"',
            "priority = 999",
          ],
          [
            'toolName = "run_shell_command"',
            'commandPrefix = "rm -rf"',
            'decision = "deny"',
            "priority = 5",
          ],
        ),
      },
    );
    expect(decide(shell("git push origin main"))).toBe("deny");
    expect(decide(shell("rm -rf build"))).toBe("deny");
  });

  it("leaves edits and MCP tools in plan mode, and other tools, to Gemini CLI's own rules", () => {
    const { decide } = adminPolicy({
      "policies/all.toml": toml(['toolName = "*"', 'decision = "deny"', "priority = 10"]),
    });
    expect(decide(write("a.ts"))).toBe("deny");
    expect(decide(mcp("docs", "search"))).toBe("deny");
    expect(decide(shell("ls"), "plan")).toBe("deny");
    // No admin rule: the user's own deny decides, as without CodeDen.
    expect(decide(write("a.ts"), "plan")).toBeUndefined();
    expect(decide(mcp("docs", "search"), "plan")).toBeUndefined();
    expect(decide({ name: "web_fetch", args: { prompt: "x" } })).toBeUndefined();
  });

  it("writes only CodeDen's own file when the user's rules deny nothing it asks about", () => {
    const { files } = adminPolicy(
      {
        "policies/fetch.toml": toml([
          'toolName = "web_fetch"',
          'decision = "deny"',
          "priority = 10",
        ]),
        "settings.json": JSON.stringify({
          tools: { allowed: ["run_shell_command"] },
          mcpServers: { docs: { trust: true } },
        }),
      },
      { ".gemini/settings.json": JSON.stringify({ tools: { exclude: ["web_search"] } }) },
    );
    expect(files).toHaveLength(1);
    expect(files[0]).toMatch(/admin-policy\.toml$/);
  });

  it("reads policy files as Gemini CLI does: a file it rejects is skipped whole", () => {
    const rule = ['toolName = "run_shell_command"', 'decision = "deny"'];
    expect(parsePolicyFile(toml([...rule, "priority = 1.5"]))).toBeUndefined();
    expect(parsePolicyFile(toml([...rule, "priority = 1000"]))).toBeUndefined();
    expect(parsePolicyFile(toml([...rule, "priority = 1", 'modes = ["fast"]']))).toBeUndefined();
    expect(parsePolicyFile("[rule]\ntoolName = 'x'")).toBeUndefined();
    expect(parsePolicyFile("not = [toml")).toBeUndefined();
    expect(
      parsePolicyFile(
        toml(
          [...rule, "priority = 1", 'deny_message = "no"', "allow_redirection = true"],
          ['toolName = ""', 'decision = "deny"', "priority = 1"],
        ),
      ),
    ).toEqual([
      {
        toolName: "run_shell_command",
        decision: "deny",
        priority: 1,
        allowRedirection: true,
        denyMessage: "no",
      },
    ]);
  });

  it("merges the user's and the project's settings as Gemini CLI does", () => {
    const rules = settingsRules(
      { tools: { exclude: ["replace"] }, excludeMCPServers: ["old"], mcp: { allowed: ["a"] } },
      { excludeTools: ["write_file"], mcp: { excluded: ["new"] } },
    );
    expect(
      rules.map(({ rule, rank }) => [rule.mcpName ?? rule.toolName, rule.decision, rank]),
    ).toEqual([
      // The project's `mcp.excluded` replaces the user's; `tools.exclude` adds up.
      ["new", "deny", 4.9],
      ["replace", "deny", 4.4],
      ["write_file", "deny", 4.4],
      ["a", "allow", 4.1],
    ]);
  });

  it("gives each rank its own priority, never Gemini CLI's saved-rule one (950)", () => {
    const ranked = Array.from({ length: 60 }, (_, i) => ({
      rule: {
        toolName: "run_shell_command",
        commandPrefix: `tool${i}`,
        decision: "deny" as const,
        priority: i,
      },
      rank: 4 + i / 1000,
    }));
    const policy = geminiUserRulesPolicy(ranked) ?? "";
    const priorities = ((parse(policy) as { rule: Rule[] }).rule ?? []).map((r) => r.priority);
    expect(priorities).toHaveLength(60);
    expect(priorities[0]).toBe(999);
    expect(priorities).not.toContain(950);
    expect(priorities.every((p, i) => i === 0 || p < (priorities[i - 1] as number))).toBe(true);
  });
});

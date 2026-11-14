import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AGENT_ALLOW_LIST_NOTICE, type ItemOf } from "@codeden/contracts";
import { describe, expect, it } from "vitest";
import { cursorAllowListNotice } from "../src/cursor/allow-list";
import {
  GEMINI_ADMIN_POLICY,
  geminiAdminPolicyPath,
  geminiSessionArgs,
  writeGeminiAdminPolicy,
} from "../src/gemini/admin-policy";
import { geminiAllowListNotice, geminiAllowRules } from "../src/gemini/allow-list";
import { chunk, completedOf, fakeAcp } from "./support/fake-acp";

/** Issue #232: allow-lists already in a worktree are named when a session starts. */

const worktree = (files: Record<string, string>) => {
  const dir = mkdtempSync(join(tmpdir(), "codeden-allow-list-"));
  for (const [file, text] of Object.entries(files)) {
    mkdirSync(join(dir, file, ".."), { recursive: true });
    writeFileSync(join(dir, file), text);
  }
  return dir;
};

describe("Cursor's allow-list", () => {
  it("names the rules of .cursor/cli.json", () => {
    const dir = worktree({
      ".cursor/cli.json": JSON.stringify({ permissions: { allow: ["Shell(*)", "Write(**)"] } }),
    });
    expect(cursorAllowListNotice(dir)).toMatch(
      /^This worktree has Cursor's own allow-list, `\.cursor\/cli\.json` \(Shell\(\*\), Write\(\*\*\)\)\. Cursor runs what it allows without asking/,
    );
  });

  it("says nothing without rules, and reports a file it can't read that mentions allow", () => {
    expect(cursorAllowListNotice(worktree({}))).toBeUndefined();
    const denyOnly = {
      ".cursor/cli.json": '{ "permissions": { "allow": [], "deny": ["Shell(rm)"] } }',
    };
    expect(cursorAllowListNotice(worktree(denyOnly))).toBeUndefined();
    const broken = worktree({ ".cursor/cli.json": '{ "permissions": { "allow": ["Shell(*)"' });
    expect(cursorAllowListNotice(broken)).toContain("CodeDen couldn't read its rules");
  });
});

describe("Gemini CLI's allow settings", () => {
  it("finds tools.allowed, autoAccept, allowed and trusted MCP servers, old names included", () => {
    expect(
      geminiAllowRules({
        tools: { allowed: ["run_shell_command"], autoAccept: true },
        mcp: { allowed: ["linear"] },
        mcpServers: { github: { trust: true }, docs: { trust: false } },
        allowedTools: ["write_file"],
      }),
    ).toEqual([
      "tools.allowed (run_shell_command)",
      "allowedTools (write_file)",
      "tools.autoAccept",
      "mcp.allowed (linear)",
      "mcpServers.github.trust",
    ]);
    expect(geminiAllowRules({ general: { vimMode: true } })).toEqual([]);
  });

  it("names them from .gemini/settings.json, comments allowed", () => {
    const dir = worktree({
      ".gemini/settings.json":
        '{\n  // project settings\n  "tools": { "allowed": ["run_shell_command"], },\n}',
    });
    expect(geminiAllowListNotice(dir)).toContain(
      "`.gemini/settings.json`: tools.allowed (run_shell_command). CodeDen starts Gemini CLI so that commands, edits and MCP tools still ask",
    );
    expect(geminiAllowListNotice(worktree({ ".gemini/settings.json": "{}" }))).toBeUndefined();
  });
});

describe("Gemini CLI's admin policy", () => {
  it("is written to CodeDen's home once and passed with --admin-policy", () => {
    const home = mkdtempSync(join(tmpdir(), "codeden-home-"));
    const file = writeGeminiAdminPolicy(home);
    expect(file).toBe(geminiAdminPolicyPath(home));
    expect(file).toBe(join(home, "gemini", "admin-policy.toml"));
    expect(readFileSync(file, "utf8")).toBe(GEMINI_ADMIN_POLICY);
    writeFileSync(file, "tampered");
    expect(readFileSync(writeGeminiAdminPolicy(home), "utf8")).toBe(GEMINI_ADMIN_POLICY);
    expect(geminiSessionArgs(["--acp"], file)).toEqual(["--acp", "--admin-policy", file]);
  });

  it("asks before commands everywhere, and before edits and MCP tools outside plan mode", () => {
    const rules = GEMINI_ADMIN_POLICY.split("[[rule]]").slice(1);
    expect(rules).toHaveLength(3);
    for (const rule of rules) {
      expect(rule).toContain('decision = "ask_user"');
      expect(rule).toContain("priority = 999");
    }
    expect(rules[0]).toContain('toolName = "run_shell_command"');
    expect(rules[0]).not.toContain("modes");
    expect(rules[1]).toContain('toolName = ["write_file", "replace"]');
    expect(rules[2]).toContain('mcpName = "*"');
    for (const rule of rules.slice(1)) {
      expect(rule).toContain('modes = ["default", "autoEdit", "yolo"]');
    }
  });
});

describe("a session in a worktree with an allow-list", () => {
  const acp = fakeAcp();

  it("warns in its first turn, with the code the factory looks for", async () => {
    mkdirSync(join(acp.dir, ".cursor"));
    writeFileSync(
      join(acp.dir, ".cursor", "cli.json"),
      JSON.stringify({ permissions: { allow: ["Shell(*)"] } }),
    );
    const { reader } = await acp.open([chunk("Hi"), { stopReason: "end_turn" }]);
    const notices = completedOf(await reader.turn("Go"), "notice") as ItemOf<"notice">[];
    expect(notices).toEqual([
      expect.objectContaining({
        level: "warning",
        code: AGENT_ALLOW_LIST_NOTICE,
        message: expect.stringContaining("`.cursor/cli.json` (Shell(*))"),
      }),
    ]);
  });
});

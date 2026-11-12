import { describe, expect, it } from "vitest";
import {
  AgentConfigFile,
  AgentConfigLocator,
  HookChangeRequest,
  HookListResponse,
  HookWriteResponse,
  LoadedAgentConfig,
  McpServerSpec,
  McpServerUpsertRequest,
  providersWith,
} from "../src";

const roundTrip = <T>(schema: { parse: (v: unknown) => T }, value: T) =>
  expect(schema.parse(JSON.parse(JSON.stringify(value)))).toEqual(value);

const file = {
  root: "project",
  projectId: "p1",
  path: "packages/api/CLAUDE.md",
  provider: "claude",
  kind: "memory",
  scope: "project",
  name: "CLAUDE.md",
  absolutePath: "C:/repo/packages/api/CLAUDE.md",
  exists: true,
  sizeBytes: 10,
  modifiedAt: "2026-11-07T10:00:00.000Z",
  onDemand: true,
} as const;

describe("agent configuration contracts", () => {
  it("round-trips files, MCP specs and the loaded view", () => {
    roundTrip(AgentConfigFile, file);
    roundTrip(McpServerSpec, { type: "stdio", command: "npx", args: ["-y", "x"], env: { A: "1" } });
    roundTrip(McpServerSpec, {
      type: "http",
      url: "https://example.com/mcp",
      bearerTokenEnvVar: "TOKEN",
      enabled: false,
      extra: { startup_timeout_sec: 20 },
    });
    roundTrip(LoadedAgentConfig, {
      sessionId: "s1",
      provider: "claude",
      cwd: "C:/repo",
      memory: [file],
      skills: [
        { provider: "claude", scope: "user", name: "deploy", file: { ...file, kind: "skill" } },
      ],
      subagents: [],
      mcpServers: [
        {
          provider: "codeden",
          scope: "user",
          name: "codeden",
          spec: { type: "http", url: "http://127.0.0.1:1/mcp" },
          file: "CodeDen",
          projectId: null,
        },
      ],
    });
  });

  it("round-trips hooks and keeps unknown handler fields", () => {
    const handler = {
      type: "command",
      command: "npx prettier --write",
      timeout: 30,
      if: "Edit(*.ts)",
      statusMessage: "Formatting",
    };
    roundTrip(HookListResponse, {
      sources: [
        {
          provider: "claude",
          scope: "project",
          projectId: "p1",
          file: "C:/repo/.claude/settings.json",
          exists: true,
          disableAllHooks: false,
        },
        {
          provider: "claude",
          scope: "user",
          projectId: null,
          file: "C:/Users/me/.claude/settings.json",
          exists: true,
          disableAllHooks: false,
          error: "Unexpected token",
        },
      ],
      hooks: [
        {
          provider: "claude",
          scope: "project",
          projectId: "p1",
          file: "C:/repo/.claude/settings.json",
          event: "PostToolUse",
          matcher: "Edit|Write",
          handler,
          enabled: true,
          groupIndex: 0,
          handlerIndex: 1,
        },
        {
          provider: "claude",
          scope: "user",
          projectId: null,
          file: "C:/Users/me/.claude/settings.json",
          event: "Stop",
          matcher: null,
          handler: { type: "mcp_tool", server: "x", tool: "y" },
          enabled: false,
          shelfId: "h1",
        },
      ],
    });
    const target = {
      provider: "claude",
      scope: "project",
      projectId: "p1",
      event: "PostToolUse",
      groupIndex: 0,
      handlerIndex: 1,
      expected: handler,
    } as const;
    roundTrip(HookChangeRequest, {
      action: "update",
      target,
      event: "PreToolUse",
      matcher: "Bash",
      handler,
    });
    roundTrip(HookChangeRequest, { action: "remove", target });
    roundTrip(HookChangeRequest, { action: "remove", target: { shelfId: "h1" } });
    roundTrip(HookChangeRequest, { action: "enable", target: { shelfId: "h1" } });
    roundTrip(HookWriteResponse, { file: null, backupPath: null });
    expect(providersWith("hooks")).toEqual(["claude"]);
  });

  it("validates hooks to write", () => {
    const add = { action: "add", provider: "claude", scope: "user", event: "Stop" };
    const ok = (handler: unknown, event = "Stop") =>
      HookChangeRequest.safeParse({ ...add, event, handler }).success;
    expect(ok({ type: "command", command: "echo done" })).toBe(true);
    expect(ok({ type: "mcp_tool", server: "x", tool: "y" })).toBe(true);
    expect(ok({ type: "command", command: "  " })).toBe(false);
    expect(ok({ type: "http" })).toBe(false);
    expect(ok({ type: "agent", prompt: "Check it", timeout: 0 })).toBe(false);
    expect(ok({ type: "command", command: "x" }, "Pre Tool")).toBe(false);
  });

  it("validates locators and server names", () => {
    expect(AgentConfigLocator.safeParse({ root: "elsewhere", path: "x" }).success).toBe(false);
    const bad = {
      provider: "codex",
      scope: "user",
      name: "has space",
      spec: { type: "stdio", command: "x" },
    };
    expect(McpServerUpsertRequest.safeParse(bad).success).toBe(false);
  });
});

import { describe, expect, it } from "vitest";
import {
  AgentConfigFile,
  AgentConfigLocator,
  HookChangeRequest,
  HookListResponse,
  HookWriteResponse,
  LoadedAgentConfig,
  McpServerSpec,
  McpServerTestRequest,
  McpServerTestResult,
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
    const loaded: LoadedAgentConfig = {
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
      hooks: {
        sources: [
          {
            provider: "claude",
            scope: "local",
            projectId: "p1",
            file: "C:/repo/.claude/settings.local.json",
            exists: true,
            disableAllHooks: true,
          },
        ],
        hooks: [
          {
            provider: "claude",
            scope: "local",
            projectId: "p1",
            file: "C:/repo/.claude/settings.local.json",
            event: "PreToolUse",
            matcher: "Bash",
            handler: { type: "command", command: "./guard.sh", timeout: 5 },
            enabled: true,
            groupIndex: 0,
            handlerIndex: 0,
          },
        ],
        disabledBy: "C:/repo/.claude/settings.local.json",
      },
    };
    roundTrip(LoadedAgentConfig, loaded);
    // Providers without native hooks report null, which is kept (not dropped).
    roundTrip(LoadedAgentConfig, { ...loaded, provider: "codex", hooks: null });
    const { hooks: _, ...withoutHooks } = loaded;
    expect(LoadedAgentConfig.safeParse(withoutHooks).success).toBe(false);
  });

  it("round-trips hooks and keeps unknown handler fields", () => {
    const handler = {
      type: "command",
      command: "npx prettier --write",
      timeout: 30,
      if: "Edit(*.ts)",
      statusMessage: "Formatting",
    };
    const list: HookListResponse = {
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
    };
    roundTrip(HookListResponse, list);
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
      matcher: " Bash ",
      handler,
      listProjectId: "p1",
    });
    roundTrip(HookChangeRequest, { action: "remove", target });
    roundTrip(HookChangeRequest, { action: "remove", target: { shelfId: "h1" } });
    roundTrip(HookChangeRequest, { action: "enable", target: { shelfId: "h1" } });
    roundTrip(HookWriteResponse, { file: null, backupPath: null, hooks: list });
    // The refreshed list is part of the contract, not stripped.
    expect(HookWriteResponse.safeParse({ file: null, backupPath: null }).success).toBe(false);
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
    expect(ok({ type: "command", command: "x" }, "Stop2")).toBe(false);
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

  it("round-trips MCP connection test requests and results", () => {
    roundTrip(McpServerTestRequest, { provider: "claude", scope: "user", name: "fs" });
    roundTrip(McpServerTestRequest, {
      provider: "claude",
      scope: "project",
      projectId: "p1",
      name: "fs",
      spec: { type: "stdio", command: "npx", args: ["-y", "x"] },
    });
    roundTrip(McpServerTestResult, {
      ok: true,
      durationMs: 840,
      server: { name: "fs", version: "1.2.0", title: "Files" },
      protocolVersion: "2025-06-18",
      toolCount: 2,
      morePages: false,
      tools: [{ name: "read_file", description: "Reads a file" }, { name: "write_file" }],
    });
    // A paged list cut off at the page cap says so: its count is a lower bound.
    const partial = {
      ok: true,
      durationMs: 9,
      server: { name: "big", version: "1" },
      protocolVersion: null,
      toolCount: 5000,
      tools: [],
    };
    expect(McpServerTestResult.safeParse(partial).success).toBe(false);
    roundTrip(McpServerTestResult, { ...partial, ok: true as const, morePages: true });
    roundTrip(McpServerTestResult, {
      ok: false,
      durationMs: 12,
      stage: "start",
      error: "spawn nope ENOENT",
      timedOut: false,
      stderrTail: "command not found",
    });
    roundTrip(McpServerTestResult, {
      ok: false,
      durationMs: 30,
      stage: "connect",
      error: "MCP error -32000: Connection closed",
      timedOut: false,
      stderrTail: "GITHUB_TOKEN is not set",
      note: "Codex starts a stdio server with only a few variables from your environment",
    });
    const failed = { ok: false, durationMs: 1, stage: "connect", timedOut: true };
    expect(McpServerTestResult.safeParse({ ...failed, error: "x".repeat(2001) }).success).toBe(
      false,
    );
    expect(McpServerTestResult.safeParse({ ...failed, stage: "other", error: "x" }).success).toBe(
      false,
    );
  });
});

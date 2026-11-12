import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RunnerCommand, RunnerCommandResult } from "@codeden/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AgentConfigService } from "../src/services/agent-config/agent-config-service";
import { ServiceError } from "../src/services/errors";
import type { ProjectService } from "../src/services/projects/project-service";
import type { SessionRepo } from "../src/services/sessions/repo";

const passed: RunnerCommandResult<"mcp.test"> = {
  ok: true,
  durationMs: 5,
  server: { name: "s", version: "1" },
  protocolVersion: "2025-06-18",
  toolCount: 0,
  morePages: false,
  tools: [],
};

describe("MCP connection test requests", () => {
  let dir: string;
  let home: string;
  let repo: string;
  let sent: RunnerCommand[];
  let service: AgentConfigService;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "codeden-mcp-test-"));
    home = join(dir, "home");
    repo = join(dir, "repo");
    mkdirSync(home, { recursive: true });
    mkdirSync(repo, { recursive: true });
    writeFileSync(
      join(repo, ".mcp.json"),
      JSON.stringify({ mcpServers: { files: { command: "npx", args: ["-y", "fs-mcp"] } } }),
    );
    writeFileSync(
      join(home, ".claude.json"),
      JSON.stringify({ mcpServers: { web: { type: "http", url: "https://x/mcp" } } }),
    );
    sent = [];
    service = new AgentConfigService({
      home,
      projects: { get: (id: string) => ({ id, path: repo }) } as unknown as ProjectService,
      repo: {} as SessionRepo,
      backupDir: join(dir, "backups"),
      disabledHooksFile: join(dir, "disabled-hooks.json"),
      mcpProxyUrl: () => null,
      runner: {
        request: async (command) => {
          sent.push(command as RunnerCommand);
          return passed as never;
        },
      },
    });
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("tests the saved server in the project folder, or in the runner's home for user scope", async () => {
    expect(
      await service.mcpTest({
        provider: "claude",
        scope: "project",
        projectId: "p1",
        name: "files",
      }),
    ).toEqual(passed);
    await service.mcpTest({ provider: "claude", scope: "user", name: "web" });
    expect(sent).toEqual([
      {
        name: "mcp.test",
        spec: { type: "stdio", command: "npx", args: ["-y", "fs-mcp"] },
        cwd: repo,
        expandEnv: true,
      },
      { name: "mcp.test", spec: { type: "http", url: "https://x/mcp" }, expandEnv: true },
    ]);
  });

  it("tests unsaved values as given, expanding variables only for Claude", async () => {
    const spec = { type: "stdio" as const, command: "node", args: ["${HOME}/srv.js"] };
    await service.mcpTest({ provider: "codex", scope: "user", name: "unsaved", spec });
    expect(sent).toEqual([{ name: "mcp.test", spec, expandEnv: false }]);
  });

  it("is a 404 for a server that is not saved there", async () => {
    const missing = service.mcpTest({ provider: "claude", scope: "user", name: "nope" });
    await expect(missing).rejects.toBeInstanceOf(ServiceError);
    await expect(missing).rejects.toMatchObject({ status: 404, code: "server_not_found" });
    expect(sent).toEqual([]);
  });
});

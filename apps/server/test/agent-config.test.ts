import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  AgentConfigDiff,
  AgentConfigFileContent,
  AgentConfigListResponse,
  AgentConfigWriteResponse,
  HookListResponse,
  HookWriteResponse,
  LoadedAgentConfig,
  McpServerListResponse,
  McpServerWriteResponse,
} from "@codeden/contracts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadedClaude, loadedCodex } from "../src/services/agent-config/catalog";
import { claudeProjectSlug } from "../src/services/agent-config/paths";
import { editTomlServer } from "../src/services/agent-config/toml-edit";
import { type Harness, startHarness } from "./support/harness";

function put(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

const CODEX_TOML = `# my settings
model = "gpt-6"   # keep this comment

[profiles.fast]
model_reasoning_effort = "low"

# Docs server
[mcp_servers.docs]
url = "https://example.com/mcp"

[mcp_servers.local_tool]
command = "node"
args = ["tool.js"]

[mcp_servers.local_tool.env]
TOKEN_FILE = "C:\\\\secrets\\\\t.txt"

# Notes stay here
[notice]
hide = true
`;

describe("claude project slug", () => {
  it("replaces every non-alphanumeric character with a dash", () => {
    expect(claudeProjectSlug("C:\\Projects\\codeden")).toBe("C--Projects-codeden");
    expect(claudeProjectSlug("C:\\Users\\leon\\.cubefarm\\ceo")).toBe(
      "C--Users-leon--cubefarm-ceo",
    );
    expect(claudeProjectSlug("/home/me/my_app.v2")).toBe("-home-me-my-app-v2");
  });
});

describe("codex config.toml edits", () => {
  it("adds, replaces and removes one server and leaves every other line alone", () => {
    const added = editTomlServer(CODEX_TOML, "new_one", { command: "npx", args: ["-y", "pkg"] });
    expect(added.startsWith(CODEX_TOML.trimEnd())).toBe(true);
    expect(added).toContain('[mcp_servers.new_one]\ncommand = "npx"');

    const replaced = editTomlServer(CODEX_TOML, "local_tool", {
      command: "node",
      args: ["tool2.js"],
      env: { A: "1" },
    });
    expect(replaced).toContain("# Notes stay here\n[notice]");
    expect(replaced).toContain('model = "gpt-6"   # keep this comment');
    expect(replaced).not.toContain("TOKEN_FILE");
    expect(replaced).toContain('[mcp_servers.local_tool.env]\nA = "1"');

    const removed = editTomlServer(CODEX_TOML, "docs", undefined);
    expect(removed).not.toContain("example.com");
    expect(removed).toContain("[mcp_servers.local_tool]");
    expect(removed).toContain("[profiles.fast]");
  });

  it("falls back to a structural patch for inline server tables", () => {
    const inline = 'model = "x"\n\n[mcp_servers]\na = { command = "one" }\n';
    const out = editTomlServer(inline, "b", { command: "two" });
    expect(out).toContain('model = "x"');
    expect(out).toMatch(/b = \{ command = "two" \}|\[mcp_servers\.b\]/);
  });
});

describe("agent configuration API", () => {
  let h: Harness;
  let memoryDir: string;

  beforeAll(async () => {
    h = await startHarness();
    const home = h.home;
    put(join(home, ".claude", "CLAUDE.md"), "# user memory\n");
    put(join(home, ".claude", "rules", "style.md"), "Use tabs.\n");
    put(
      join(home, ".claude", "skills", "deploy", "SKILL.md"),
      "---\nname: deploy\ndescription: Ship the app\n---\nSteps\n",
    );
    put(
      join(home, ".claude", "agents", "reviewer.md"),
      "---\nname: reviewer\ndescription: Reviews code\n---\n",
    );
    put(join(home, ".codex", "AGENTS.md"), "codex user\n");
    put(join(home, ".agents", "skills", "lint", "SKILL.md"), "---\nname: lint\n---\n");
    put(join(home, ".claude.json"), '{\n  "numStartups": 3,\n  "projects": {}\n}');
    put(join(home, ".codex", "config.toml"), CODEX_TOML);
    put(join(h.repo, "CLAUDE.md"), "# project\n");
    put(join(h.repo, "packages", "api", "CLAUDE.md"), "# api\n");
    put(join(h.repo, "packages", "api", "AGENTS.md"), "# api agents\n");
    put(join(h.repo, "node_modules", "x", "CLAUDE.md"), "# ignored\n");
    memoryDir = join(home, ".claude", "projects", claudeProjectSlug(h.repo), "memory");
    put(join(memoryDir, "MEMORY.md"), "- [Testing](testing.md)\n");
    put(join(memoryDir, "testing.md"), "Run vitest.\n");
  }, 60_000);

  afterAll(async () => {
    await h?.close();
  });

  it("discovers memory, rules, skills, subagents and auto memory", async () => {
    const res = AgentConfigListResponse.parse(
      (await h.api("GET", `/agent-config/files?projectId=${h.projectId}`)).body,
    );
    expect(res.autoMemoryDir?.toLowerCase()).toBe(memoryDir.toLowerCase());
    const find = (pred: (f: (typeof res.files)[number]) => boolean) => res.files.filter(pred);
    expect(find((f) => f.root === "home" && f.path === ".claude/CLAUDE.md")[0]).toMatchObject({
      provider: "claude",
      kind: "memory",
      scope: "user",
      exists: true,
    });
    expect(find((f) => f.kind === "rule")[0]?.path).toBe(".claude/rules/style.md");
    expect(find((f) => f.kind === "skill").map((f) => `${f.provider}:${f.name}`)).toEqual([
      "claude:deploy",
      "codex:lint",
    ]);
    expect(find((f) => f.kind === "skill")[0]?.description).toBe("Ship the app");
    expect(find((f) => f.kind === "subagent")[0]).toMatchObject({ name: "reviewer" });
    expect(find((f) => f.onDemand === true).map((f) => f.path)).toEqual(["packages/api/CLAUDE.md"]);
    expect(find((f) => f.provider === "codex" && f.root === "project").map((f) => f.path)).toEqual([
      "AGENTS.md",
      "packages/api/AGENTS.md",
    ]);
    expect(find((f) => f.root === "auto_memory").map((f) => f.path)).toEqual([
      "MEMORY.md",
      "testing.md",
    ]);
    expect(res.files.some((f) => f.path.includes("node_modules"))).toBe(false);
  });

  it("reads, previews, writes with a backup, creates and deletes", async () => {
    const loc = { root: "project", projectId: h.projectId, path: "CLAUDE.md" };
    const read = AgentConfigFileContent.parse(
      (
        await h.api(
          "GET",
          `/agent-config/file?root=project&projectId=${h.projectId}&path=CLAUDE.md`,
        )
      ).body,
    );
    expect(read.content).toBe("# project\n");
    const diff = AgentConfigDiff.parse(
      (await h.api("POST", "/agent-config/diff", { ...loc, content: "# project\nNew rule\n" }))
        .body,
    );
    expect(diff).toMatchObject({ changed: true, additions: 1, deletions: 0 });
    expect(diff.patch).toContain("+New rule");

    const stale = await h.api("PUT", "/agent-config/file", {
      ...loc,
      content: "x",
      expectedSha256: "0".repeat(64),
    });
    expect(stale).toMatchObject({ status: 409, body: { error: { code: "file_changed" } } });
    const written = AgentConfigWriteResponse.parse(
      (
        await h.api("PUT", "/agent-config/file", {
          ...loc,
          content: "# project\nNew rule\n",
          expectedSha256: read.sha256,
        })
      ).body,
    );
    expect(readFileSync(join(h.repo, "CLAUDE.md"), "utf8")).toContain("New rule");
    expect(readFileSync(written.backupPath as string, "utf8")).toBe("# project\n");

    const skill = { root: "home", path: ".claude/skills/new-skill/SKILL.md" };
    expect(
      (
        await h.api("POST", "/agent-config/file", {
          ...skill,
          content: "---\nname: new-skill\n---\n",
        })
      ).status,
    ).toBe(200);
    expect(
      (await h.api("POST", "/agent-config/file", { ...skill, content: "again" })).body,
    ).toMatchObject({ error: { code: "file_exists" } });
    const del = await h.api(
      "DELETE",
      "/agent-config/file?root=home&path=.claude/skills/new-skill&folder=1",
    );
    expect(del.body).toMatchObject({ deleted: true });
    expect(existsSync(join(h.home, ".claude", "skills", "new-skill"))).toBe(false);

    const mem = await h.api("PUT", "/agent-config/file", {
      root: "auto_memory",
      projectId: h.projectId,
      path: "MEMORY.md",
      content: "- [Testing](testing.md)\n- [Style](style.md)\n",
    });
    expect(mem.status).toBe(200);
    expect(readFileSync(join(memoryDir, "MEMORY.md"), "utf8")).toContain("Style");
  });

  it("refuses paths that are not agent configuration", async () => {
    for (const path of [
      ".claude/settings.json",
      ".claude/.credentials.json",
      "../x/CLAUDE.md",
      ".ssh/id_rsa",
    ]) {
      const res = await h.api(
        "GET",
        `/agent-config/file?root=home&path=${encodeURIComponent(path)}`,
      );
      expect(res.status, path).toBe(403);
    }
    const git = await h.api("PUT", "/agent-config/file", {
      root: "project",
      projectId: h.projectId,
      path: ".git/CLAUDE.md",
      content: "x",
    });
    expect(git.status).toBe(403);
  });

  it("edits MCP servers in .mcp.json, ~/.claude.json and config.toml, with previews", async () => {
    const spec = { type: "stdio", command: "npx", args: ["-y", "@acme/mcp"], env: { KEY: "v" } };
    const project = await h.api("PUT", "/agent-config/mcp", {
      provider: "claude",
      scope: "project",
      projectId: h.projectId,
      name: "acme",
      spec,
    });
    expect(project.status).toBe(200);
    const mcpJson = JSON.parse(readFileSync(join(h.repo, ".mcp.json"), "utf8"));
    expect(mcpJson.mcpServers.acme).toEqual(spec);

    const local = McpServerWriteResponse.parse(
      (
        await h.api("PUT", "/agent-config/mcp", {
          provider: "claude",
          scope: "local",
          projectId: h.projectId,
          name: "web",
          spec: { type: "http", url: "http://localhost:9000/mcp" },
        })
      ).body,
    );
    expect(local.backupPath).toBeTruthy();
    const claudeJson = JSON.parse(readFileSync(join(h.home, ".claude.json"), "utf8"));
    expect(claudeJson.numStartups).toBe(3);
    const key = process.platform === "win32" ? h.repo.replace(/\\/g, "/") : h.repo;
    expect(claudeJson.projects[key].mcpServers.web).toEqual({
      type: "http",
      url: "http://localhost:9000/mcp",
    });

    const preview = AgentConfigDiff.parse(
      (
        await h.api("POST", "/agent-config/mcp/diff", {
          provider: "codex",
          scope: "user",
          name: "acme",
          spec,
        })
      ).body,
    );
    expect(preview.deletions).toBe(0);
    expect(preview.patch).toContain("+[mcp_servers.acme]");
    await h.api("PUT", "/agent-config/mcp", {
      provider: "codex",
      scope: "user",
      name: "acme",
      spec,
    });
    const toml = readFileSync(join(h.home, ".codex", "config.toml"), "utf8");
    expect(toml.startsWith(CODEX_TOML.trimEnd())).toBe(true);

    const removed = await h.api("DELETE", "/agent-config/mcp?provider=codex&scope=user&name=docs");
    expect(removed.status).toBe(200);
    expect(readFileSync(join(h.home, ".codex", "config.toml"), "utf8")).not.toContain(
      "example.com",
    );
    const missing = await h.api("DELETE", "/agent-config/mcp?provider=codex&scope=user&name=nope");
    expect(missing.status).toBe(404);

    const list = McpServerListResponse.parse(
      (await h.api("GET", `/agent-config/mcp?projectId=${h.projectId}`)).body,
    );
    expect(list.servers.map((s) => `${s.provider}:${s.scope}:${s.name}`).sort()).toEqual([
      "claude:local:web",
      "claude:project:acme",
      "codex:user:acme",
      "codex:user:local_tool",
    ]);
    const backups = readdirSync(join(h.server.paths.backups, "agent-config"));
    expect(backups.length).toBeGreaterThanOrEqual(3);
  });

  it("lists, previews, edits and disables Claude hooks over the API", async () => {
    const settings = join(h.repo, ".claude", "settings.json");
    put(settings, '{\n  "permissions": { "allow": ["Bash(ls)"] }\n}\n');
    const add = {
      action: "add",
      provider: "claude",
      scope: "project",
      projectId: h.projectId,
      event: "PreToolUse",
      matcher: "Bash",
      handler: { type: "command", command: "guard.sh", timeout: 5 },
    };
    const preview = AgentConfigDiff.parse(
      (await h.api("POST", "/agent-config/hooks/diff", add)).body,
    );
    expect(preview.patch).toContain('"command": "guard.sh"');
    expect((await h.api("POST", "/agent-config/hooks", add)).status).toBe(200);
    expect(readFileSync(settings, "utf8")).toContain(
      '{\n  "permissions": { "allow": ["Bash(ls)"] },',
    );

    const list = HookListResponse.parse(
      (await h.api("GET", `/agent-config/hooks?projectId=${h.projectId}`)).body,
    );
    expect(list.sources.map((s) => s.scope)).toEqual(["user", "project", "local"]);
    const hook = list.hooks.find((x) => x.scope === "project");
    expect(hook).toMatchObject({ event: "PreToolUse", matcher: "Bash", enabled: true });

    const target = {
      provider: "claude",
      scope: "project",
      projectId: h.projectId,
      event: "PreToolUse",
      groupIndex: hook?.groupIndex,
      handlerIndex: hook?.handlerIndex,
      expected: hook?.handler,
    };
    const disabled = HookWriteResponse.parse(
      (
        await h.api("POST", "/agent-config/hooks", {
          action: "disable",
          target,
          listProjectId: h.projectId,
        })
      ).body,
    );
    expect(disabled.backupPath).toBeTruthy();
    expect(existsSync(h.server.paths.disabledHooks)).toBe(true);
    // The response carries the refreshed list for the page's project.
    expect(disabled.hooks.sources.map((s) => s.scope)).toEqual(["user", "project", "local"]);
    expect(disabled.hooks.hooks.find((x) => x.scope === "project")).toMatchObject({
      event: "PreToolUse",
      enabled: false,
    });
    const bad = await h.api("POST", "/agent-config/hooks", { ...add, event: "Not an event" });
    expect(bad.status).toBe(400);
    const digits = await h.api("POST", "/agent-config/hooks", { ...add, event: "Stop2" });
    expect(digits.status).toBe(400);
    // An unknown list project is refused before anything is written.
    const before = readFileSync(settings, "utf8");
    const unknown = await h.api("POST", "/agent-config/hooks", {
      ...add,
      listProjectId: "missing-project",
    });
    expect(unknown.status).toBe(404);
    expect(readFileSync(settings, "utf8")).toBe(before);
  });

  it("reports what a session loads, including CodeDen's MCP server", async () => {
    const sessionId = await h.startFakeSession();
    const loaded = LoadedAgentConfig.parse(
      (await h.api("GET", `/sessions/${sessionId}/agent-config/loaded`)).body,
    );
    expect(loaded.mcpServers.map((s) => s.name)).toContain("codeden");
    // The Fake provider has no native hooks.
    expect(loaded.hooks).toBeNull();
  });

  it("applies Claude's and Codex's discovery rules from a working directory", () => {
    const cwd = join(h.repo, "packages", "api");
    const project = { id: h.projectId, path: h.repo, autoMemoryDir: memoryDir };
    const claude = loadedClaude(h.home, cwd, h.repo, project);
    // Only files under the test home: real ancestors of the temp folder may hold their own.
    const ours = claude.memory.filter((f) => f.absolutePath.startsWith(h.home));
    expect(ours[0]?.absolutePath).toBe(join(h.home, ".claude", "CLAUDE.md"));
    expect(ours.map((f) => f.kind)).toEqual(["memory", "rule", "memory", "memory", "auto_memory"]);
    expect(claude.skills.map((s) => s.name)).toEqual(["deploy"]);
    expect(claude.subagents.map((s) => s.name)).toEqual(["reviewer"]);

    const codex = loadedCodex(h.home, cwd, h.repo, project);
    expect(codex.memory.map((f) => f.absolutePath).filter((p) => p.startsWith(h.home))).toEqual([
      join(h.home, ".codex", "AGENTS.md"),
      join(h.repo, "packages", "api", "AGENTS.md"),
    ]);
    expect(codex.skills.map((s) => s.name)).toEqual(["lint"]);
  });
});

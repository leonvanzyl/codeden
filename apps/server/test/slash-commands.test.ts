import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { type ProviderCommand, SessionFileList, SlashCommandList } from "@codeden/contracts";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { AgentConfigService } from "../src/services/agent-config/agent-config-service";
import type { ProjectService } from "../src/services/projects/project-service";
import type { SessionRepo } from "../src/services/sessions/repo";
import { type Harness, startHarness, TOKEN } from "./support/harness";

function put(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

describe("GET /api/sessions/:id/commands", () => {
  let h: Harness;

  beforeAll(async () => {
    h = await startHarness();
  });
  afterAll(async () => {
    await h?.close();
  });

  const get = (path: string) =>
    fetch(`${h.server.url}/api${path}`, { headers: { authorization: `Bearer ${TOKEN}` } });

  it("serves a session's commands, including the ones its provider reports", async () => {
    const sessionId = await h.startFakeSession();
    // The composer's `/` menu reads this route (it showed nothing while the route was missing).
    const res = await get(`/sessions/${sessionId}/commands`);
    const text = await res.text();
    expect({ status: res.status, text }).toMatchObject({ status: 200 });
    // The Fake provider reports one built-in command when its session opens.
    expect(SlashCommandList.parse(JSON.parse(text))).toEqual([
      {
        name: "echo",
        description: "Reply with the message (Fake provider)",
        kind: "command",
        provider: "fake",
      },
    ]);
  });

  it("answers 404 for an unknown session", async () => {
    const res = await get("/sessions/no-such-session/commands");
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ error: { code: "session_not_found" } });
  });

  it("serves a project's commands and files for the New session draft, with the token", async () => {
    put(
      join(h.repo, ".claude", "commands", "release.md"),
      "---\ndescription: Cut a release\n---\n",
    );
    const res = await get(`/projects/${h.projectId}/commands?provider=claude`);
    expect(res.status).toBe(200);
    expect(SlashCommandList.parse(await res.json())).toContainEqual({
      name: "release",
      description: "Cut a release",
      kind: "command",
      provider: "claude",
    });
    // The provider is required: it decides which files apply.
    expect((await get(`/projects/${h.projectId}/commands`)).status).toBe(400);

    const files = await get(`/projects/${h.projectId}/files`);
    expect(files.status).toBe(200);
    const list = SessionFileList.parse(await files.json());
    expect(list.entries).toContainEqual({
      path: ".claude/commands/release.md",
      kind: "file",
      sizeBytes: expect.any(Number),
    });

    const anonymous = await fetch(`${h.server.url}/api/projects/${h.projectId}/files`);
    expect(anonymous.status).toBe(401);
  });
});

describe("a session's `/` commands and skills", () => {
  let dir: string;
  let home: string;
  let repo: string;
  let session: { provider: string; cwd: string; projectId: string | null };
  let reported: ProviderCommand[] | null;
  let service: AgentConfigService;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "codeden-slash-"));
    home = join(dir, "home");
    repo = join(dir, "repo");
    mkdirSync(join(repo, ".git"), { recursive: true });
    mkdirSync(home, { recursive: true });
    session = { provider: "claude", cwd: repo, projectId: "p1" };
    reported = null;
    service = new AgentConfigService({
      home,
      projects: { get: (id: string) => ({ id, path: repo }) } as unknown as ProjectService,
      repo: { get: () => session } as unknown as SessionRepo,
      backupDir: join(dir, "backups"),
      disabledHooksFile: join(dir, "disabled-hooks.json"),
      mcpProxyUrl: () => null,
      runner: { request: () => Promise.reject(new Error("no runner")) },
      reportedCommands: () => reported,
    });
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const list = () => SlashCommandList.parse(service.slashCommands("s1"));

  it("lists user and project skills and custom commands, then what the provider reports", () => {
    put(
      join(home, ".claude", "skills", "deploy", "SKILL.md"),
      "---\nname: deploy\ndescription: Ship the app\n---\nSteps\n",
    );
    put(join(repo, ".claude", "skills", "lint", "SKILL.md"), "---\nname: lint\n---\n");
    put(
      join(repo, ".claude", "commands", "frontend", "fix-issue.md"),
      "---\ndescription: Fix a GitHub issue\nargument-hint: [issue-number]\n---\nFix #$1.\n",
    );
    put(join(repo, ".claude", "commands", "notes.md"), "---\ndescription: Project notes\n---\n");
    // A user command of the same name is shadowed by the project's.
    put(join(home, ".claude", "commands", "notes.md"), "# Summarize my notes\n\nMore text\n");
    put(join(home, ".claude", "commands", "standup.md"), "# Write my standup\n\nMore text\n");
    put(join(home, ".claude", "commands", "has space.md"), "Not completable\n");
    const claude = { kind: "command", provider: "claude" } as const;

    // Before the provider has reported anything: what the files say.
    expect(list()).toEqual([
      { name: "deploy", description: "Ship the app", kind: "skill", provider: "claude" },
      {
        name: "frontend:fix-issue",
        description: "Fix a GitHub issue",
        ...claude,
        argumentHint: "[issue-number]",
      },
      { name: "lint", description: "", kind: "skill", provider: "claude" },
      { name: "notes", description: "Project notes", ...claude },
      { name: "standup", description: "Write my standup", ...claude },
    ]);

    // Once it has, its list decides; the files mark its skills and fill in descriptions.
    reported = [
      { name: "compact", description: "Free up context", builtin: true },
      { name: "deploy", description: "deploy (user)" },
      { name: "frontend:fix-issue", description: "Fix a GitHub issue (project)" },
      { name: "plugin:review", description: "Review a PR", argumentHint: "<pr>" },
    ];
    expect(list()).toEqual([
      { name: "compact", description: "Free up context", ...claude },
      { name: "deploy", description: "Ship the app", kind: "skill", provider: "claude" },
      {
        name: "frontend:fix-issue",
        description: "Fix a GitHub issue",
        ...claude,
        argumentHint: "[issue-number]",
      },
      { name: "plugin:review", description: "Review a PR", ...claude, argumentHint: "<pr>" },
    ]);
  });

  it("keeps the discovered skills when the provider reports an empty list", () => {
    put(
      join(home, ".claude", "skills", "deploy", "SKILL.md"),
      "---\nname: deploy\ndescription: Ship the app\n---\n",
    );
    reported = [];
    expect(list()).toEqual([
      { name: "deploy", description: "Ship the app", kind: "skill", provider: "claude" },
    ]);
  });

  it("shows the built-in a name runs, even when a skill or a custom row shares it", () => {
    put(
      join(home, ".claude", "skills", "compact", "SKILL.md"),
      "---\nname: compact\ndescription: My compact skill\n---\n",
    );
    const builtin = {
      name: "compact",
      description: "Free up context",
      argumentHint: "<instructions>",
      builtin: true,
    };
    const custom = { name: "compact", description: "My compact skill" };
    const shown = {
      name: "compact",
      description: "Free up context",
      kind: "command",
      provider: "claude",
      argumentHint: "<instructions>",
    };
    for (const rows of [[builtin, custom], [custom, builtin], [builtin]]) {
      reported = rows;
      expect(list()).toEqual([shown]);
    }
  });

  it("fills a description and argument hint the files lack from the provider's row", () => {
    put(join(repo, ".claude", "skills", "lint", "SKILL.md"), "---\nname: lint\n---\n");
    reported = [{ name: "lint", description: "Run the linter", argumentHint: "<path>" }];
    expect(list()).toEqual([
      {
        name: "lint",
        description: "Run the linter",
        kind: "skill",
        provider: "claude",
        argumentHint: "<path>",
      },
    ]);
  });

  it("gives a session outside any project only user-level entries", () => {
    put(join(home, ".claude", "commands", "standup.md"), "Write my standup\n");
    put(join(repo, ".claude", "commands", "release.md"), "Cut a release\n");
    const outside = join(dir, "orchestrator");
    mkdirSync(outside);
    session = { provider: "claude", cwd: outside, projectId: null };
    expect(list().map((c) => c.name)).toEqual(["standup"]);
  });

  it("is empty for a session in a folder with none, and keeps a provider's skills", () => {
    session = { provider: "codex", cwd: repo, projectId: "p1" };
    expect(list()).toEqual([]);
    // Codex skills apply; Claude's command files don't.
    put(join(repo, ".agents", "skills", "lint", "SKILL.md"), "---\nname: lint\n---\n");
    put(join(repo, ".claude", "commands", "release.md"), "Cut a release\n");
    expect(list()).toEqual([{ name: "lint", description: "", kind: "skill", provider: "codex" }]);
  });

  it("lists what a provider would load in the project folder before a session exists", () => {
    put(join(repo, ".claude", "skills", "lint", "SKILL.md"), "---\nname: lint\n---\n");
    put(join(repo, ".claude", "commands", "release.md"), "Cut a release\n");
    put(join(repo, ".agents", "skills", "deploy", "SKILL.md"), "---\nname: deploy\n---\n");
    // Nothing is reported for a draft, even when sessions of the project have reports.
    reported = [{ name: "compact", description: "Free up context", builtin: true }];
    const draft = (provider: string) =>
      SlashCommandList.parse(service.projectSlashCommands("p1", provider));
    expect(draft("claude")).toEqual([
      { name: "lint", description: "", kind: "skill", provider: "claude" },
      { name: "release", description: "Cut a release", kind: "command", provider: "claude" },
    ]);
    expect(draft("codex")).toEqual([
      { name: "deploy", description: "", kind: "skill", provider: "codex" },
    ]);
    expect(draft("fake")).toEqual([]);
  });
});

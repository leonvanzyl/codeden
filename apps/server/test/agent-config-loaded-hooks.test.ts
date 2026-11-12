import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { LoadedAgentConfig } from "@codeden/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AgentConfigService } from "../src/services/agent-config/agent-config-service";
import { HookShelf } from "../src/services/agent-config/hook-shelf";
import { claudeSessionHookFiles } from "../src/services/agent-config/hooks";
import { AgentConfigHooks } from "../src/services/agent-config/hooks-service";
import type { ProjectService } from "../src/services/projects/project-service";
import type { SessionRepo } from "../src/services/sessions/repo";

function put(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

const settings = (doc: Record<string, unknown>) => JSON.stringify(doc);
const commandHook = (event: string, command: string, matcher?: string) => ({
  hooks: { [event]: [{ ...(matcher ? { matcher } : {}), hooks: [{ type: "command", command }] }] },
});

describe("hooks that apply to a session's working folder", () => {
  let dir: string;
  let home: string;
  let repo: string;
  let hooks: AgentConfigHooks;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "codeden-loaded-hooks-"));
    home = join(dir, "home");
    repo = join(dir, "repo");
    mkdirSync(join(repo, ".git"), { recursive: true });
    hooks = new AgentConfigHooks({
      home,
      project: (id) => ({ id, path: repo }),
      backup: () => {
        throw new Error("What's loaded never writes");
      },
      shelf: new HookShelf(join(dir, "data", "disabled-hooks.json")),
    });
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  /** A worktree of `repo` whose `.git` file points at the main checkout. */
  function worktree(): string {
    const wt = join(dir, "wt", "feature");
    mkdirSync(join(repo, ".git", "worktrees", "feature"), { recursive: true });
    put(join(wt, ".git"), `gitdir: ${join(repo, ".git", "worktrees", "feature")}\n`);
    return wt;
  }

  const files = (cwd: string, gitRoot: string | null, platform: NodeJS.Platform) =>
    claudeSessionHookFiles(home, cwd, gitRoot, "p1", platform).map((f) => `${f.scope} ${f.file}`);

  it("reads the shared file from the working folder only, never a parent's", () => {
    const cwd = join(repo, "packages", "api");
    put(join(repo, ".claude", "settings.json"), settings(commandHook("Stop", "parent")));
    expect(files(cwd, repo, "linux")).toEqual([
      `user ${join(home, ".claude", "settings.json")}`,
      `project ${join(cwd, ".claude", "settings.json")}`,
      `local ${join(repo, ".claude", "settings.local.json")}`,
    ]);
  });

  it("takes the local file from the main checkout's root, beside the shared one on Windows", () => {
    const wt = worktree();
    expect(files(wt, wt, "linux")).toEqual([
      `user ${join(home, ".claude", "settings.json")}`,
      `project ${join(wt, ".claude", "settings.json")}`,
      `local ${join(repo, ".claude", "settings.local.json")}`,
    ]);
    // An older Claude Code kept the local file in the starting folder; it is still read.
    put(join(wt, ".claude", "settings.local.json"), "{}");
    expect(files(wt, wt, "darwin").slice(2)).toEqual([
      `local ${join(repo, ".claude", "settings.local.json")}`,
      `local ${join(wt, ".claude", "settings.local.json")}`,
    ]);
    // Windows, no repository, or a repository at the home folder: beside the shared file.
    expect(files(wt, wt, "win32").slice(2)).toEqual([
      `local ${join(wt, ".claude", "settings.local.json")}`,
    ]);
    expect(files(wt, null, "linux").slice(2)).toEqual([
      `local ${join(wt, ".claude", "settings.local.json")}`,
    ]);
    const inHome = join(home, "notes");
    expect(claudeSessionHookFiles(home, inHome, home, null, "linux")[2]?.file).toBe(
      join(inHome, ".claude", "settings.local.json"),
    );
  });

  it("lists each file's hooks and the file whose disableAllHooks wins", () => {
    const cwd = join(dir, "scratch");
    const user = join(home, ".claude", "settings.json");
    const project = join(cwd, ".claude", "settings.json");
    const local = join(cwd, ".claude", "settings.local.json");
    put(
      user,
      settings({ disableAllHooks: true, ...commandHook("PreToolUse", "guard.sh", "Bash") }),
    );
    put(project, settings(commandHook("PostToolUse", "prettier --write", "Edit|Write")));

    // Outside a repository the local file sits beside the shared one on every platform.
    let loaded = hooks.forSession(cwd, null, "p1");
    expect(loaded.sources.map((s) => `${s.scope} ${s.file} ${s.exists}`)).toEqual([
      `user ${user} true`,
      `project ${project} true`,
      `local ${local} false`,
    ]);
    expect(
      loaded.hooks.map((h) => `${h.scope}:${h.event}:${h.matcher}:${h.handler.command}`),
    ).toEqual(["user:PreToolUse:Bash:guard.sh", "project:PostToolUse:Edit|Write:prettier --write"]);
    expect(loaded.hooks[1]).toMatchObject({ file: project, projectId: "p1", enabled: true });
    expect(loaded.disabledBy).toBe(user);

    // A higher-precedence `false` turns them back on; a higher `true` names its own file.
    put(local, settings({ disableAllHooks: false }));
    expect(hooks.forSession(cwd, null, "p1").disabledBy).toBeNull();
    put(project, settings({ disableAllHooks: true }));
    put(local, "{}");
    expect(hooks.forSession(cwd, null, "p1").disabledBy).toBe(project);

    // A file that doesn't parse is reported and adds no hooks.
    put(local, "{ not json");
    loaded = hooks.forSession(cwd, null, "p1");
    expect(loaded.sources[2]?.error).toContain("could not be parsed");
    expect(loaded.hooks.map((h) => h.scope)).toEqual(["user"]);
  });

  it("reports a .claude folder that links outside the working folder instead of reading it", () => {
    const cwd = join(dir, "scratch");
    const outside = join(dir, "outside");
    put(join(outside, "settings.json"), settings(commandHook("Stop", "secret")));
    mkdirSync(cwd, { recursive: true });
    symlinkSync(outside, join(cwd, ".claude"), "junction");
    const loaded = hooks.forSession(cwd, null, null);
    expect(loaded.sources.find((s) => s.scope === "project")?.error).toContain("resolves outside");
    expect(loaded.hooks.some((h) => h.handler.command === "secret")).toBe(false);
  });

  it("is part of What's loaded for providers with hooks, and null for the others", () => {
    const cwd = join(dir, "scratch");
    put(join(cwd, ".claude", "settings.json"), settings(commandHook("Stop", "notify")));
    let provider = "claude";
    const service = new AgentConfigService({
      home,
      projects: {} as ProjectService,
      repo: { get: () => ({ provider, cwd, projectId: null }) } as unknown as SessionRepo,
      backupDir: join(dir, "backups"),
      disabledHooksFile: join(dir, "data", "disabled-hooks.json"),
      mcpProxyUrl: () => null,
    });
    const claude = LoadedAgentConfig.parse(service.loaded("s1"));
    expect(claude.hooks?.hooks.map((h) => h.handler.command)).toEqual(["notify"]);
    for (provider of ["codex", "fake"]) {
      expect(LoadedAgentConfig.parse(service.loaded("s1")).hooks).toBeNull();
    }
  });
});

import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { type ProviderCommand, SlashCommandList } from "@codeden/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AgentConfigService } from "../src/services/agent-config/agent-config-service";
import type { ProjectService } from "../src/services/projects/project-service";
import type { SessionRepo } from "../src/services/sessions/repo";
import { removeTree } from "./support/remove-tree";

function put(path: string, content = ""): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

const skill = (description?: string, name?: string) =>
  `---\n${name ? `name: ${name}\n` : ""}${description ? `description: ${description}\n` : ""}---\nBody\n`;

describe("OpenCode's `/` commands and skills from its files", () => {
  let dir: string;
  let home: string;
  let repo: string;
  let session: { provider: string; cwd: string; projectId: string | null };
  let reported: ProviderCommand[] | null;
  let service: AgentConfigService;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "codeden-oc-slash-"));
    home = join(dir, "home");
    repo = join(dir, "repo");
    mkdirSync(join(repo, ".git"), { recursive: true });
    mkdirSync(home, { recursive: true });
    session = { provider: "opencode", cwd: repo, projectId: "p1" };
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
  afterEach(() => removeTree(dir));

  const draft = () => SlashCommandList.parse(service.projectSlashCommands("p1", "opencode"));
  const list = () => SlashCommandList.parse(service.slashCommands("s1"));
  const oc = { provider: "opencode" } as const;

  it("reads OpenCode's skill and command folders, user and project, for the draft", () => {
    put(join(home, ".config", "opencode", "skills", "g-oc", "SKILL.md"), skill("Global OpenCode"));
    put(join(home, ".claude", "skills", "g-claude", "SKILL.md"), skill("Global Claude"));
    put(join(home, ".agents", "skills", "g-agents", "SKILL.md"), skill("Global agents"));
    put(join(repo, ".opencode", "skills", "p-oc", "SKILL.md"), skill("Project OpenCode"));
    put(join(repo, ".claude", "skills", "p-claude", "SKILL.md"), skill());
    put(join(repo, ".agents", "skills", "p-agents", "SKILL.md"), skill("Project agents"));
    // Named by folder (the id OpenCode loads it by), nested folders and top-level files too.
    put(join(repo, ".opencode", "skills", "folder-name", "SKILL.md"), skill("By folder", "Pretty"));
    put(join(repo, ".claude", "skills", "group", "inner", "SKILL.md"), skill("Nested"));
    put(join(home, ".agents", "skills", "quick.md"), skill("A top-level file"));
    put(join(repo, ".opencode", "skills", ".hidden", "SKILL.md"), skill("Skipped"));
    // Commands: `commands/` and the legacy `command/`, nested ones named with `/`.
    put(
      join(repo, ".opencode", "commands", "hello.md"),
      "---\ndescription: Say hello\n---\nHi $1\n",
    );
    put(
      join(repo, ".opencode", "commands", "team", "review.md"),
      "---\ndescription: Review\n---\n",
    );
    put(join(repo, ".opencode", "command", "legacy.md"), "Legacy command body\n");
    put(
      join(home, ".config", "opencode", "commands", "gcmd.md"),
      "---\ndescription: Global\n---\n",
    );
    put(join(home, ".config", "opencode", "command", "glegacy.md"), "Old global\n");
    // Not OpenCode's: Claude Code's command files.
    put(join(repo, ".claude", "commands", "claude-only.md"), "Claude only\n");

    expect(draft()).toEqual([
      { name: "folder-name", description: "By folder", kind: "skill", ...oc },
      { name: "g-agents", description: "Global agents", kind: "skill", ...oc },
      { name: "g-claude", description: "Global Claude", kind: "skill", ...oc },
      { name: "g-oc", description: "Global OpenCode", kind: "skill", ...oc },
      { name: "gcmd", description: "Global", kind: "command", ...oc },
      { name: "glegacy", description: "Old global", kind: "command", ...oc },
      { name: "hello", description: "Say hello", kind: "command", ...oc },
      { name: "inner", description: "Nested", kind: "skill", ...oc },
      { name: "legacy", description: "Legacy command body", kind: "command", ...oc },
      { name: "p-agents", description: "Project agents", kind: "skill", ...oc },
      { name: "p-claude", description: "", kind: "skill", ...oc },
      { name: "p-oc", description: "Project OpenCode", kind: "skill", ...oc },
      { name: "quick", description: "A top-level file", kind: "skill", ...oc },
      { name: "team/review", description: "Review", kind: "command", ...oc },
    ]);
  });

  it("resolves a name as OpenCode does", () => {
    // .opencode over .agents over .claude, whoever's folder it is.
    put(join(home, ".claude", "skills", "dup", "SKILL.md"), skill("user .claude"));
    put(join(repo, ".opencode", "skills", "dup", "SKILL.md"), skill("project .opencode"));
    put(join(repo, ".claude", "skills", "dup2", "SKILL.md"), skill("project .claude"));
    put(join(repo, ".agents", "skills", "dup2", "SKILL.md"), skill("project .agents"));
    put(join(home, ".config", "opencode", "skills", "dup2", "SKILL.md"), skill("user .opencode"));
    // The project over the user, and the folder nearest the working folder first.
    put(join(home, ".config", "opencode", "commands", "hello.md"), "Global hello\n");
    put(join(repo, ".opencode", "commands", "hello.md"), "Project hello\n");
    put(join(repo, ".opencode", "skills", "near", "SKILL.md"), skill("repo root"));
    put(join(repo, "pkg", ".opencode", "skills", "near", "SKILL.md"), skill("nearest"));
    // `commands/` over the legacy `command/`, and a command over a skill of its name.
    put(join(repo, ".opencode", "command", "both.md"), "Legacy both\n");
    put(join(repo, ".opencode", "commands", "both.md"), "Both\n");
    put(join(repo, ".opencode", "skills", "both", "SKILL.md"), skill("A skill"));

    session = { provider: "opencode", cwd: join(repo, "pkg"), projectId: "p1" };
    const byName = Object.fromEntries(list().map((c) => [c.name, `${c.kind}: ${c.description}`]));
    expect(byName).toEqual({
      both: "command: Both",
      dup: "skill: project .opencode",
      dup2: "skill: user .opencode",
      hello: "command: Project hello",
      near: "skill: nearest",
    });
  });

  it("shows OpenCode's own list once the session reports it, its skills as skills", () => {
    put(join(repo, ".opencode", "commands", "hello.md"), "---\ndescription: Say hello\n---\n");
    put(join(repo, ".opencode", "skills", "pdf", "SKILL.md"), skill("Read PDFs"));
    reported = [
      { name: "init", description: "guided AGENTS.md setup", kind: "command" },
      { name: "hello", description: "", kind: "command" },
      // From OpenCode's config or a plugin: no file says it is a skill, the report does.
      { name: "from-config", description: "Configured skill", kind: "skill" },
      { name: "pdf", description: "", kind: "skill" },
    ];
    expect(list()).toEqual([
      { name: "from-config", description: "Configured skill", kind: "skill", ...oc },
      { name: "hello", description: "Say hello", kind: "command", ...oc },
      { name: "init", description: "guided AGENTS.md setup", kind: "command", ...oc },
      { name: "pdf", description: "Read PDFs", kind: "skill", ...oc },
    ]);
    // What the session runs for a name decides its kind, over what a file says.
    reported = [{ name: "pdf", description: "", kind: "command" }];
    expect(list()).toEqual([{ name: "pdf", description: "Read PDFs", kind: "command", ...oc }]);
  });

  it("takes a linked skill folder as a skill, and never walks through a link", () => {
    const elsewhere = join(dir, "elsewhere");
    put(join(elsewhere, "linked", "SKILL.md"), skill("Linked in"));
    // A link to a broad folder: whatever skills sit inside it are not scanned.
    put(join(elsewhere, "broad", "deep", "hidden-away", "SKILL.md"), skill("Behind a link"));
    mkdirSync(join(home, ".claude", "skills"), { recursive: true });
    // Junctions need no special rights on Windows; elsewhere the type is ignored.
    symlinkSync(join(elsewhere, "linked"), join(home, ".claude", "skills", "linked"), "junction");
    symlinkSync(join(elsewhere, "broad"), join(home, ".claude", "skills", "broad"), "junction");
    symlinkSync(home, join(home, ".claude", "skills", "loop"), "junction");

    expect(draft()).toEqual([{ name: "linked", description: "Linked in", kind: "skill", ...oc }]);
  });

  it("has no skill switches for OpenCode: What's loaded lists no OpenCode skills", () => {
    put(join(repo, ".opencode", "skills", "pdf", "SKILL.md"), skill("Read PDFs"));
    expect(service.loaded("s1").skills).toEqual([]);
    expect(list().map((c) => c.name)).toEqual(["pdf"]);
  });
});

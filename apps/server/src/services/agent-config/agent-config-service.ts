import { existsSync } from "node:fs";
import { join } from "node:path";
import type {
  AgentConfigDiff,
  AgentConfigListQuery,
  AgentConfigListResponse,
  AgentConfigLocator,
  LoadedAgentConfig,
  McpServerDiffRequest,
  McpServerEntry,
  McpServerTarget,
  McpServerUpsertRequest,
  McpServerWriteResponse,
} from "@codeden/contracts";
import { badRequest } from "../errors";
import type { ProjectService } from "../projects/project-service";
import type { SessionRepo } from "../sessions/repo";
import {
  listClaudeProject,
  listClaudeUser,
  listCodexProject,
  listCodexUser,
  loadedClaude,
  loadedCodex,
  type ProjectRef,
} from "./catalog";
import { AgentConfigFiles } from "./files";
import { HookShelf } from "./hook-shelf";
import { AgentConfigHooks } from "./hooks-service";
import { applyChange, claudeProjectKey, diffChange, readServers, sourceFor } from "./mcp";
import { claudeAutoMemoryDir, findGitRoot, mainRepoRoot, readJson } from "./paths";

export interface AgentConfigServiceDeps {
  /** User home (`~`); tests point it at a temp folder. */
  home: string;
  projects: ProjectService;
  repo: SessionRepo;
  /** `<codeden home>/backups/agent-config`. */
  backupDir: string;
  /** `<codeden home>/agent-config/disabled-hooks.json`: hooks switched off in CodeDen. */
  disabledHooksFile: string;
  /** CodeDen's own MCP endpoint as agents see it (the runner proxy). */
  mcpProxyUrl: () => string | null;
}

/**
 * Agent configuration (§12.4): discovery of each provider's memory files, skills, subagents,
 * MCP servers and hooks; edits in the native files with backups and diff previews; and the
 * "what's loaded" view of a session.
 */
export class AgentConfigService {
  readonly files: AgentConfigFiles;
  readonly hooks: AgentConfigHooks;

  constructor(private readonly deps: AgentConfigServiceDeps) {
    this.files = new AgentConfigFiles((l) => this.rootDir(l), deps.backupDir);
    this.hooks = new AgentConfigHooks({
      home: deps.home,
      project: (id) => this.project(id),
      backup: (file) => this.files.backup(file),
      shelf: new HookShelf(deps.disabledHooksFile),
    });
  }

  list(query: AgentConfigListQuery): AgentConfigListResponse {
    const project = query.projectId ? this.project(query.projectId) : null;
    const wantClaude = query.provider !== "codex";
    const wantCodex = query.provider !== "claude";
    const files = [
      ...(wantClaude ? listClaudeUser(this.deps.home) : []),
      ...(wantCodex ? listCodexUser(this.deps.home) : []),
      ...(project && wantClaude ? listClaudeProject(project) : []),
      ...(project && wantCodex ? listCodexProject(project) : []),
    ].filter((f) => !query.kind || f.kind === query.kind);
    return { files, autoMemoryDir: project?.autoMemoryDir ?? null };
  }

  // ------------------------------------------------------------------- MCP servers

  mcpList(projectId?: string): McpServerEntry[] {
    const project = projectId ? this.project(projectId) : null;
    const targets: Array<Pick<McpServerTarget, "provider" | "scope">> = [
      { provider: "claude", scope: "user" },
      ...(project
        ? ([
            { provider: "claude", scope: "local" },
            { provider: "claude", scope: "project" },
          ] as const)
        : []),
      { provider: "codex", scope: "user" },
    ];
    return targets.flatMap((t) => readServers(sourceFor(t, this.deps.home, project)));
  }

  mcpUpsert(req: McpServerUpsertRequest): McpServerWriteResponse {
    return this.mcpWrite(req, req.spec);
  }

  mcpDelete(target: McpServerTarget): McpServerWriteResponse {
    return this.mcpWrite(target, undefined);
  }

  mcpDiff(req: McpServerDiffRequest): AgentConfigDiff {
    return diffChange(this.mcpSource(req), req.name, req.spec);
  }

  // ------------------------------------------------------------------- what's loaded

  loaded(sessionId: string): LoadedAgentConfig {
    const session = this.deps.repo.get(sessionId);
    const project = session.projectId ? this.project(session.projectId) : null;
    const cwd = session.cwd;
    const gitRoot = findGitRoot(cwd);
    const home = this.deps.home;
    const files =
      session.provider === "codex"
        ? loadedCodex(home, cwd, gitRoot, project)
        : session.provider === "claude"
          ? loadedClaude(home, cwd, gitRoot, project)
          : { memory: [], skills: [], subagents: [] };
    const mcpServers: McpServerEntry[] = [];
    const proxy = this.deps.mcpProxyUrl();
    if (proxy) {
      mcpServers.push({
        provider: "codeden",
        scope: "user",
        name: "codeden",
        spec: { type: "http", url: proxy },
        file: "CodeDen",
        projectId: session.projectId,
      });
    }
    if (session.provider === "claude") {
      mcpServers.push(...this.claudeLoadedServers(cwd, gitRoot, project));
    } else if (session.provider === "codex") {
      const user = readServers(sourceFor({ provider: "codex", scope: "user" }, home, null));
      mcpServers.push(...user.filter((s) => s.spec.enabled !== false));
    }
    return { sessionId, provider: session.provider, cwd, ...files, mcpServers };
  }

  // ------------------------------------------------------------------- helpers

  /** A project with its Claude auto-memory folder (keyed by the main repo root). */
  project(projectId: string): ProjectRef {
    const project = this.deps.projects.get(projectId);
    const gitRoot = findGitRoot(project.path);
    const repoRoot = gitRoot ? mainRepoRoot(gitRoot) : project.path;
    return {
      id: project.id,
      path: project.path,
      autoMemoryDir: claudeAutoMemoryDir(this.deps.home, repoRoot),
    };
  }

  private rootDir(locator: AgentConfigLocator): string {
    if (locator.root === "home") return this.deps.home;
    if (!locator.projectId) throw badRequest("projectId is required", "project_required");
    const project = this.project(locator.projectId);
    return locator.root === "project" ? project.path : project.autoMemoryDir;
  }

  private mcpSource(target: Pick<McpServerTarget, "provider" | "scope" | "projectId">) {
    const project = target.projectId ? this.project(target.projectId) : null;
    return sourceFor(target, this.deps.home, project);
  }

  private mcpWrite(target: McpServerTarget, spec: McpServerUpsertRequest["spec"] | undefined) {
    const source = this.mcpSource(target);
    const backupPath = applyChange(source, target.name, spec, (f) => this.files.backup(f));
    return { file: source.file, backupPath, servers: this.mcpList(target.projectId) };
  }

  /** Claude: user servers, local servers for the working directory, and `.mcp.json` ones. */
  private claudeLoadedServers(cwd: string, gitRoot: string | null, project: ProjectRef | null) {
    const home = this.deps.home;
    const user = readServers(sourceFor({ provider: "claude", scope: "user" }, home, null));
    const claudeJson = join(home, ".claude.json");
    const doc = (existsSync(claudeJson) ? readJson(claudeJson) : undefined) ?? {};
    const local = readServers({
      provider: "claude",
      scope: "local",
      file: claudeJson,
      format: "json",
      keyPath: ["projects", claudeProjectKey(doc, cwd), "mcpServers"],
      projectId: project?.id ?? null,
    });
    const mcpJson = join(gitRoot ?? cwd, ".mcp.json");
    const shared = readServers({
      provider: "claude",
      scope: "project",
      file: mcpJson,
      format: "json",
      keyPath: ["mcpServers"],
      projectId: project?.id ?? null,
    });
    return [...user, ...local, ...shared];
  }
}

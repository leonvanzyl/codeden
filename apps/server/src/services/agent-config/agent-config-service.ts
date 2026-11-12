import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  type AgentConfigDiff,
  type AgentConfigListQuery,
  type AgentConfigListResponse,
  type AgentConfigLocator,
  AgentConfigProvider,
  agentConfigFeatures,
  type LoadedAgentConfig,
  MCP_TEST_DEFAULT_TIMEOUT_MS,
  type McpServerDiffRequest,
  type McpServerEntry,
  type McpServerTarget,
  type McpServerTestRequest,
  type McpServerTestResult,
  type McpServerUpsertRequest,
  type McpServerWriteResponse,
  type ProviderCommand,
  type SlashCommand,
} from "@codeden/contracts";
import { badRequest, ServiceError } from "../errors";
import type { ProjectService } from "../projects/project-service";
import { type RunnerPort, toServiceError } from "../runner-port";
import type { SessionRepo } from "../sessions/repo";
import {
  type LoadedFiles,
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
import { AgentConfigSkills } from "./skills-service";
import { loadedClaudeCommands, mergeSlashCommands, skillCommand } from "./slash-commands";

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
  /** The runner, which runs MCP connection tests next to the code (§4.2). */
  runner: Pick<RunnerPort, "request">;
  /** The newest `/` command list a session's provider reported, or null (event log). */
  reportedCommands: (sessionId: string) => ProviderCommand[] | null;
}

/** Extra time the server waits for the runner beyond the test's own timeout. */
const MCP_TEST_SLACK_MS = 5_000;

/**
 * Agent configuration (§12.4): discovery of each provider's memory files, skills, subagents,
 * MCP servers and hooks; edits in the native files with backups and diff previews; skill
 * switches; and the "what's loaded" view of a session.
 */
export class AgentConfigService {
  readonly files: AgentConfigFiles;
  readonly hooks: AgentConfigHooks;
  readonly skills: AgentConfigSkills;

  constructor(private readonly deps: AgentConfigServiceDeps) {
    this.files = new AgentConfigFiles((l) => this.rootDir(l), deps.backupDir);
    this.hooks = new AgentConfigHooks({
      home: deps.home,
      project: (id) => this.project(id),
      backup: (file) => this.files.backup(file),
      shelf: new HookShelf(deps.disabledHooksFile),
    });
    this.skills = new AgentConfigSkills({
      home: deps.home,
      project: (id) => this.project(id),
      backup: (file) => this.files.backup(file),
      resolve: (locator) => this.files.resolve(locator),
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

  /**
   * Connection test in the runner: the request's (unsaved) spec, or the server saved at the
   * target. stdio servers start in the project folder (`local`, `project`) or, for `user`
   * scope, the runner's home; Claude's `${VAR}` placeholders are expanded there. A Codex stdio
   * server gets only the variables Codex would give it.
   */
  async mcpTest(req: McpServerTestRequest): Promise<McpServerTestResult> {
    const source = this.mcpSource(req);
    const spec = req.spec ?? readServers(source).find((s) => s.name === req.name)?.spec;
    if (!spec) {
      throw new ServiceError(
        404,
        "server_not_found",
        `No MCP server named ${req.name} in ${source.file}`,
      );
    }
    const cwd =
      req.scope !== "user" && req.projectId ? this.project(req.projectId).path : undefined;
    try {
      return await this.deps.runner.request(
        {
          name: "mcp.test",
          spec,
          expandEnv: req.provider === "claude",
          stdioEnv: req.provider === "codex" ? "allowlist" : "inherit",
          ...(cwd ? { cwd } : {}),
        },
        MCP_TEST_DEFAULT_TIMEOUT_MS + MCP_TEST_SLACK_MS,
      );
    } catch (error) {
      throw toServiceError(error);
    }
  }

  // ------------------------------------------------------------------- what's loaded

  loaded(sessionId: string): LoadedAgentConfig {
    const { session, project, gitRoot, files } = this.discover(sessionId);
    const cwd = session.cwd;
    const home = this.deps.home;
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
    const provider = AgentConfigProvider.safeParse(session.provider);
    const hooks =
      provider.success && agentConfigFeatures[provider.data].hooks
        ? this.hooks.forSession(cwd, gitRoot, session.projectId)
        : null;
    return { sessionId, provider: session.provider, cwd, ...files, mcpServers, hooks };
  }

  /**
   * The composer's `/` menu for a session (§13): the skills that apply to its working folder
   * (as What's loaded finds them, without those switched off) and its provider's custom
   * command files; once the provider has reported a non-empty list of what it runs for the
   * session (built-in ones included), that list (`mergeSlashCommands`).
   * Role sessions get what applies to their own folder: the orchestrator, outside any
   * project, only user-level entries.
   */
  slashCommands(sessionId: string): SlashCommand[] {
    const { session, gitRoot, files } = this.discover(sessionId);
    const custom =
      session.provider === "claude"
        ? loadedClaudeCommands(this.deps.home, session.cwd, gitRoot)
        : [];
    const skills = files.skills.filter((s) => s.enabled).map(skillCommand);
    return mergeSlashCommands(
      [...skills, ...custom],
      this.deps.reportedCommands(sessionId),
      session.provider,
    );
  }

  // ------------------------------------------------------------------- helpers

  /**
   * A session's working folder, project and the native files its provider loads there, with
   * each skill's switch state for that folder.
   */
  private discover(sessionId: string) {
    const session = this.deps.repo.get(sessionId);
    const project = session.projectId ? this.project(session.projectId) : null;
    const gitRoot = findGitRoot(session.cwd);
    const home = this.deps.home;
    const found: LoadedFiles =
      session.provider === "codex"
        ? loadedCodex(home, session.cwd, gitRoot, project)
        : session.provider === "claude"
          ? loadedClaude(home, session.cwd, gitRoot, project)
          : { memory: [], skills: [], subagents: [] };
    const skills = this.skills.forSession(found.skills, session.cwd, gitRoot, session.projectId);
    return { session, project, gitRoot, files: { ...found, skills } };
  }

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

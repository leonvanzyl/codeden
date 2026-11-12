import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import {
  type McpServerConfig,
  type Project,
  type Session,
  SessionOptions,
  type UserInput,
  type WorkspaceRequest,
} from "@codeden/contracts";
import { codedenSystemPrompt, MCP_SERVER_NAME } from "../../mcp/prompt";
import type { McpTokenStore } from "../../mcp/tokens";
import { errorMessage, ServiceError } from "../errors";
import type { InboxService } from "../inbox-service";
import type { ProjectService } from "../projects/project-service";
import { type RunnerPort, runnerErrorCode } from "../runner-port";
import { slugWords } from "./conflicts";
import type { ForkStart } from "./fork";
import { ownBranch } from "./own-branch";
import type { SessionRepo } from "./repo";
import { setupFailureNote, withSetupNote } from "./setup-failure";

export interface LauncherDeps {
  repo: SessionRepo;
  projects: ProjectService;
  runner: RunnerPort;
  inbox: InboxService;
  /** `<home>/wt`: worktrees live in `wt/<project>/<session>` (§6). */
  worktreesDir: string;
  /** `<home>/orchestrator`: the orchestrator's working directory (§8.1). */
  orchestratorDir: string;
  /** Issues the per-session MCP token handed to the agent (§8.3). */
  tokens: McpTokenStore;
  log?: (message: string) => void;
  /** How long to wait for the runner before failing a start. */
  connectTimeoutMs?: number;
}

/**
 * A fork's start (§9): its worktree branches from the source's branch (`WorkspaceRequest.baseRef`),
 * then gets the source's latest checkpoint as uncommitted changes; its pull request still
 * targets the source's base branch.
 */
export interface LaunchFork {
  /** The branch the fork's pull request targets (the source's base branch). */
  baseBranch: string | null;
  /** The source's latest checkpoint; omitted when it has none yet. */
  restoreCheckpoint?: { sessionId: string; index: number };
}

/** What a start needs: the first input, the workspace to prepare and, for a fork, its plan. */
export interface LaunchOptions {
  input?: UserInput;
  workspace: WorkspaceRequest;
  fork?: LaunchFork;
}

interface PreparedWorkspace {
  cwd: string;
  worktreePath: string | null;
  branch: string | null;
  baseBranch: string | null;
  /** Why the requested workspace could not be used, when CodeDen fell back. */
  fallback: string | null;
  /** A failed setup command, told to the agent with its first input. */
  setupNote: string | null;
}

const PREPARE_TIMEOUT_MS = 10 * 60_000;
const START_TIMEOUT_MS = 60_000;

/**
 * Starts sessions on the runner: prepares the workspace (`workspace.prepare`), then opens the
 * provider session (`session.start`). Failures mark the session failed and raise a
 * `run_failed` inbox item instead of throwing, since starts run in the background.
 */
export class SessionLauncher {
  constructor(private readonly deps: LauncherDeps) {}

  /** Start a new session in the background: failures mark it failed (see `start`). */
  async launch(sessionId: string, opts: LaunchOptions): Promise<void> {
    try {
      await this.start(sessionId, opts);
    } catch (error) {
      this.fail(sessionId, "start", error);
    }
  }

  /**
   * Prepare the session's workspace, record it on the session, then open the provider session.
   * Throws on failure; nothing reaches the provider when the workspace could not be prepared.
   */
  private async start(sessionId: string, opts: LaunchOptions): Promise<void> {
    const { repo, runner } = this.deps;
    const session = repo.get(sessionId);
    await this.requireRunner();
    const project = session.projectId ? this.deps.projects.get(session.projectId) : null;
    const ws = await this.prepareWorkspace(session, project, opts.workspace, opts.fork);
    repo.update(sessionId, (s) => ({
      ...s,
      cwd: ws.cwd,
      worktreePath: ws.worktreePath,
      branch: ws.branch,
      baseBranch: ws.baseBranch,
    }));
    if (ws.fallback) {
      const fallback = ws.fallback;
      repo.setStartMeta(sessionId, (m) => ({
        ...defaultMeta(opts.workspace),
        ...m,
        workspaceFallback: fallback,
      }));
    }
    const result = await runner.request(
      {
        name: "session.start",
        sessionId,
        providerId: session.provider,
        options: this.sessionOptions({
          ...session,
          cwd: ws.cwd,
          worktreePath: ws.worktreePath,
          branch: ws.branch,
          baseBranch: ws.baseBranch,
        }),
        input: withSetupNote(opts.input, ws.setupNote),
      },
      START_TIMEOUT_MS,
    );
    repo.update(sessionId, (s) => ({
      ...s,
      resumeToken: s.resumeToken ?? result.resumeToken,
      runnerId: runner.runnerId(),
      status: s.status === "starting" ? (opts.input ? "running" : "idle") : s.status,
    }));
  }

  /**
   * Re-open a session the runner no longer hosts (runner restart, stopped session) through the
   * provider's resume token, optionally starting a turn. Throws on failure. A fork whose
   * worktree was never made (its first start failed) gets it made now, as at its first start:
   * it never runs anywhere else.
   */
  async resume(session: Session, input?: UserInput): Promise<void> {
    const forkStart = this.pendingForkStart(session);
    if (forkStart) {
      await this.start(session.id, { ...forkStart, ...(input ? { input } : {}) });
      return;
    }
    await this.requireRunner();
    const { session: current, setupNote } = await this.restoreWorktree(session);
    const result = await this.deps.runner.request(
      {
        name: "session.start",
        sessionId: current.id,
        providerId: current.provider,
        options: this.sessionOptions(current),
        input: withSetupNote(input, setupNote),
      },
      START_TIMEOUT_MS,
    );
    this.deps.repo.update(session.id, (s) => ({
      ...s,
      resumeToken: result.resumeToken ?? s.resumeToken,
      runnerId: this.deps.runner.runnerId(),
    }));
  }

  /**
   * Recreate a worktree that cleanup removed (§9), at the same path from the session's branch,
   * running the project's setup again. A no-op for sessions that still have their worktree.
   */
  async restoreWorktree(session: Session): Promise<{ session: Session; setupNote: string | null }> {
    if (!session.worktreeRemovedAt || !session.worktreePath || !session.projectId) {
      return { session, setupNote: null };
    }
    const project = this.deps.projects.get(session.projectId);
    const result = await this.deps.runner.request(
      {
        name: "workspace.prepare",
        sessionId: session.id,
        repoPath: project.path,
        strategy: "worktree",
        path: session.worktreePath,
        branch: session.branch ?? undefined,
        baseRef: session.baseBranch ?? project.defaultBranch ?? undefined,
        setupCommands: [],
      },
      PREPARE_TIMEOUT_MS,
    );
    this.deps.log?.(`session ${session.id}: recreated worktree ${result.cwd}`);
    const updated = this.deps.repo.update(session.id, (s) => ({
      ...s,
      cwd: result.cwd,
      worktreePath: result.cwd,
      branch: result.branch ?? s.branch,
      worktreeRemovedAt: null,
    }));
    return { session: updated, setupNote: setupFailureNote(result.setup) };
  }

  /** Mark a session failed with an inbox item explaining why. */
  fail(sessionId: string, key: string, error: unknown): void {
    const message = errorMessage(error);
    this.deps.log?.(`session ${sessionId}: ${message}`);
    const found = this.deps.repo.find(sessionId);
    if (!found) return;
    const session = this.deps.repo.update(sessionId, (s) =>
      s.status === "stopped" ? s : { ...s, status: "failed" },
    );
    this.deps.inbox.raiseRunFailed(session, key, message);
  }

  /**
   * Provider options for a start or resume: model, effort, autonomy, plan mode, cwd, the
   * CodeDen system prompt, and CodeDen's MCP server through the runner's local proxy with a
   * freshly minted session token (minting revokes the previous one). A session still planning
   * reopens in plan mode; one whose plan was approved reopens at its permission level.
   */
  sessionOptions(session: Session): SessionOptions {
    const proxyUrl = this.deps.runner.mcpProxyUrl();
    const mcpServers: McpServerConfig[] = [];
    if (proxyUrl) {
      const token = this.deps.tokens.mint({
        role: session.role,
        sessionId: session.id,
        projectId: session.projectId,
      });
      mcpServers.push({
        transport: "http",
        name: MCP_SERVER_NAME,
        url: proxyUrl,
        headers: { Authorization: `Bearer ${token}` },
        toolTimeoutSec: 600,
        trusted: true,
      });
    }
    return SessionOptions.parse({
      sessionId: session.id,
      role: session.role,
      cwd: session.cwd,
      model: session.model ?? undefined,
      effort: session.effort ?? undefined,
      autonomy: session.autonomy,
      planMode: session.planMode ?? false,
      resumeToken: session.resumeToken ?? undefined,
      systemPrompt: codedenSystemPrompt(session, this.projectOf(session)),
      // The orchestrator and PMs never write project code (§11.2). Agent sessions at the
      // `read_only` level carry it in `autonomy`, so it can change live.
      readOnly: session.role !== "agent",
      mcpServers,
      ...(ownBranch(session) ? { ownBranch: ownBranch(session) } : {}),
    });
  }

  /** A fork's workspace plan while its worktree doesn't exist yet (`ForkStart`). */
  private pendingForkStart(session: Session): ForkStart | null {
    if (session.worktreePath) return null;
    return this.deps.repo.find(session.id)?.startMeta?.forkStart ?? null;
  }

  /** The session's project for its system prompt; null without one (or once it is gone). */
  private projectOf(session: Session): Project | null {
    if (!session.projectId) return null;
    try {
      return this.deps.projects.get(session.projectId);
    } catch {
      return null;
    }
  }

  private async requireRunner(): Promise<void> {
    const ok = await this.deps.runner.waitForConnection(this.deps.connectTimeoutMs ?? 15_000);
    if (!ok) throw new ServiceError(503, "runner_unavailable", "The runner is not connected");
  }

  private async prepareWorkspace(
    session: Session,
    project: Project | null,
    req: WorkspaceRequest,
    fork?: LaunchFork,
  ): Promise<PreparedWorkspace> {
    if (!project) {
      mkdirSync(this.deps.orchestratorDir, { recursive: true });
      return plain(this.deps.orchestratorDir);
    }
    if (req.mode === "repo_root") return plain(project.path);
    if (req.mode === "existing") {
      if (!req.path || !existsSync(req.path)) {
        throw new ServiceError(400, "workspace_missing", `Folder not found: ${req.path ?? ""}`);
      }
    }
    const path =
      req.mode === "existing"
        ? (req.path as string)
        : join(this.deps.worktreesDir, project.slug, session.id.slice(0, 8));
    const branch =
      req.branch ??
      (req.mode === "worktree"
        ? `codeden/${slugWords(session.title ?? session.purpose, 5, 40)}-${session.id.slice(0, 4)}`
        : undefined);
    const baseRef = req.baseRef ?? project.defaultBranch ?? undefined;
    // A new worktree of a GitHub project starts from the freshly fetched default branch when the
    // local one is merely behind (§9); the pull request still targets the default branch.
    const fetch =
      req.fetch ?? (project.kind === "github" && req.mode === "worktree" && !req.baseRef);
    try {
      const result = await this.deps.runner.request(
        {
          name: "workspace.prepare",
          sessionId: session.id,
          repoPath: project.path,
          strategy: req.mode,
          path,
          branch,
          baseRef,
          setupCommands: req.setupCommands ?? [],
          ...(fetch ? { fetch: true } : {}),
          ...(fork?.restoreCheckpoint ? { restoreCheckpoint: fork.restoreCheckpoint } : {}),
        },
        PREPARE_TIMEOUT_MS,
      );
      return {
        cwd: result.cwd,
        worktreePath: req.mode === "worktree" ? result.cwd : null,
        branch: result.branch,
        baseBranch: fork ? fork.baseBranch : (baseRef ?? null),
        fallback: null,
        setupNote: setupFailureNote(result.setup),
      };
    } catch (error) {
      // A fork needs its own worktree (the source's code); it never falls back to the root.
      if (fork || runnerErrorCode(error) !== "not_implemented") throw error;
      if (req.mode === "existing") return plain(path);
      return {
        ...plain(project.path),
        fallback: "This runner cannot create worktrees yet; the session runs in the repo root.",
      };
    }
  }
}

function plain(cwd: string): PreparedWorkspace {
  return {
    cwd,
    worktreePath: null,
    branch: null,
    baseBranch: null,
    fallback: null,
    setupNote: null,
  };
}

function defaultMeta(workspace: WorkspaceRequest) {
  return { workspaceMode: workspace.mode, workspaceFallback: null, forced: null, queuedBehind: [] };
}

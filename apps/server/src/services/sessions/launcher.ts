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
import type { GitBroker } from "../git-broker";
import type { InboxService } from "../inbox-service";
import type { ProjectService } from "../projects/project-service";
import {
  clonesWorkspaces,
  type RunnerDeps,
  type RunnerPort,
  runnerErrorCode,
  runnerForSession,
  runnerUnavailable,
} from "../runner-port";
import { type PreparedWorkspace, prepareCloneWorkspace } from "./clone-workspace";
import { slugWords } from "./conflicts";
import type { ForkStart } from "./fork";
import { withHandoffBrief } from "./handoff";
import { ownBranch } from "./own-branch";
import type { SessionRepo } from "./repo";
import { setupFailureNote, withSetupNote } from "./setup-failure";

export interface LauncherDeps extends RunnerDeps {
  repo: SessionRepo;
  projects: ProjectService;
  inbox: InboxService;
  /**
   * CodeDen's data directory (§6), sent with every session so the agent's policy guards the
   * credential files in it (`SessionOptions.codedenHome`, §15).
   */
  home: string;
  /** `<home>/wt`: worktrees live in `wt/<project>/<session>` (§6). */
  worktreesDir: string;
  /** `<home>/orchestrator`: the orchestrator's working directory (§8.1). */
  orchestratorDir: string;
  /** Issues the per-session MCP token handed to the agent (§8.3). */
  tokens: McpTokenStore;
  log?: (message: string) => void;
  /** How long to wait for the runner before failing a start. */
  connectTimeoutMs?: number;
  /** Clone URLs and brokered credentials for runners that don't share this disk (§9). */
  git?: GitBroker;
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

const PREPARE_TIMEOUT_MS = 10 * 60_000;
const START_TIMEOUT_MS = 60_000;
/**
 * `session.start` refusals after which no provider process of the session runs on the runner:
 * it was neither hosted nor being opened (those answer `session_exists`), and this open failed.
 */
const NOTHING_RUNS = new Set(["open_failed", "unknown_provider"]);

/**
 * Starts sessions on their runner (the one in `sessions.runnerId`, else the home runner):
 * prepares the workspace (`workspace.prepare`), then opens the provider session
 * (`session.start`). Failures mark the session failed and raise a `run_failed` inbox item
 * instead of throwing, since starts run in the background.
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
    const { repo } = this.deps;
    const session = repo.get(sessionId);
    const runner = runnerForSession(this.deps, sessionId);
    await this.requireRunner(runner);
    const project = session.projectId ? this.deps.projects.get(session.projectId) : null;
    const ws = await this.prepareWorkspace(runner, session, project, opts.workspace, opts.fork);
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
    const brief = this.pendingBrief(sessionId);
    const input = brief ? withHandoffBrief(brief, opts.input) : opts.input;
    const result = await this.open(
      runner,
      {
        ...session,
        cwd: ws.cwd,
        worktreePath: ws.worktreePath,
        branch: ws.branch,
        baseBranch: ws.baseBranch,
      },
      withSetupNote(input, ws.setupNote),
    );
    if (brief) this.briefDelivered(sessionId);
    repo.update(sessionId, (s) => ({
      ...s,
      resumeToken: s.resumeToken ?? result.resumeToken,
      runnerId: runner.runnerId() ?? s.runnerId,
      status: s.status === "starting" ? (input ? "running" : "idle") : s.status,
    }));
  }

  /**
   * Re-open a session the runner no longer hosts (runner restart, stopped session) through the
   * provider's resume token, optionally starting a turn. Throws on failure. A fork whose
   * worktree was never made (its first start failed) gets it made now, as at its first start:
   * it never runs anywhere else. A handoff whose brief no start delivered yet (§9) sends it now,
   * ahead of `input`.
   */
  async resume(session: Session, input?: UserInput): Promise<void> {
    const forkStart = this.pendingForkStart(session);
    if (forkStart) {
      await this.start(session.id, { ...forkStart, ...(input ? { input } : {}) });
      return;
    }
    const runner = runnerForSession(this.deps, session.id);
    await this.requireRunner(runner);
    const { session: current, setupNote } = await this.restoreWorktree(session);
    const brief = this.pendingBrief(session.id);
    const first = brief ? withHandoffBrief(brief, input) : input;
    const result = await this.open(runner, current, withSetupNote(first, setupNote));
    if (brief) this.briefDelivered(session.id);
    this.deps.repo.update(session.id, (s) => ({
      ...s,
      resumeToken: result.resumeToken ?? s.resumeToken,
      runnerId: runner.runnerId() ?? s.runnerId,
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
    const result = await runnerForSession(this.deps, session.id).request(
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
   * Open the provider session on the runner (`session.start`) with a freshly minted MCP token,
   * then retire the tokens no running process holds (§8.3). Started: the session's other
   * tokens (their processes are gone). Refused because the session already runs or is being
   * opened (`session_exists`, a second resume racing the first after a restart): only the new
   * token, since that process holds an earlier one. Could not be opened: all of them, nothing
   * runs. Any other failure (a timeout, a lost connection, an error once the process ran)
   * retires nothing: a process may hold the new token or an earlier one; the next open or the
   * session's end retires them.
   */
  private async open(runner: RunnerPort, session: Session, input: UserInput | undefined) {
    const token = runner.mcpProxyUrl()
      ? this.deps.tokens.mint({
          role: session.role,
          sessionId: session.id,
          projectId: session.projectId,
        })
      : null;
    this.markVendorHistory(runner, session);
    try {
      const result = await runner.request(
        {
          name: "session.start",
          sessionId: session.id,
          providerId: session.provider,
          options: this.sessionOptions(session, token),
          input,
        },
        START_TIMEOUT_MS,
      );
      if (token) this.deps.tokens.revokeSession(session.id, token);
      return result;
    } catch (error) {
      const code = runnerErrorCode(error);
      if (token && code === "session_exists") this.deps.tokens.revoke(token);
      if (token && NOTHING_RUNS.has(code ?? "")) this.deps.tokens.revokeSession(session.id);
      throw error;
    }
  }

  /**
   * Mark a session whose provider hides its conversations from its own apps as it goes
   * (`StoredStartMeta.vendorHistory`): from now on the runner-start sweep covers it.
   */
  private markVendorHistory(runner: RunnerPort, session: Session): void {
    const provider = runner.providers().find((p) => p.id === session.provider);
    if (!provider?.capabilities.vendorHistory) return;
    const meta = this.deps.repo.find(session.id)?.startMeta;
    if (!meta || meta.vendorHistory) return;
    this.deps.repo.setStartMeta(session.id, (m) => ({ ...(m ?? meta), vendorHistory: true }));
  }

  /**
   * Provider options for a start or resume: model, effort, autonomy, plan mode, cwd, the
   * CodeDen system prompt, and, given the session's MCP token, CodeDen's MCP server through the
   * runner's local proxy. A session still planning reopens in plan mode; one whose plan was
   * approved reopens at its permission level. A project that turned off `CI=true` for its
   * agents (`agentCiEnv`) sends `ciEnv: false`.
   */
  sessionOptions(session: Session, mcpToken: string | null = null): SessionOptions {
    const project = this.projectOf(session);
    const proxyUrl = runnerForSession(this.deps, session.id).mcpProxyUrl();
    const mcpServers: McpServerConfig[] = [];
    if (proxyUrl && mcpToken) {
      mcpServers.push({
        transport: "http",
        name: MCP_SERVER_NAME,
        url: proxyUrl,
        headers: { Authorization: `Bearer ${mcpToken}` },
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
      systemPrompt: codedenSystemPrompt(session, project),
      // The orchestrator and PMs never write project code (§11.2). Agent sessions at the
      // `read_only` level carry it in `autonomy`, so it can change live.
      readOnly: session.role !== "agent",
      codedenHome: this.deps.home,
      mcpServers,
      ...(ownBranch(session) ? { ownBranch: ownBranch(session) } : {}),
      ...(project?.agentCiEnv === false ? { ciEnv: false } : {}),
    });
  }

  /** A fork's workspace plan while its worktree doesn't exist yet (`ForkStart`). */
  private pendingForkStart(session: Session): ForkStart | null {
    if (session.worktreePath) return null;
    return this.deps.repo.find(session.id)?.startMeta?.forkStart ?? null;
  }

  /**
   * A handoff's brief that no start has delivered yet (§9). A session that has had a turn got
   * it already (a start that timed out after the runner took it), so it is dropped then.
   */
  private pendingBrief(sessionId: string): UserInput | null {
    const brief = this.deps.repo.find(sessionId)?.startMeta?.handoffBrief ?? null;
    if (brief && this.deps.repo.turnCount(sessionId) > 0) {
      this.briefDelivered(sessionId);
      return null;
    }
    return brief;
  }

  /** The brief reached the provider: later starts are plain resumes. */
  private briefDelivered(sessionId: string): void {
    this.deps.repo.setStartMeta(sessionId, (m) => ({
      ...(m ?? defaultMeta({ mode: "worktree" })),
      handoffBrief: null,
    }));
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

  private async requireRunner(runner: RunnerPort): Promise<void> {
    const ok = await runner.waitForConnection(this.deps.connectTimeoutMs ?? 15_000);
    if (!ok) throw runnerUnavailable(runner);
  }

  private async prepareWorkspace(
    runner: RunnerPort,
    session: Session,
    project: Project | null,
    req: WorkspaceRequest,
    fork?: LaunchFork,
  ): Promise<PreparedWorkspace> {
    if (!project) {
      mkdirSync(this.deps.orchestratorDir, { recursive: true });
      return plain(this.deps.orchestratorDir);
    }
    // A sandbox's runner works in its own clone, at a path it chooses (§9.1).
    if (clonesWorkspaces(runner)) {
      return prepareCloneWorkspace(this.deps.git, runner, session, project, req, {
        fork: fork !== undefined,
        timeoutMs: PREPARE_TIMEOUT_MS,
      });
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
      const result = await runner.request(
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

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
import type { SandboxService } from "../../execution/sandboxes";
import { codedenSystemPrompt, MCP_SERVER_NAME } from "../../mcp/prompt";
import type { McpTokenStore } from "../../mcp/tokens";
import type { ArtifactService } from "../artifacts";
import { errorMessage, ServiceError } from "../errors";
import type { GitBroker } from "../git-broker";
import type { InboxService } from "../inbox-service";
import type { ProjectGroupService } from "../projects/group-service";
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
import { withSetupNote } from "./setup-failure";
import { seenSetups, settleSetup } from "./setup-gate";
import { setUnanswered, unansweredCode } from "./unanswered-start";

export interface LauncherDeps extends RunnerDeps {
  repo: SessionRepo;
  projects: ProjectService;
  /**
   * The project's group, for the system prompt and the skills an agent session gets from it
   * (`SessionOptions.sharedSkills`, DESIGN.md "Project groups"). Absent: no group features.
   */
  groups?: Pick<ProjectGroupService, "groupOf" | "sharedSkillsFor">;
  inbox: InboxService;
  /**
   * CodeDen's data directory (§6), sent with every session so the agent's policy guards the
   * credential files in it (`SessionOptions.codedenHome`, §15).
   */
  home: string;
  /**
   * Where each session's artifacts live: its folder is sent with it, so the agent may read its
   * own screenshots without asking (`SessionOptions.artifactsDir`, §11.2).
   */
  artifacts?: Pick<ArtifactService, "sessionDir">;
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
  /** Sandboxes for projects whose sessions run in containers (`docs/remote-runners.md` §8). */
  sandboxes?: Pick<SandboxService, "wants" | "place" | "release">;
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

  /**
   * Start a new session in the background: failures mark it failed (see `start`). A start the
   * runner didn't answer is recorded as such (`unanswered-start.ts`): the session may still open.
   */
  async launch(sessionId: string, opts: LaunchOptions): Promise<void> {
    try {
      await this.start(sessionId, opts);
    } catch (error) {
      const code = unansweredCode(error);
      if (code) setUnanswered(this.deps.repo, sessionId, { code, at: new Date().toISOString() });
      this.fail(sessionId, "start", error);
    }
  }

  /**
   * Start a session: in a project whose sessions run in containers, it gets its own first
   * (`docs/remote-runners.md` §8). A start that fails after that removes the container again
   * and forgets it, so the next message starts over in a new one rather than anywhere else.
   */
  private async start(sessionId: string, opts: LaunchOptions): Promise<void> {
    this.keepWorkspaceStart(sessionId, opts);
    const session = this.deps.repo.get(sessionId);
    const project = session.projectId ? this.deps.projects.get(session.projectId) : null;
    const sandboxes = this.deps.sandboxes;
    if (!project || !sandboxes?.wants(session, project, { fork: opts.fork !== undefined })) {
      return this.startOn(session, project, opts);
    }
    const home = this.deps.runner.providers().find((p) => p.id === session.provider);
    const runnerId = await sandboxes.place(session, project, home);
    const placed = this.deps.repo.update(sessionId, (s) => ({ ...s, runnerId }));
    try {
      await this.startOn(placed, project, opts);
    } catch (error) {
      await sandboxes.release(this.deps.repo.get(sessionId), { force: true }).catch(() => null);
      this.deps.repo.update(sessionId, (s) => ({ ...s, runnerId: null }));
      throw error;
    }
  }

  /**
   * Prepare the session's workspace on its runner, record it on the session, then open the
   * provider session. Throws on failure; nothing reaches the provider when the workspace could
   * not be prepared.
   */
  private async startOn(session: Session, project: Project | null, opts: LaunchOptions) {
    const { repo } = this.deps;
    const sessionId = session.id;
    const runner = runnerForSession(this.deps, sessionId);
    await this.requireRunner(runner);
    const ws = await this.prepareWorkspace(runner, session, project, opts.workspace, opts.fork);
    repo.update(sessionId, (s) => ({
      ...s,
      cwd: ws.cwd,
      worktreePath: ws.worktreePath,
      branch: ws.branch,
      baseBranch: ws.baseBranch,
    }));
    // Prepared: later starts open the session where it now is.
    repo.setStartMeta(sessionId, (m) => ({
      ...defaultMeta(opts.workspace),
      ...m,
      workspaceStart: null,
      ...(ws.fallback ? { workspaceFallback: ws.fallback } : {}),
    }));
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
   * provider's resume token, optionally starting a turn. Throws on failure. A session whose
   * workspace was never prepared (its first start failed) gets it prepared now, as at its first
   * start: a fork its worktree, any other session the workspace it asked for. It never runs in
   * the project folder in its place. A handoff whose brief no start delivered yet (§9) sends it
   * now, ahead of `input`.
   */
  async resume(session: Session, input?: UserInput): Promise<void> {
    const unprepared = this.pendingForkStart(session) ?? this.pendingWorkspaceStart(session);
    if (unprepared) {
      await this.start(session.id, { ...unprepared, ...(input ? { input } : {}) });
      return;
    }
    // A container session whose start failed has none: it gets one now, never runs elsewhere.
    const project = session.projectId ? this.deps.projects.get(session.projectId) : null;
    if (project && this.deps.sandboxes?.wants(session, project)) {
      await this.start(session.id, {
        workspace: { mode: "worktree" },
        ...(input ? { input } : {}),
      });
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
    const runner = runnerForSession(this.deps, session.id);
    const result = await runner.request(
      {
        name: "workspace.prepare",
        sessionId: session.id,
        repoPath: project.path,
        strategy: "worktree",
        path: session.worktreePath,
        branch: session.branch ?? undefined,
        baseRef: session.baseBranch ?? project.defaultBranch ?? undefined,
        setupCommands: [],
        seenSetups: seenSetups(project),
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
    return {
      session: updated,
      setupNote: await settleSetup(this.gate(runner), updated, project, result),
    };
  }

  /** What settles setup the runner held (`setup-gate.ts`). */
  private gate(runner: RunnerPort) {
    return { inbox: this.deps.inbox, runner, timeoutMs: PREPARE_TIMEOUT_MS };
  }

  /**
   * Mark a session failed with an inbox item explaining why. A provider that refused to open it
   * (`open_failed`) was reported by the runner first, as the process crash that raised the item
   * (or updated the session's open one), so no second item is raised for the same failure.
   */
  fail(sessionId: string, key: string, error: unknown): void {
    const message = errorMessage(error);
    this.deps.log?.(`session ${sessionId}: ${message}`);
    const found = this.deps.repo.find(sessionId);
    if (!found) return;
    const session = this.deps.repo.update(sessionId, (s) =>
      s.status === "stopped" ? s : { ...s, status: "failed" },
    );
    if (runnerErrorCode(error) === "open_failed") return;
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
   *
   * A start the runner answered too late, though a turn of the session already started meanwhile
   * (its events came first), did open it: it counts as opened, with the resume token its events
   * carry, rather than failing a session that is working.
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
    const turnsBefore = this.deps.repo.turnCount(session.id);
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
      setUnanswered(this.deps.repo, session.id, null);
      return result;
    } catch (error) {
      const code = runnerErrorCode(error);
      if (token && code === "session_exists") this.deps.tokens.revoke(token);
      if (token && NOTHING_RUNS.has(code ?? "")) this.deps.tokens.revokeSession(session.id);
      if (unansweredCode(error) && this.deps.repo.turnCount(session.id) > turnsBefore) {
        this.deps.log?.(`session ${session.id}: ${errorMessage(error)}, but its turn started`);
        setUnanswered(this.deps.repo, session.id, null);
        return { resumeToken: null };
      }
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
      systemPrompt: codedenSystemPrompt(
        session,
        project,
        this.deps.groups?.groupOf(project?.id ?? null) ?? null,
      ),
      // The orchestrator and PMs never write project code (§11.2). Agent sessions at the
      // `read_only` level carry it in `autonomy`, so it can change live.
      readOnly: session.role !== "agent",
      codedenHome: this.deps.home,
      artifactsDir: this.deps.artifacts?.sessionDir(session.id),
      mcpServers,
      ...this.sharedSkills(session, project),
      ...(ownBranch(session) ? { ownBranch: ownBranch(session) } : {}),
      ...(project?.agentCiEnv === false ? { ciEnv: false } : {}),
    });
  }

  /**
   * The group's skills for an agent session in a workspace of its own (a worktree, or a
   * sandbox's clone): the runner writes them there and removes the ones the group no longer has,
   * so a project that left its group gets none on the next open. A session in the project's own
   * checkout (or a PM) gets none: CodeDen never adds files to the user's folder.
   */
  private sharedSkills(session: Session, project: Project | null) {
    if (!this.deps.groups || session.role !== "agent") return {};
    const ownWorkspace =
      session.worktreePath !== null || clonesWorkspaces(runnerForSession(this.deps, session.id));
    if (!ownWorkspace) return {};
    return { sharedSkills: this.deps.groups.sharedSkillsFor(project?.id ?? null) };
  }

  /** A fork's workspace plan while its worktree doesn't exist yet (`ForkStart`). */
  private pendingForkStart(session: Session): ForkStart | null {
    if (session.worktreePath) return null;
    return this.deps.repo.find(session.id)?.startMeta?.forkStart ?? null;
  }

  /** The workspace a start asked for while it isn't prepared yet (`workspaceStart`). */
  private pendingWorkspaceStart(session: Session): { workspace: WorkspaceRequest } | null {
    const workspace = this.deps.repo.find(session.id)?.startMeta?.workspaceStart;
    return workspace ? { workspace } : null;
  }

  /**
   * Keep the workspace this start asks for until it is prepared (`workspaceStart`), before
   * anything can fail. A fork keeps its own plan (`forkStart`).
   */
  private keepWorkspaceStart(sessionId: string, opts: LaunchOptions): void {
    if (opts.fork) return;
    this.deps.repo.setStartMeta(sessionId, (m) => ({
      ...defaultMeta(opts.workspace),
      ...m,
      workspaceStart: opts.workspace,
    }));
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
        gate: this.gate(runner),
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
          seenSetups: seenSetups(project),
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
        setupNote: await settleSetup(this.gate(runner), session, project, result),
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

import { randomUUID } from "node:crypto";
import type {
  AutonomyLevel,
  ForkSessionRequest,
  ForkSessionResponse,
  JsonValue,
  ProviderInfo,
  QueueSender,
  RespondRequest,
  SendMessageRequest,
  SendMessageResponse,
  Session,
  SessionDetail,
  StartSessionRequest,
  StartSessionResponse,
  UpdateSessionRequest,
  UserInput,
} from "@codeden/contracts";
import type { SettingsStore } from "../../settings-store";
import type { ArtifactService } from "../artifacts";
import { badRequest, conflict, ServiceError } from "../errors";
import type { InboxService } from "../inbox-service";
import { projectDefaultProvider } from "../projects/project-config";
import type { ProjectService } from "../projects/project-service";
import { type RunnerPort, runnerErrorCode, toServiceError } from "../runner-port";
import { derivePurpose, deriveWorkKey, findConflicts } from "./conflicts";
import { planFork } from "./fork";
import type { InputDecorator } from "./input-decorator";
import type { LaunchFork, SessionLauncher } from "./launcher";
import type { Outbox } from "./outbox";
import { isTransientRunnerError, OutboxHolds } from "./outbox-holds";
import { planModeUnsupported, readOnlyUnsupported } from "./permissions";
import type { Answerer, QuestionBroker } from "./questions";
import { applyPendingConfig, updateSession } from "./reconfigure";
import type { SessionRepo, StoredStartMeta } from "./repo";

export interface SessionServiceDeps {
  repo: SessionRepo;
  projects: ProjectService;
  runner: RunnerPort;
  inbox: InboxService;
  artifacts: ArtifactService;
  settings: SettingsStore;
  launcher: SessionLauncher;
  outbox: Outbox;
  questions: QuestionBroker;
  /** Wait before retrying a queued message the runner could not take (default 30 s). */
  outboxRetryMs?: number;
}

/** Preferred providers when the choice is `auto` (first ready one wins). */
const AUTO_ORDER = ["claude", "codex"];

const BUSY = new Set(["running", "waiting"]);
const NOT_STARTED = new Set(["created", "queued", "starting"]);
/** Statuses in which the next queued message is delivered. */
const FLUSHABLE = new Set(["idle", "interrupted", "failed"]);

/**
 * Agent sessions: start (with the §8.4 conflict check), messages, steering, interrupts,
 * approvals and stop. Starts return immediately; the runner work happens in the background
 * and shows up through the event stream.
 */
export class SessionService {
  /** Background launches, so tests and shutdown can await them. */
  readonly launching = new Map<string, Promise<void>>();
  /** Rewrites a turn's input at send time (the orchestration status digest, §8.4). */
  private inputDecorator: InputDecorator | undefined;
  private readonly holds: OutboxHolds;

  constructor(private readonly deps: SessionServiceDeps) {
    this.holds = new OutboxHolds({
      retryMs: deps.outboxRetryMs,
      onRetry: (id) => void this.flushOutbox(id).catch(() => undefined),
    });
  }

  setInputDecorator(fn: InputDecorator): void {
    this.inputDecorator = fn;
  }

  /**
   * Model and effort (applied on the next turn), autonomy and plan mode (pushed to the runner)
   * or title.
   */
  update(id: string, req: UpdateSessionRequest): Promise<Session> {
    if (req.autonomy === "read_only" || req.planMode !== undefined) {
      const session = this.deps.repo.get(id);
      if (req.autonomy === "read_only") {
        this.assertReadOnlySupported(session.role, session.provider, req.autonomy);
      }
      if (req.planMode !== undefined) this.assertPlanModeSupported(session.role, session.provider);
    }
    return updateSession(this.deps.repo, this.deps.runner, id, req);
  }

  /** Reject the `read_only` level on a provider that cannot enforce it (§11.2). */
  private assertReadOnlySupported(role: Session["role"], providerId: string, level: AutonomyLevel) {
    const problem = readOnlyUnsupported(role, level, this.provider(providerId));
    if (problem) throw badRequest(problem, "read_only_unsupported");
  }

  /** Reject plan mode for role sessions and on providers without `capabilities.planMode`. */
  private assertPlanModeSupported(role: Session["role"], providerId: string) {
    const problem = planModeUnsupported(role, this.provider(providerId));
    if (problem) throw badRequest(problem, "plan_mode_unsupported");
  }

  detail(id: string): SessionDetail {
    const found = this.deps.repo.find(id);
    if (!found) this.missing(id);
    return {
      session: found.session,
      usage: found.usage,
      followups: this.deps.repo.latestFollowups(found.session),
      startMeta: this.deps.repo.publicStartMeta(found.startMeta),
      queuedMessages: this.deps.outbox.count(id),
    };
  }

  async start(req: StartSessionRequest): Promise<StartSessionResponse> {
    const { repo, projects } = this.deps;
    const project = req.projectId ? projects.get(req.projectId) : null;
    if (project?.archivedAt) throw badRequest("The project is archived", "project_archived");
    if (!project && req.role !== "orchestrator") {
      throw badRequest("projectId is required for this role", "project_required");
    }
    const purpose = derivePurpose(req.purpose, req.input?.text);
    const workKey = deriveWorkKey({
      workKey: req.workKey,
      issueNumber: req.issue?.number,
      purpose,
    });
    const scope = { projectId: req.projectId, ...req.scope };

    const conflicts = findConflicts({ workKey, scope }, repo.activeWork(req.projectId));
    let queuedBehind: string[] = [];
    let forced: StoredStartMeta["forced"] = null;
    if (conflicts.length > 0) {
      const decision = req.conflict;
      if (!decision) return { status: "conflict", existing: conflicts };
      switch (decision.resolution) {
        case "skip":
          return { status: "skipped" };
        case "join": {
          const target = repo.get(decision.sessionId);
          if (target.projectId !== req.projectId) {
            throw badRequest("Can only join a session in the same project", "join_mismatch");
          }
          if (req.input) {
            await this.send(target.id, { input: req.input, whenBusy: "queue" }, req.startedBy.kind);
          }
          return { status: "joined", sessionId: target.id };
        }
        case "wait":
          queuedBehind = decision.behindId ? [decision.behindId] : conflicts.map((c) => c.id);
          break;
        case "force":
          forced = { reason: decision.reason, conflictsWith: conflicts.map((c) => c.id) };
          break;
      }
    }

    const session = this.buildSession(req, project, {
      purpose,
      workKey,
      scope,
      queued: queuedBehind.length > 0,
    });
    const meta: StoredStartMeta = {
      workspaceMode: req.workspace.mode,
      workspaceFallback: null,
      forced,
      queuedBehind,
      pending: queuedBehind.length > 0 ? { input: req.input, workspace: req.workspace } : null,
    };
    repo.create(session, meta);
    if (queuedBehind.length > 0) {
      return { status: "queued", sessionId: session.id, behind: queuedBehind };
    }
    this.launchInBackground(session.id, req.input, req.workspace);
    return { status: "started", sessionId: session.id };
  }

  /**
   * Fork an agent session (§9): a new session with a copy of its conversation, in a new
   * worktree started from its latest checkpoint (`fork.ts`). The worktree is made in the
   * background.
   */
  async fork(id: string, req: ForkSessionRequest): Promise<ForkSessionResponse> {
    const { repo, projects, runner } = this.deps;
    const plan = await planFork({ repo, projects, runner }, id, req);
    repo.create(plan.session, plan.meta);
    this.launchInBackground(plan.session.id, undefined, plan.start.workspace, plan.start.fork);
    return { sessionId: plan.session.id };
  }

  /** Start a queued session whose blockers finished (called by the queue). */
  startQueued(session: Session): void {
    const meta = this.deps.repo.find(session.id)?.startMeta;
    const pending = meta?.pending ?? { workspace: { mode: "worktree" as const } };
    this.deps.repo.setStartMeta(session.id, (m) => ({
      ...(m ?? meta ?? fallbackMeta()),
      pending: null,
    }));
    this.deps.repo.update(session.id, (s) =>
      s.status === "queued" ? { ...s, status: "starting" } : s,
    );
    this.launchInBackground(session.id, pending.input, pending.workspace);
  }

  /** Send now, steer or queue (`whenBusy`); `from` labels the message if it is queued. */
  async send(
    id: string,
    req: SendMessageRequest,
    from: QueueSender = "user",
  ): Promise<SendMessageResponse> {
    const session = this.deps.repo.get(id);
    if (NOT_STARTED.has(session.status)) return this.enqueue(id, req.input, from);
    if (BUSY.has(session.status)) {
      if (req.whenBusy === "reject") throw conflict("A turn is running", "turn_running");
      if (req.whenBusy === "steer") {
        await this.steer(id, req.input);
        return { status: "steered" };
      }
      return this.enqueue(id, req.input, from);
    }
    try {
      await this.sendNow(session, req.input, from);
    } catch (error) {
      // CodeDen's own roles never lose a message to a runner restart: it waits in the queue.
      // The user sees the error instead; a wake (`reject`) is retried by its scheduler.
      if (from === "user" || req.whenBusy === "reject" || !isTransientRunnerError(error)) {
        throw error;
      }
      this.holds.hold(id, true);
      return this.enqueue(id, req.input, from);
    }
    this.holds.release(id);
    return { status: "sent" };
  }

  async steer(id: string, raw: UserInput): Promise<void> {
    const session = this.deps.repo.get(id);
    if (!BUSY.has(session.status)) throw conflict("No turn is running", "no_turn");
    if (!this.provider(session.provider)?.capabilities.steer) {
      throw conflict("This provider cannot steer a running turn", "unsupported");
    }
    const input = this.forRunner(session, raw);
    await this.deps.runner.request({ name: "session.steer", sessionId: id, input }).catch((e) => {
      throw toServiceError(e);
    });
  }

  async interrupt(id: string): Promise<void> {
    this.deps.repo.get(id);
    this.deps.outbox.clear(id);
    await this.deps.runner.request({ name: "session.interrupt", sessionId: id }).catch((e) => {
      throw toServiceError(e);
    });
  }

  /** Answer a question or approval; `by` is who answered a question (the user or the PM). */
  async respond(id: string, req: RespondRequest, by: Answerer = "user"): Promise<void> {
    this.deps.repo.get(id);
    // Questions asked through CodeDen's ask_user tool are answered here, not by the provider.
    if (await this.deps.questions.respond(id, req.requestId, req.response, by)) return;
    await this.deps.runner
      .request({
        name: "session.respond",
        sessionId: id,
        requestId: req.requestId,
        response: req.response,
      })
      .catch((e) => {
        throw toServiceError(e);
      });
    const resolution: JsonValue =
      req.response.kind === "approval"
        ? { decision: req.response.decision, decidedBy: req.response.decidedBy ?? "user" }
        : req.response.kind === "answer"
          ? { answers: req.response.answers, decidedBy: by }
          : { status: "cancelled" };
    this.deps.inbox.closeForRequest(id, req.requestId, resolution);
  }

  async stop(id: string): Promise<Session> {
    const session = this.deps.repo.get(id);
    this.deps.outbox.clear(id);
    this.holds.release(id);
    if (session.status !== "queued" && session.status !== "created") {
      try {
        await this.deps.runner.request({ name: "session.stop", sessionId: id }, 15_000);
      } catch (error) {
        const code = runnerErrorCode(error);
        if (code !== "unknown_session" && code !== "runner_unavailable")
          throw toServiceError(error);
      }
    }
    this.deps.inbox.dismissRequestsForSession(id, "session stopped");
    return this.deps.repo.update(id, (s) =>
      s.status === "stopped" ? s : { ...s, status: "stopped", endedAt: new Date().toISOString() },
    );
  }

  /**
   * Send the next queued message once no turn is running (idle, or after a failed or
   * interrupted turn). If delivery fails the message goes back in its place and delivery
   * pauses (`OutboxHolds`); only an error that is not a runner restart fails the session.
   */
  async flushOutbox(id: string): Promise<void> {
    if (this.holds.isHeld(id)) return;
    const next = this.deps.outbox.peek(id);
    if (!next) return;
    const session = this.deps.repo.get(id);
    if (!FLUSHABLE.has(session.status)) return;
    this.deps.outbox.remove(next, "sent");
    try {
      await this.sendNow(session, next.input, next.from);
    } catch (error) {
      const transient = isTransientRunnerError(error);
      this.holds.hold(id, transient);
      this.deps.outbox.restore(next);
      if (!transient && session.status !== "failed") {
        this.deps.launcher.fail(id, `send-${Date.now()}`, error);
      }
    }
  }

  /** The runner is ready again: retry every paused delivery (§4.2). */
  releaseOutboxes(): void {
    this.holds.releaseAll();
  }

  /**
   * Re-open a session whose turn was cut off by a runner restart and tell the agent to carry
   * on (§4.2). Resumes through the provider's resume token.
   */
  async continueAfterRestart(id: string, text: string): Promise<void> {
    const session = this.deps.repo.get(id);
    await this.sendNow(session, { text, attachments: [], from: "codeden" }, "codeden");
  }

  sessionsWithQueuedMessages(): string[] {
    return this.deps.outbox.sessionsWithMessages();
  }

  hasOutbox(id: string): boolean {
    return this.deps.outbox.count(id) > 0;
  }

  // ---------------------------------------------------------------- internals

  private async sendNow(session: Session, raw: UserInput, from: QueueSender): Promise<void> {
    const decorated = this.inputDecorator?.(session, raw, from) ?? { input: raw };
    try {
      await this.deliver(session, this.forRunner(session, decorated.input));
    } catch (error) {
      decorated.failed?.();
      throw error;
    }
    decorated.delivered?.();
  }

  /** Hand a turn's input to the runner, resuming the session when it no longer hosts it. */
  private async deliver(session: Session, input: UserInput): Promise<void> {
    await applyPendingConfig(this.deps.repo, this.deps.runner, session);
    const previous = session.status;
    // Messaging an archived session brings it back.
    this.deps.repo.update(session.id, (s) => ({
      ...s,
      status: "running",
      endedAt: null,
      archivedAt: null,
    }));
    try {
      if (session.worktreeRemovedAt) {
        // Cleanup removed the worktree (§9): recreate it, then resume through the provider.
        await this.deps.launcher.resume(this.deps.repo.get(session.id), input);
        return;
      }
      try {
        await this.deps.runner.request({ name: "session.send", sessionId: session.id, input });
      } catch (error) {
        // The runner no longer hosts it (restart, stopped): resume through the provider.
        if (runnerErrorCode(error) !== "unknown_session") throw error;
        await this.deps.launcher.resume(this.deps.repo.get(session.id), input);
      }
    } catch (error) {
      this.deps.repo.update(session.id, (s) =>
        s.status === "running" ? { ...s, status: previous } : s,
      );
      throw toServiceError(error);
    }
  }

  private enqueue(id: string, input: UserInput, from: QueueSender): SendMessageResponse {
    const session = this.deps.repo.get(id);
    this.deps.outbox.push(id, this.externalize(session, input), from);
    return { status: "queued" };
  }

  /** Pasted images saved as artifacts: the form CodeDen stores (queued messages). */
  private externalize(session: Session, input: UserInput): UserInput {
    return this.deps.artifacts.externalizeAttachments(input, {
      sessionId: session.id,
      projectId: session.projectId,
    });
  }

  /** Input handed to the runner: artifacts resolved to the file paths providers read. */
  private forRunner(session: Session, input: UserInput): UserInput {
    return this.deps.artifacts.resolveAttachments(this.externalize(session, input));
  }

  private launchInBackground(
    id: string,
    input: UserInput | undefined,
    workspace: StartSessionRequest["workspace"],
    fork?: LaunchFork,
  ) {
    const session = this.deps.repo.get(id);
    const prepared = input ? this.forRunner(session, input) : undefined;
    const promise = this.deps.launcher
      .launch(id, { input: prepared, workspace, ...(fork ? { fork } : {}) })
      .finally(() => this.launching.delete(id));
    this.launching.set(id, promise);
  }

  private provider(id: string): ProviderInfo | undefined {
    return this.deps.runner.providers().find((p) => p.id === id);
  }

  private resolveProvider(req: StartSessionRequest, projectDefault: string | null): string {
    const available = this.deps.runner.providers().map((p) => p.id);
    const connected = this.deps.runner.isConnected();
    if (req.provider && req.provider !== "auto") {
      if (connected && !available.includes(req.provider)) {
        throw badRequest(`Provider ${req.provider} is not available`, "unknown_provider");
      }
      return req.provider;
    }
    const roleDefault = this.deps.settings.get().providers[req.role].provider;
    for (const choice of [projectDefault, roleDefault === "auto" ? null : roleDefault]) {
      if (choice && (!connected || available.includes(choice))) return choice;
    }
    const auto = [...AUTO_ORDER, ...available].find((id) => available.includes(id));
    return auto ?? "claude";
  }

  private buildSession(
    req: StartSessionRequest,
    project: ReturnType<ProjectService["get"]> | null,
    work: { purpose: string; workKey: string; scope: Session["scope"]; queued: boolean },
  ): Session {
    const settings = this.deps.settings.get();
    const roleDefaults = settings.providers[req.role];
    const now = new Date().toISOString();
    const provider = this.resolveProvider(req, project ? projectDefaultProvider(project) : null);
    const autonomy = req.autonomy ?? project?.autonomy ?? settings.autonomy.default;
    this.assertReadOnlySupported(req.role, provider, autonomy);
    // Either value is refused where plan mode doesn't exist, as for PATCH.
    if (req.planMode !== undefined) this.assertPlanModeSupported(req.role, provider);
    return {
      id: randomUUID(),
      projectId: req.projectId,
      role: req.role,
      parentSessionId: req.parentSessionId ?? null,
      startedBy: req.startedBy,
      purpose: work.purpose,
      workKey: work.workKey,
      scope: work.scope,
      progress: null,
      title: req.title ?? null,
      provider,
      model: req.model ?? roleDefaults.model,
      effort: req.effort ?? roleDefaults.effort,
      autonomy,
      planMode: req.planMode ?? false,
      status: work.queued ? "queued" : "starting",
      cwd: project?.path ?? ".",
      worktreePath: null,
      branch: null,
      baseBranch: null,
      issue: req.issue ?? null,
      pr: null,
      resumeToken: null,
      runnerId: null,
      automationRunId: null,
      rootThreadId: null,
      createdAt: now,
      updatedAt: now,
      endedAt: null,
    };
  }

  private missing(id: string): never {
    throw new ServiceError(404, "session_not_found", `No session ${id}`);
  }
}

function fallbackMeta(): StoredStartMeta {
  return { workspaceMode: "worktree", workspaceFallback: null, forced: null, queuedBehind: [] };
}

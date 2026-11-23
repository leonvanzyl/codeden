import { randomUUID } from "node:crypto";
import type {
  AutonomyLevel,
  CompactSessionResponse,
  ForkSessionRequest,
  ForkSessionResponse,
  HandoffSessionRequest,
  HandoffSessionResponse,
  JsonValue,
  ProviderInfo,
  QueuedMessage,
  QueueSender,
  RespondRequest,
  ReviewSessionRequest,
  ReviewSessionResponse,
  RoleDefaults,
  SendMessageRequest,
  SendMessageResponse,
  Session,
  SessionDetail,
  StartSessionRequest,
  StartSessionResponse,
  UpdateSessionRequest,
  UserInput,
  WorkspaceRequest,
} from "@codeden/contracts";
import type { SandboxService } from "../../execution/sandboxes";
import type { McpTokenStore } from "../../mcp/tokens";
import type { SettingsStore } from "../../settings-store";
import type { ArtifactService } from "../artifacts";
import { badRequest, conflict, ServiceError } from "../errors";
import type { InboxService } from "../inbox-service";
import { projectDefaultProvider } from "../projects/project-config";
import type { ProjectService } from "../projects/project-service";
import type { ProjectRedetector } from "../projects/redetector";
import {
  type RunnerDeps,
  type RunnerPort,
  runnerErrorCode,
  runnerForSession,
  toServiceError,
} from "../runner-port";
import type { UtilityService } from "../utility";
import { freezeChecks, roundAfter, withRound } from "./checks";
import { compactingRefusal, compactionRunning, compactRefusal, startCompaction } from "./compact";
import { derivePurpose, deriveWorkKey, findConflicts } from "./conflicts";
import { planFork } from "./fork";
import { planHandoff } from "./handoff";
import type { InputDecorator } from "./input-decorator";
import type { LaunchFork, SessionLauncher } from "./launcher";
import type { Outbox } from "./outbox";
import { isTransientRunnerError, isTurnRunningError, OutboxHolds } from "./outbox-holds";
import { planModeUnsupported, readOnlyUnsupported } from "./permissions";
import { autoOrder } from "./provider-order";
import type { Answerer, QuestionBroker } from "./questions";
import { applyPendingConfig, updateSession } from "./reconfigure";
import type { SessionRepo, StoredStartMeta } from "./repo";
import { planReview } from "./review";
import { startWorkspace } from "./start-workspace";

export interface SessionServiceDeps extends RunnerDeps {
  repo: SessionRepo;
  projects: ProjectService;
  inbox: InboxService;
  artifacts: ArtifactService;
  settings: SettingsStore;
  launcher: SessionLauncher;
  outbox: Outbox;
  questions: QuestionBroker;
  /** Revokes a stopped session's MCP tokens. */
  tokens: Pick<McpTokenStore, "revokeSession">;
  /** Writes the summary in a handoff's brief (§7.4); without it the brief quotes the last reply. */
  utility?: Pick<UtilityService, "handoffSummary">;
  /** Wait before retrying a queued message the runner could not take (default 30 s). */
  outboxRetryMs?: number;
  /** Refuses starts a project's sandboxes can't host (`docs/remote-runners.md` §8). */
  sandboxes?: Pick<SandboxService, "assertStartable" | "wants">;
  /**
   * Brings a project's record up to date with its folder (`isGitRepo`) when the start-up check
   * hasn't reached it yet (#425). Without it, starts trust the record as it is.
   */
  projectChecks?: Pick<ProjectRedetector, "current">;
}

/** What the session service needs from the checks loop (`ChecksLoop`). */
export interface CheckRuns {
  /** End the session's check run; true when one was running. */
  cancel(sessionId: string, outcome: "stopped" | "superseded"): Promise<boolean>;
  /** Whether checks are running for the session now. */
  isRunning(sessionId: string): boolean;
}

const BUSY = new Set(["running", "waiting"]);
const NOT_STARTED = new Set(["created", "queued", "starting"]);
/** Statuses in which the next queued message is delivered. */
const FLUSHABLE = new Set(["idle", "interrupted", "failed"]);
/** Final outcomes a stop never rewrites: the session's status keeps saying what happened. */
const FINISHED = new Set(["completed", "failed", "stopped"]);

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
  private checkRuns: CheckRuns | undefined;
  private readonly holds: OutboxHolds;
  /**
   * Sessions with a turn on its way to the runner (between the status check and the runner's
   * answer). Another message for one of them waits in the queue instead of racing it into a
   * second turn.
   */
  private readonly delivering = new Set<string>();

  constructor(private readonly deps: SessionServiceDeps) {
    this.holds = new OutboxHolds({
      retryMs: deps.outboxRetryMs,
      onRetry: (id) => void this.flushOutbox(id).catch(() => undefined),
    });
  }

  setInputDecorator(fn: InputDecorator): void {
    this.inputDecorator = fn;
  }

  /** The checks loop (§9 Project checks): Stop and new messages end a check run. */
  setCheckRuns(runs: CheckRuns): void {
    this.checkRuns = runs;
  }

  /**
   * Model and effort (applied on the next turn), autonomy and plan mode (pushed to the runner)
   * or title.
   */
  update(id: string, req: UpdateSessionRequest): Promise<Session> {
    if (req.untilChecksPass !== undefined || req.checkRounds !== undefined) {
      const session = this.deps.repo.get(id);
      if (session.role !== "agent" || !session.checks?.commands.length) {
        throw badRequest(
          "This session has no project checks: add `checks` to .codeden/project.json and start a new session",
          "no_checks",
        );
      }
    }
    if (req.autonomy === "read_only" || req.planMode !== undefined) {
      const session = this.deps.repo.get(id);
      if (req.autonomy === "read_only") {
        this.assertReadOnlySupported(session.role, session.provider, req.autonomy, id);
      }
      if (req.planMode !== undefined) {
        this.assertPlanModeSupported(session.role, session.provider, id);
      }
    }
    return updateSession(this.deps.repo, this.runnerOf(id), id, req);
  }

  /**
   * Reject the `read_only` level on a provider that cannot enforce it (§11.2), as loaded by the
   * session's runner (the home runner for a session not made yet).
   */
  private assertReadOnlySupported(
    role: Session["role"],
    providerId: string,
    level: AutonomyLevel,
    sessionId?: string,
  ) {
    const problem = readOnlyUnsupported(role, level, this.provider(providerId, sessionId));
    if (problem) throw badRequest(problem, "read_only_unsupported");
  }

  /** Reject plan mode for role sessions and on providers without `capabilities.planMode`. */
  private assertPlanModeSupported(role: Session["role"], providerId: string, sessionId?: string) {
    const problem = planModeUnsupported(role, this.provider(providerId, sessionId));
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
    // The workspace follows `isGitRepo`: read it once the folder has been checked since start.
    if (req.projectId) await this.deps.projectChecks?.current(req.projectId);
    const project = req.projectId ? projects.get(req.projectId) : null;
    if (project?.archivedAt) throw badRequest("The project is archived", "project_archived");
    if (!project && req.role !== "orchestrator") {
      throw badRequest("projectId is required for this role", "project_required");
    }
    // Refused before the conflict check: a worktree that can't be made is never queued either.
    const workspace = startWorkspace(req.workspace, project);
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

    const queued = queuedBehind.length > 0;
    const session = this.buildSession(req, project, { purpose, workKey, scope, queued });
    const meta: StoredStartMeta = {
      workspaceMode: workspace.mode,
      workspaceFallback: null,
      forced,
      queuedBehind,
      // A pending start keeps its pasted images as artifacts, like a queued message.
      pending: queued
        ? { input: req.input && this.externalize(session, req.input), workspace }
        : null,
      // What a role session is compared with when its role's provider setting changes.
      ...(req.role !== "agent" && {
        roleProvider: this.deps.settings.get().providers[req.role].provider,
      }),
    };
    repo.create(session, meta);
    if (queued) {
      return { status: "queued", sessionId: session.id, behind: queuedBehind };
    }
    this.launchInBackground(session.id, req.input, workspace);
    return { status: "started", sessionId: session.id };
  }

  /**
   * Fork an agent session (§9): a new session with a copy of its conversation, in a new
   * worktree started from its latest checkpoint, or from a named turn's ("Fork from here",
   * `fork.ts`). The worktree is made in the background.
   */
  async fork(id: string, req: ForkSessionRequest): Promise<ForkSessionResponse> {
    const { repo, projects } = this.deps;
    await this.sourceProjectChecked(id);
    const plan = await planFork({ repo, projects, runner: this.runnerOf(id) }, id, req);
    repo.create(plan.session, plan.meta);
    this.launchInBackground(plan.session.id, undefined, plan.start.workspace, plan.start.fork);
    return { sessionId: plan.session.id };
  }

  /**
   * Hand an agent session off (§9): a new session, on any provider, with its code as a fork has
   * it and a brief of its work as the first message, which starts a turn (`handoff.ts`). The
   * worktree is made in the background. The brief is kept with the start metadata, and the
   * launcher sends it with whichever start opens the session, so a failed first start keeps it.
   */
  async handoff(id: string, req: HandoffSessionRequest): Promise<HandoffSessionResponse> {
    const { repo, projects, utility } = this.deps;
    await this.sourceProjectChecked(id);
    const plan = await planHandoff({ repo, projects, runner: this.runnerOf(id), utility }, id, req);
    repo.create(plan.session, plan.meta);
    this.launchInBackground(plan.session.id, undefined, plan.start.workspace, plan.start.fork);
    return { sessionId: plan.session.id };
  }

  /**
   * Review an agent session's changes (§9): a new read-only session, on any provider that
   * enforces read-only, with its code as a handoff has it and a review brief as the first
   * message, which starts a turn (`review.ts`). The worktree is made in the background, and the
   * launcher delivers the brief as it does a handoff's.
   */
  async review(id: string, req: ReviewSessionRequest): Promise<ReviewSessionResponse> {
    const { repo, projects } = this.deps;
    await this.sourceProjectChecked(id);
    const plan = await planReview({ repo, projects, runner: this.runnerOf(id) }, id, req);
    repo.create(plan.session, plan.meta);
    this.launchInBackground(plan.session.id, undefined, plan.start.workspace, plan.start.fork);
    return { sessionId: plan.session.id };
  }

  /** Fork, handoff and review refuse a project that isn't a git repository: check it first. */
  private async sourceProjectChecked(sessionId: string): Promise<void> {
    const projectId = this.deps.repo.find(sessionId)?.session.projectId;
    if (projectId) await this.deps.projectChecks?.current(projectId);
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
    // A turn on its way to the runner counts as running, though there is nothing to steer yet.
    const delivering = this.delivering.has(id);
    if (BUSY.has(session.status) || delivering) {
      if (req.whenBusy === "reject") throw conflict("A turn is running", "turn_running");
      if (req.whenBusy === "steer" && !delivering) {
        try {
          await this.steer(id, req.input);
          return { status: "steered" };
        } catch (error) {
          // A compaction can't be steered: the message goes once it ends.
          if (runnerErrorCode(error) !== "compacting") throw error;
        }
      }
      return this.enqueue(id, req.input, from);
    }
    // Its place in the queue, should it end up there: ahead of messages that arrive meanwhile.
    const place = this.deps.outbox.reserve();
    try {
      await this.sendNow(session, req.input, from);
    } catch (error) {
      // The provider is still running a turn the server had not seen: the message waits for it.
      if (isTurnRunningError(error)) {
        if (req.whenBusy === "reject") throw conflict("A turn is running", "turn_running");
        const queued = this.enqueue(id, req.input, from, place);
        this.flushIfSettled(id);
        return queued;
      }
      // CodeDen's own roles never lose a message to a runner restart: it waits in the queue.
      // The user sees the error instead; a wake (`reject`) is retried by its scheduler.
      if (from === "user" || req.whenBusy === "reject" || !isTransientRunnerError(error)) {
        throw error;
      }
      this.holds.hold(id, true);
      return this.enqueue(id, req.input, from, place);
    }
    this.holds.release(id);
    return { status: "sent" };
  }

  async steer(id: string, raw: UserInput): Promise<void> {
    const session = this.deps.repo.get(id);
    if (!BUSY.has(session.status)) throw conflict("No turn is running", "no_turn");
    if (!this.provider(session.provider, id)?.capabilities.steer) {
      throw conflict("This provider cannot steer a running turn", "unsupported");
    }
    if (compactionRunning(this.deps.repo, session)) throw compactingRefusal();
    const input = this.forRunner(session, raw);
    await this.runnerOf(id)
      .request({ name: "session.steer", sessionId: id, input })
      .catch((e) => {
        throw toServiceError(e);
      });
  }

  async interrupt(id: string): Promise<void> {
    this.deps.repo.get(id);
    this.deps.outbox.clear(id);
    // Between turns, Stop ends the session's check run: no turn is running to interrupt.
    if (await this.checkRuns?.cancel(id, "stopped")) return;
    await this.runnerOf(id)
      .request({ name: "session.interrupt", sessionId: id })
      .catch((e) => {
        throw toServiceError(e);
      });
  }

  /**
   * "Compact now" (`./compact`): the provider compacts the conversation as a turn of its own.
   * Refused while a turn runs, checks run or messages wait, on providers without
   * `capabilities.compact`, and for sessions with no conversation yet or archived. Messages sent
   * meanwhile queue behind it.
   */
  async compact(id: string): Promise<CompactSessionResponse> {
    const session = this.deps.repo.get(id);
    const refusal = compactRefusal(session, this.provider(session.provider, id), {
      delivering: this.delivering.has(id),
      queued: this.deps.outbox.count(id),
      checking: this.checkRuns?.isRunning(id) ?? false,
    });
    if (refusal) throw refusal;
    this.delivering.add(id);
    try {
      await startCompaction(
        { repo: this.deps.repo, launcher: this.deps.launcher, runnerOf: (s) => this.runnerOf(s) },
        session,
      );
    } finally {
      this.delivering.delete(id);
      // Messages that arrived meanwhile go once the compaction is over (or didn't start).
      if (this.deps.outbox.count(id) > 0) this.flushIfSettled(id);
    }
    return { status: "compacting" };
  }

  /** Answer a question or approval; `by` is who answered a question (the user or the PM). */
  async respond(id: string, req: RespondRequest, by: Answerer = "user"): Promise<void> {
    this.deps.repo.get(id);
    // Questions asked through CodeDen's ask_user tool are answered here, not by the provider.
    if (await this.deps.questions.respond(id, req.requestId, req.response, by)) return;
    await this.runnerOf(id)
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

  /**
   * Stop a session: drop its queued messages, end its provider process, revoke its MCP tokens
   * and dismiss its open questions. A session that already finished (completed, failed) keeps
   * its status.
   */
  async stop(id: string): Promise<Session> {
    const session = this.deps.repo.get(id);
    this.deps.outbox.clear(id);
    this.holds.release(id);
    if (session.status !== "queued" && session.status !== "created") {
      try {
        await this.runnerOf(id).request({ name: "session.stop", sessionId: id }, 15_000);
      } catch (error) {
        const code = runnerErrorCode(error);
        if (code !== "unknown_session" && code !== "runner_unavailable")
          throw toServiceError(error);
      }
    }
    // The provider process is gone, so its tokens go too (§8.3), whatever status the session
    // keeps: a failed session isn't revoked by the lifecycle. Resuming mints a new token.
    this.deps.tokens.revokeSession(id);
    this.deps.inbox.dismissRequestsForSession(id, "session stopped");
    return this.deps.repo.update(id, (s) =>
      FINISHED.has(s.status) ? s : { ...s, status: "stopped", endedAt: new Date().toISOString() },
    );
  }

  /**
   * Stop a session whose queued messages move on to another session (a role moved to another
   * provider, `RoleSessions`): they are returned instead of dropped. They leave the queue
   * before anything is awaited, so no delivery can send one to the session being stopped; if
   * the stop fails they go back in their places.
   */
  async stopKeepingQueue(id: string): Promise<QueuedMessage[]> {
    const taken = this.deps.outbox.clear(id);
    try {
      await this.stop(id);
    } catch (error) {
      this.restoreQueued(taken);
      throw error;
    }
    // Whatever was queued while the runner stopped it.
    return [...taken, ...this.deps.outbox.clear(id)];
  }

  /** Put messages taken with `stopKeepingQueue` back in their session's queue, in their places. */
  restoreQueued(messages: QueuedMessage[]): void {
    for (const message of messages) this.deps.outbox.restore(message);
  }

  /**
   * Queue messages taken from another session (`stopKeepingQueue`) for this one, in their
   * order and each with its sender. They are delivered like any queued message.
   */
  adoptQueued(id: string, messages: QueuedMessage[]): void {
    for (const message of messages) this.deps.outbox.push(id, message.input, message.from);
    if (messages.length > 0) this.flushIfSettled(id);
  }

  /**
   * Send the next queued message once no turn is running (idle, or after a failed or
   * interrupted turn). If delivery fails the message goes back in its place and delivery
   * pauses (`OutboxHolds`); only an error that is not a runner restart fails the session. A
   * turn still running on the runner is no error: the message waits for its end.
   */
  async flushOutbox(id: string): Promise<void> {
    if (this.holds.isHeld(id) || this.delivering.has(id)) return;
    const next = this.deps.outbox.peek(id);
    if (!next) return;
    const session = this.deps.repo.get(id);
    if (!FLUSHABLE.has(session.status)) return;
    this.deps.outbox.remove(next, "sent");
    try {
      await this.sendNow(session, next.input, next.from);
    } catch (error) {
      if (isTurnRunningError(error)) {
        this.deps.outbox.restore(next);
        this.flushIfSettled(id);
        return;
      }
      const transient = isTransientRunnerError(error);
      this.holds.hold(id, transient);
      this.deps.outbox.restore(next);
      if (!transient && session.status !== "failed") {
        this.deps.launcher.fail(id, `send-${Date.now()}`, error);
      }
    }
  }

  /** A runner is ready again: retry the paused deliveries of its sessions (§4.2). */
  releaseOutboxes(which?: (sessionId: string) => boolean): void {
    this.holds.releaseAll(which);
  }

  /** A turn is on its way to the runner for this session (sent, the runner hasn't answered). */
  isDelivering(id: string): boolean {
    return this.delivering.has(id);
  }

  /**
   * Re-open a session whose turn was cut off by a runner restart and tell the agent to carry
   * on (§4.2). Resumes through the provider's resume token. A message already on its way
   * re-opens it (a PM or the factory wrote to it first), so nothing is sent: a second resume
   * would open the conversation twice.
   */
  async continueAfterRestart(id: string, text: string): Promise<void> {
    if (this.delivering.has(id)) return;
    const session = this.deps.repo.get(id);
    await this.sendNow(session, { text, attachments: [], from: "codeden" }, "codeden");
  }

  sessionsWithQueuedMessages(): string[] {
    return this.deps.outbox.sessionsWithMessages();
  }

  hasOutbox(id: string): boolean {
    return this.deps.outbox.count(id) > 0;
  }

  /**
   * Drop a session's queued messages from one sender (the factory withdrawing requests that no
   * longer apply). A message already taken out for delivery is gone from the queue and stays sent.
   * Returns how many were dropped.
   */
  dropQueued(id: string, from: QueueSender): number {
    const mine = this.deps.outbox.list(id).filter((m) => m.from === from);
    for (const m of mine) this.deps.outbox.remove(m, "dropped");
    return mine.length;
  }

  // ---------------------------------------------------------------- internals

  /**
   * Start a turn. Marks the session `delivering` before anything is awaited; messages queued
   * meanwhile are delivered once it is settled again (`flushIfSettled`).
   */
  private async sendNow(session: Session, raw: UserInput, from: QueueSender): Promise<void> {
    this.delivering.add(session.id);
    try {
      // A new message takes over from a check run; the loop's own message comes after its run.
      await this.checkRuns?.cancel(session.id, "superseded");
      this.countChecksRound(session.id, raw, from);
      const decorated = this.inputDecorator?.(session, raw, from) ?? { input: raw };
      try {
        await this.deliver(session, this.forRunner(session, decorated.input));
      } catch (error) {
        decorated.failed?.(error);
        throw error;
      }
      decorated.delivered?.();
    } finally {
      this.delivering.delete(session.id);
      // The turn may have ended before the runner's answer: the flush its end triggered found
      // this delivery in flight and skipped, so nothing else would send what queued up.
      if (this.deps.outbox.count(session.id) > 0) this.flushIfSettled(session.id);
    }
  }

  /** The checks loop's round count follows a message on its way to the session (`roundAfter`). */
  private countChecksRound(id: string, input: UserInput, from: QueueSender): void {
    const round = roundAfter(input, from);
    if (round === undefined) return;
    this.deps.repo.update(id, (s) => {
      const checks = s.checks && withRound(s.checks, round);
      return checks && checks !== s.checks ? { ...s, checks } : s;
    });
  }

  /**
   * Deliver the queue on the next tick if no turn is running: after a delivery (its turn may
   * already be over) or a refusal because a turn was running (that turn may have ended before
   * the refusal was handled). Otherwise the end of the turn delivers it (`SessionLifecycle`).
   * It runs after the caller's error handling, so a delivery pause (`OutboxHolds`) set there
   * still applies.
   */
  private flushIfSettled(id: string): void {
    const status = this.deps.repo.find(id)?.session.status;
    if (!status || !FLUSHABLE.has(status)) return;
    setImmediate(() => void this.flushOutbox(id).catch(() => undefined));
  }

  /** Hand a turn's input to the runner, resuming the session when it no longer hosts it. */
  private async deliver(session: Session, input: UserInput): Promise<void> {
    const runner = this.runnerOf(session.id);
    await applyPendingConfig(this.deps.repo, runner, session);
    const previous = session.status;
    // Messaging an archived session brings it back.
    this.deps.repo.update(session.id, (s) => ({
      ...s,
      status: "running",
      endedAt: null,
      archivedAt: null,
    }));
    try {
      // Cleanup removed the worktree (§9), or a container session's start failed and took its
      // container with it: make it again, then resume through the provider.
      if (session.worktreeRemovedAt || this.needsSandbox(session)) {
        await this.deps.launcher.resume(this.deps.repo.get(session.id), input);
        return;
      }
      try {
        await runner.request({ name: "session.send", sessionId: session.id, input });
      } catch (error) {
        // The runner no longer hosts it (restart, stopped): resume through the provider.
        if (runnerErrorCode(error) !== "unknown_session") throw error;
        await this.deps.launcher.resume(this.deps.repo.get(session.id), input);
      }
    } catch (error) {
      // Refused because the provider is running a turn: the session is running, so it stays so
      // and that turn's end delivers what waits. Anything else: back to how it was.
      if (!isTurnRunningError(error)) {
        this.deps.repo.update(session.id, (s) =>
          s.status === "running" ? { ...s, status: previous } : s,
        );
      }
      throw toServiceError(error);
    }
  }

  /** Queue a message; `at` is a place reserved for it earlier (`Outbox.reserve`). */
  private enqueue(
    id: string,
    input: UserInput,
    from: QueueSender,
    at?: string,
  ): SendMessageResponse {
    const session = this.deps.repo.get(id);
    this.deps.outbox.push(id, this.externalize(session, input), from, at);
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
    workspace: WorkspaceRequest,
    fork?: LaunchFork,
  ) {
    const session = this.deps.repo.get(id);
    const prepared = input ? this.forRunner(session, input) : undefined;
    const promise = this.deps.launcher
      .launch(id, { input: prepared, workspace, ...(fork ? { fork } : {}) })
      .finally(() => this.launching.delete(id));
    this.launching.set(id, promise);
  }

  /** A session of a `docker` project that has no container (its start failed). */
  private needsSandbox(session: Session): boolean {
    const sandboxes = this.deps.sandboxes;
    if (!sandboxes || !session.projectId || session.runnerId) return false;
    try {
      return sandboxes.wants(session, this.deps.projects.get(session.projectId));
    } catch {
      return false;
    }
  }

  /** The runner that hosts this session (`sessions.runnerId`, else the home runner). */
  private runnerOf(sessionId: string): RunnerPort {
    return runnerForSession(this.deps, sessionId);
  }

  /** A provider as loaded by the session's runner, or the home runner's without a session. */
  private provider(id: string, sessionId?: string): ProviderInfo | undefined {
    const runner = sessionId ? this.runnerOf(sessionId) : this.deps.runner;
    return runner.providers().find((p) => p.id === id);
  }

  private resolveProvider(req: StartSessionRequest, projectDefault: string | null): string {
    const available = this.deps.runner.providers().map((p) => p.id);
    const connected = this.deps.runner.isConnected();
    if (req.provider && req.provider !== "auto") {
      if (connected && !available.includes(req.provider)) {
        throw badRequest(
          `Provider ${req.provider} is not available. Loaded providers: ${available.join(", ") || "none"}`,
          "unknown_provider",
        );
      }
      return req.provider;
    }
    const configured = this.configuredProvider(req.role, projectDefault);
    if (configured) return configured;
    return autoOrder(available)[0] ?? "claude";
  }

  /**
   * The provider that settings name for a role's new sessions: the project's default, else the
   * role's (`settings.providers.<role>`). Null when both leave it to Auto, or name a provider
   * the connected runner doesn't have.
   */
  configuredProvider(role: Session["role"], projectDefault: string | null): string | null {
    const available = this.deps.runner.providers().map((p) => p.id);
    const connected = this.deps.runner.isConnected();
    const roleDefault = this.deps.settings.get().providers[role].provider;
    for (const choice of [projectDefault, roleDefault === "auto" ? null : roleDefault]) {
      if (choice && (!connected || available.includes(choice))) return choice;
    }
    return null;
  }

  private buildSession(
    req: StartSessionRequest,
    project: ReturnType<ProjectService["get"]> | null,
    work: { purpose: string; workKey: string; scope: Session["scope"]; queued: boolean },
  ): Session {
    const settings = this.deps.settings.get();
    const now = new Date().toISOString();
    const provider = this.resolveProvider(req, project ? projectDefaultProvider(project) : null);
    const defaults = roleModelDefaults(
      settings.providers[req.role],
      provider,
      this.provider(provider),
    );
    const autonomy = req.autonomy ?? project?.autonomy ?? settings.autonomy.default;
    // A `docker` project's sessions run in containers, which no provider credentials reach yet.
    this.deps.sandboxes?.assertStartable(req.role, project, this.provider(provider));
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
      model: req.model ?? defaults.model,
      effort: req.effort ?? defaults.effort,
      autonomy,
      planMode: req.planMode ?? false,
      // Frozen now, from the project's own folder (§9 Project checks).
      checks: freezeChecks(project?.path, req.role, {
        untilPass: req.untilChecksPass,
        maxRounds: req.checkRounds,
      }),
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

/**
 * The model and effort a new session takes from its role's defaults (Settings > Providers):
 * only on the role's own provider, whose model they name. A session on any other provider (a
 * cross-provider reviewer, a fallback builder, a start naming only a provider) gets null, that
 * provider's own default model and effort. The effort is left out where the provider has none.
 */
function roleModelDefaults(
  defaults: RoleDefaults,
  provider: string,
  info: ProviderInfo | undefined,
): Pick<Session, "model" | "effort"> {
  if (defaults.provider !== provider) return { model: null, effort: null };
  // An unknown provider (runner not connected yet) is let through, as for plan mode.
  const hasEffort = info?.capabilities.reasoningEffort ?? true;
  return { model: defaults.model, effort: hasEffort ? defaults.effort : null };
}

function fallbackMeta(): StoredStartMeta {
  return { workspaceMode: "worktree", workspaceFallback: null, forced: null, queuedBehind: [] };
}

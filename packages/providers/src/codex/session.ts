import type {
  AgentEvent,
  AutonomyLevel,
  ReasoningEffort,
  RuntimeResponse,
  SessionOptions,
  UserInput,
} from "@codeden/contracts";
import { type ProviderSession, ProviderSessionError, type SessionConfigChange } from "../adapter";
import { ApprovalBroker } from "../approvals";
import { AsyncQueue } from "../async-queue";
import type { ResolvedCommand } from "../util/exec";
import { interruptWithDeadline } from "../util/interrupt";
import { explicitModel } from "../util/model";
import { handleServerRequest } from "./approvals";
import {
  codexConfigOverrides,
  codexEffort,
  codexPolicy,
  codexSandboxPolicy,
  toCodexInput,
} from "./config";
import { archiveThread } from "./history";
import { CodexEventMapper } from "./mapper";
import { startAppServer } from "./process";
import type { ServerNotification } from "./protocol";
import type { Model, TurnStartParams, TurnStartResponse } from "./protocol/v2";
import type { CodexRpc } from "./rpc";
import { openCodexThread } from "./thread-open";

export interface CodexSessionConfig {
  executable: ResolvedCommand;
  onModels?: (models: Model[]) => void;
  /** Reasoning efforts a model lists (from `model/list`), when known. */
  modelEfforts?: (model: string) => readonly ReasoningEffort[] | undefined;
  interruptTimeoutMs?: number;
}

/** Re-exported for callers that know it from here. */
export { codexEffort };

/**
 * A Codex session over `codex app-server` (§7.2): one app-server process and one thread per
 * session. If the process exits, the next `send()` restarts it and resumes the thread.
 *
 * The Codex apps list every thread in the user's Codex home as the user's own recents, so the
 * thread is archived whenever no turn of it runs: when a turn ends and when the session closes
 * (`./history`). Archiving unloads it, so the next `send()` unarchives and resumes it first. A
 * session whose agent spawned Codex sub-agents is only archived when it closes: unloading the
 * thread could cut off agents a later turn still talks to.
 */
export class CodexSession implements ProviderSession {
  readonly events = new AsyncQueue<AgentEvent>();
  private readonly mapper: CodexEventMapper;
  private readonly broker: ApprovalBroker;
  private rpc: CodexRpc | undefined;
  private starting: Promise<CodexRpc> | undefined;
  private turnPending = false;
  /** Model/effort changes from `configure`, applied on every following turn. */
  private nextTurn: SessionConfigChange = {};
  /** Current autonomy; after `setAutonomy`, every following `turn/start` carries it. */
  private autonomy: AutonomyLevel;
  private autonomyChanged = false;
  private closed = false;
  /** The model the thread started with (the user's Codex config when none was chosen). */
  private threadModel: string | undefined;
  private readonly filePaths = new Map<string, string[]>();
  /** The thread being archived (or archived) on `rpc` after its turn; true once archived. */
  private parked: { rpc: CodexRpc; archived: Promise<boolean> } | undefined;

  constructor(
    private readonly opts: SessionOptions,
    private readonly config: CodexSessionConfig,
  ) {
    const emit = (event: AgentEvent) => {
      const rootTurnEnded =
        (event.type === "turn.completed" ||
          event.type === "turn.failed" ||
          event.type === "turn.interrupted") &&
        event.threadId === this.mapper.rootThreadId;
      if (rootTurnEnded) this.turnPending = false;
      this.events.push(event);
      if (rootTurnEnded) this.park();
    };
    this.mapper = new CodexEventMapper(opts.sessionId, emit, {
      // An agent Stop cancelled before it ran started a turn after all: stop that too.
      stopTurn: (codexThreadId, turnId) => void this.stopSubagentTurn(codexThreadId, turnId),
    });
    this.mapper.codexThreadId = opts.resumeToken;
    this.broker = new ApprovalBroker(emit);
    this.autonomy = opts.autonomy;
  }

  /** Start the app-server and the thread. Called by the adapter before returning the session. */
  async start(): Promise<void> {
    this.events.push({ type: "thread.started", thread: { id: this.mapper.rootThreadId } });
    await this.ensureServer();
  }

  resumeToken(): string | undefined {
    return this.mapper.codexThreadId;
  }

  /** Model/effort applied from the next `turn/start` on (Codex takes both per turn). */
  async configure(change: SessionConfigChange): Promise<void> {
    this.nextTurn = { ...this.nextTurn, ...change };
  }

  /**
   * Autonomy from the next `turn/start` on, as approval-policy and sandbox overrides. A running
   * turn keeps the policy it started with (the app-server fixes it per turn).
   */
  async setAutonomy(level: AutonomyLevel): Promise<void> {
    this.autonomy = level;
    this.autonomyChanged = true;
  }

  async send(input: UserInput): Promise<void> {
    if (this.closed) throw new ProviderSessionError("closed", "Session is closed");
    if (this.turnPending || this.mapper.currentTurnId) {
      throw new ProviderSessionError("turn_running", "A turn is already running");
    }
    this.turnPending = true;
    try {
      const rpc = await this.ensureServer();
      await this.unpark(rpc);
      const model = await this.turnModel(rpc);
      const inUse = model ?? explicitModel(this.opts.model) ?? this.threadModel;
      const effort = codexEffort(
        this.nextTurn.effort !== undefined ? (this.nextTurn.effort ?? undefined) : this.opts.effort,
        inUse ? this.config.modelEfforts?.(inUse) : undefined,
      );
      const clientUserMessageId = this.mapper.clientMessageId(input);
      const res = await rpc.request<TurnStartResponse>("turn/start", {
        threadId: this.threadId(),
        input: toCodexInput(input),
        ...(clientUserMessageId ? { clientUserMessageId } : {}),
        ...(effort ? { effort } : {}),
        ...(model !== undefined ? { model } : {}),
        ...(this.autonomyChanged ? this.policyOverride() : {}),
      });
      this.mapper.beginTurn(res.turn.id);
    } catch (error) {
      this.turnPending = false;
      throw error;
    }
  }

  async steer(input: UserInput): Promise<void> {
    const turnId = this.mapper.currentTurnId;
    if (!turnId || !this.rpc) throw new ProviderSessionError("no_turn", "No turn is running");
    const clientUserMessageId = this.mapper.clientMessageId(input);
    await this.rpc.request("turn/steer", {
      threadId: this.threadId(),
      input: toCodexInput(input),
      expectedTurnId: turnId,
      ...(clientUserMessageId ? { clientUserMessageId } : {}),
    });
  }

  /**
   * Stop the running turn and every sub-agent: Stop means the whole session, so the agents it
   * spawned stop too, also once the session's own turn has ended. Running sub-agent turns are
   * interrupted; agents with no turn yet (a pending spawn) are cancelled, and a turn one of
   * them starts before the session's next turn is interrupted when it starts. Each turn that
   * app-server doesn't end in time (or never answers `turn/interrupt` for) is closed as
   * interrupted anyway; a deadline only closes that same turn, never later work.
   */
  async interrupt(): Promise<void> {
    const rpc = this.rpc;
    if (!rpc) return;
    const turnId = this.mapper.currentTurnId;
    const children = this.mapper.stopSubagents();
    if (!turnId && children.length === 0) return;
    this.broker.cancelAll();
    const stops = children.map((c) => this.stopSubagentTurn(c.codexThreadId, c.turnId));
    if (turnId) {
      stops.push(
        interruptWithDeadline(
          () => rpc.request("turn/interrupt", { threadId: this.threadId(), turnId }),
          this.interruptTimeoutMs(),
          () => {
            if (this.mapper.currentTurnId === turnId)
              this.mapper.endTurn({ type: "interrupted" }, turnId);
          },
        ),
      );
    }
    await Promise.all(stops);
  }

  /** Interrupt one sub-agent turn, closing it at the deadline if it is still that turn. */
  private stopSubagentTurn(codexThreadId: string, turnId: string): Promise<void> {
    const rpc = this.rpc;
    if (!rpc) return Promise.resolve();
    return interruptWithDeadline(
      () => rpc.request("turn/interrupt", { threadId: codexThreadId, turnId }),
      this.interruptTimeoutMs(),
      () => this.mapper.endSubagentTurn(codexThreadId, turnId, { type: "interrupted" }),
    );
  }

  private interruptTimeoutMs(): number {
    return this.config.interruptTimeoutMs ?? 10_000;
  }

  async respond(requestId: string, response: RuntimeResponse): Promise<void> {
    this.broker.respond(requestId, response);
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.broker.cancelAll();
    this.mapper.endAll({ type: "interrupted" });
    this.events.close();
    // Out of the Codex apps' recents until CodeDen resumes it (which unarchives it first).
    const rpc = this.rpc;
    const threadId = this.mapper.codexThreadId;
    if (this.parked) await this.parked.archived;
    else if (rpc && !rpc.isClosed && threadId) await archiveThread(rpc, threadId);
    await rpc?.close();
  }

  // ---------------------------------------------------------------- internals

  /** Session options with the current autonomy (a restarted app-server resumes with it). */
  private currentOptions(): SessionOptions {
    return { ...this.opts, autonomy: this.autonomy };
  }

  /** `turn/start` overrides that carry the current autonomy (§11.2). */
  private policyOverride(): Pick<TurnStartParams, "approvalPolicy" | "sandboxPolicy"> {
    const opts = this.currentOptions();
    return {
      approvalPolicy: codexPolicy(opts.autonomy, opts.readOnly).approvalPolicy,
      sandboxPolicy: codexSandboxPolicy(opts),
    };
  }

  private threadId(): string {
    const id = this.mapper.codexThreadId;
    if (!id) throw new ProviderSessionError("not_started", "Codex thread is not started");
    return id;
  }

  private ensureServer(): Promise<CodexRpc> {
    if (this.rpc && !this.rpc.isClosed) return Promise.resolve(this.rpc);
    this.starting ??= this.boot().finally(() => {
      this.starting = undefined;
    });
    return this.starting;
  }

  /**
   * A root turn ended: archive the thread so the Codex apps don't list it, unless the session is
   * closing (close archives it), app-server is gone, or the agent spawned sub-agents.
   */
  private park(): void {
    const rpc = this.rpc;
    const threadId = this.mapper.codexThreadId;
    if (this.closed || this.parked || !rpc || rpc.isClosed || !threadId) return;
    if (this.mapper.hasSubagents()) return;
    this.parked = { rpc, archived: archiveThread(rpc, threadId) };
  }

  /**
   * Before a turn: wait for an archive still in flight, then open the thread again on `rpc`
   * (unarchive + resume). A restarted app-server already reopened it in `boot`.
   */
  private async unpark(rpc: CodexRpc): Promise<void> {
    const parked = this.parked;
    if (!parked) return;
    this.parked = undefined;
    if (!(await parked.archived) || parked.rpc !== rpc || rpc.isClosed) return;
    await this.openThread(rpc);
  }

  private async boot(): Promise<CodexRpc> {
    const { rpc } = await startAppServer(
      this.config.executable,
      {
        onNotification: (n) => this.onNotification(n),
        onRequest: (req) =>
          handleServerRequest(req, {
            broker: this.broker,
            risk: {
              cwd: this.opts.cwd,
              extraRoots: this.opts.additionalDirectories,
              ...(this.opts.ownBranch ? { ownBranch: this.opts.ownBranch } : {}),
              ...(this.opts.codedenHome ? { codedenHome: this.opts.codedenHome } : {}),
            },
            autonomy: () => (this.opts.readOnly ? "read_only" : this.autonomy),
            ctx: (threadId, turnId) => this.mapper.requestCtx(threadId, turnId),
            filePaths: (itemId) => this.filePaths.get(itemId),
          }),
        onExit: (code, stderr) => this.onExit(code, stderr),
      },
      { env: this.opts.env, cwd: this.opts.cwd },
    );
    this.rpc = rpc;
    await this.openThread(rpc, { report: true });
    if (this.config.onModels) {
      rpc.request<{ data: Model[] }>("model/list", {}).then(
        (r) => this.config.onModels?.(r.data),
        () => {},
      );
    }
    return rpc;
  }

  /**
   * Resume the session's thread on `rpc` (unarchived first), or start one. `session.updated`
   * reports the thread: always with `report`, else only when it is a different thread.
   */
  private async openThread(rpc: CodexRpc, { report = false } = {}): Promise<void> {
    const opts = this.currentOptions();
    const { approvalPolicy, sandbox } = codexPolicy(opts.autonomy, opts.readOnly);
    const resumeId = this.mapper.codexThreadId;
    const res = await openCodexThread(
      rpc,
      resumeId,
      {
        cwd: this.opts.cwd,
        approvalPolicy,
        sandbox,
        config: codexConfigOverrides(opts),
        // "Default" is left out so Codex uses the model from the user's config.
        ...(explicitModel(this.opts.model) ? { model: explicitModel(this.opts.model) } : {}),
        ...(this.opts.systemPrompt ? { developerInstructions: this.opts.systemPrompt } : {}),
      },
      (message) => this.noticeOutsideTurn(message),
    );
    this.mapper.codexThreadId = res.thread.id;
    this.threadModel = res.model || undefined;
    if (report || res.thread.id !== resumeId) {
      this.events.push({ type: "session.updated", resumeToken: res.thread.id, model: res.model });
    }
  }

  /**
   * The `turn/start` model override: undefined keeps the thread's model. Switching back to
   * "Default" mid-session needs a real id, so it is resolved from Codex's model list.
   */
  private async turnModel(rpc: CodexRpc): Promise<string | undefined> {
    const change = this.nextTurn.model;
    if (change === undefined) return undefined;
    const explicit = explicitModel(change);
    if (explicit) return explicit;
    try {
      const list = await rpc.request<{ data: Model[] }>("model/list", {});
      return list.data.find((m) => m.isDefault)?.model;
    } catch {
      return undefined;
    }
  }

  private noticeOutsideTurn(message: string): void {
    // Notices need a turn; surface resume problems at the start of the next turn instead.
    this.pendingNotice = message;
  }

  private pendingNotice: string | undefined;

  private onNotification(n: ServerNotification): void {
    if (n.method === "item/started" && n.params.item.type === "fileChange") {
      this.filePaths.set(
        n.params.item.id,
        n.params.item.changes.map((c) => c.path),
      );
    }
    if (n.method === "turn/started" && this.pendingNotice) {
      this.mapper.beginTurn(n.params.turn.id);
      const message = this.pendingNotice;
      this.pendingNotice = undefined;
      this.events.push({
        type: "item.completed",
        threadId: this.mapper.rootThreadId,
        turnId: n.params.turn.id,
        item: {
          id: `resume-${n.params.turn.id}`,
          kind: "notice",
          status: "completed",
          level: "warning",
          code: "resume_failed",
          message,
        },
      });
    }
    this.mapper.handle(n);
  }

  private onExit(code: number | null, stderr: string): void {
    if (this.closed) return;
    this.broker.cancelAll();
    // Sub-agents ran in the same process: their turns end with it.
    this.mapper.endAll({
      type: "failed",
      code: "provider_exited",
      // The next message starts app-server again and resumes the thread.
      kind: "transient",
      message: `codex app-server exited (code ${code ?? "unknown"})`,
      ...(stderr ? { detail: stderr.slice(-2000) } : {}),
    });
    this.turnPending = false;
  }
}

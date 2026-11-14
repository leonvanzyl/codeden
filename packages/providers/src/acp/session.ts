import { randomUUID } from "node:crypto";
import {
  AGENT_ALLOW_LIST_NOTICE,
  type AgentEvent,
  type AutonomyLevel,
  type RuntimeResponse,
  type SessionOptions,
  type UserInput,
} from "@codeden/contracts";
import { type ProviderSession, ProviderSessionError, type SessionConfigChange } from "../adapter";
import { ApprovalBroker } from "../approvals";
import { AsyncQueue } from "../async-queue";
import { explicitModel } from "../util/model";
import { answerPermission } from "./approvals";
import { acpMcpServers, agentCan, modelsOf, skippedNotice } from "./config";
import { exitedOutcome, failedPrompt, stopNotice, stopOutcome } from "./errors";
import { type AcpExtensionHost, type AcpSessionConfig, extensionHost } from "./extensions";
import { promptBlocks, withInstructions } from "./items";
import { AcpEventMapper } from "./mapper";
import { type AcpPolicy, policyFor, trustedServers } from "./policy";
import { startAgent } from "./process";
import type {
  AcpConfigOption,
  AcpIncoming,
  AcpInitializeResult,
  AcpPermissionRequest,
  AcpPromptResult,
  AcpSessionNotification,
  AcpSessionSetup,
} from "./protocol";
import { type AcpRpc, AcpRpcError, METHOD_NOT_FOUND } from "./rpc";
import { currentMode, openOrLoad, setMode, setModel } from "./setup";
import { AcpSubagents } from "./subagents";

/**
 * A session on an ACP agent (§7.2): one agent process per CodeDen session, since every session
 * has its own MCP servers and role-scoped token. A new session runs `session/new` in the
 * worktree; a resumed one `session/load`s the agent's own session (the resume token) and drops
 * its replayed history. When the agent exits, the next `send()` starts it again and resumes.
 * Subagents the agent runs as child sessions are child threads (`AcpSubagents`): updates and
 * requests are routed by the ACP session id they carry.
 */
export class AcpSession implements ProviderSession {
  readonly events = new AsyncQueue<AgentEvent>();
  private readonly mapper: AcpEventMapper;
  private readonly subagents: AcpSubagents;
  private readonly broker: ApprovalBroker;
  private readonly policy: AcpPolicy;
  private readonly mcpServers: string[];
  private readonly trusted: string[];
  private rpc: AcpRpc | undefined;
  private starting: Promise<AcpRpc> | undefined;
  private info: AcpInitializeResult = {};
  private acpSession: string | undefined;
  private setup: AcpSessionSetup = {};
  private closed = false;
  private turnPending = false;
  /** A `send()` still starting the agent (or switching its model): no turn or prompt yet. */
  private startingSend: StartingSend | undefined;
  private interrupted = false;
  private model: string | undefined;
  private nextModel: string | null | undefined;
  private instructions: string | undefined;
  private mode: string | undefined;
  private planning: boolean;
  /** Warnings for the next turn's transcript (a notice needs a turn to sit in). */
  private notices: Array<{ message: string; code: string }> = [];

  constructor(
    private readonly opts: SessionOptions,
    private readonly config: AcpSessionConfig,
  ) {
    const emit = (event: AgentEvent) => {
      if (
        (event.type === "turn.completed" ||
          event.type === "turn.failed" ||
          event.type === "turn.interrupted") &&
        event.threadId === this.mapper.threadId
      ) {
        this.turnPending = false;
      }
      this.events.push(event);
    };
    this.mcpServers = opts.mcpServers.map((s) => s.name);
    this.trusted = trustedServers(opts);
    const tools = { cwd: opts.cwd, mcpServers: this.mcpServers };
    this.subagents = new AcpSubagents({ sessionId: opts.sessionId, emit, tools });
    const ext = config.spec.extensions;
    this.mapper = new AcpEventMapper({
      sessionId: opts.sessionId,
      emit,
      tools,
      onMode: (mode) => this.onAgentMode(mode),
      onConfigOptions: (options) => this.onConfigOptions(options),
      beforeEnd: (ok) => this.subagents.endAll(ok),
      onToolDone: (state) => this.subagents.toolDone(this.mapper, state),
      ...(ext?.toolCall ? { describeTool: (call) => ext.toolCall?.(call) } : {}),
    });
    this.broker = new ApprovalBroker(emit);
    this.policy = policyFor(opts);
    this.planning = opts.planMode && !!config.spec.modes.plan;
    this.policy.planning = this.planning;
    this.model = explicitModel(opts.model);
    this.acpSession = opts.resumeToken;
  }

  /** Start the agent and open (or resume) its session. */
  async start(): Promise<void> {
    this.events.push({ type: "thread.started", thread: { id: this.mapper.threadId } });
    this.addNotice(this.config.spec.allowListNotice?.(this.opts.cwd), AGENT_ALLOW_LIST_NOTICE);
    await this.ensureAgent();
  }

  resumeToken(): string | undefined {
    return this.acpSession;
  }

  async configure(change: SessionConfigChange): Promise<void> {
    if (change.model !== undefined) this.nextModel = change.model;
  }

  /** Applies from the next permission request; read-only also switches to the read-only mode. */
  async setAutonomy(level: AutonomyLevel): Promise<void> {
    this.policy.setAutonomy(level);
    if (!this.planning) await this.applyMode().catch(() => undefined);
  }

  async setPlanMode(on: boolean): Promise<void> {
    if (!this.config.spec.modes.plan) {
      throw new ProviderSessionError("unsupported", `${this.config.spec.label} has no plan mode`);
    }
    this.planning = on;
    this.policy.planning = on;
    await this.applyMode().catch(() => undefined);
  }

  async send(input: UserInput): Promise<void> {
    if (this.closed) throw new ProviderSessionError("closed", "Session is closed");
    if (this.turnPending || this.mapper.currentTurnId) {
      throw new ProviderSessionError("turn_running", "A turn is already running");
    }
    this.turnPending = true;
    const pending: StartingSend = { turnId: `turn-${randomUUID()}`, input, stopped: false };
    this.startingSend = pending;
    let prompt: ReturnType<typeof promptBlocks> | undefined;
    let rpc: AcpRpc;
    try {
      rpc = await this.ensureAgent();
      if (!pending.stopped) {
        await this.applyModelChange(rpc);
        prompt = promptBlocks(
          withInstructions(input, this.instructions),
          agentCan(this.info, "images"),
        );
      }
    } catch (error) {
      // Stopped while starting: the turn already ended as interrupted, so the failure is moot.
      if (pending.stopped) return;
      if (this.startingSend === pending) this.startingSend = undefined;
      this.turnPending = false;
      throw error;
    }
    if (pending.stopped || !prompt) return;
    if (this.startingSend === pending) this.startingSend = undefined;
    this.instructions = undefined;
    this.interrupted = false;
    this.mapper.beginTurn(pending.turnId);
    this.mapper.userMessage(input);
    this.flushNotice();
    void this.runPrompt(rpc, pending.turnId, prompt);
  }

  /**
   * `session/cancel`; the prompt then ends as cancelled. Waiting requests are cancelled. A turn
   * still starting the agent ends at once, and its prompt is never sent.
   */
  async interrupt(): Promise<void> {
    const turnId = this.mapper.currentTurnId;
    if (!turnId) {
      this.stopStartingSend();
      return;
    }
    this.interrupted = true;
    this.broker.cancelAll();
    if (this.acpSession) this.rpc?.notify("session/cancel", { sessionId: this.acpSession });
    setTimeout(() => {
      if (this.mapper.currentTurnId === turnId) this.mapper.endTurn({ type: "interrupted" });
    }, this.config.interruptTimeoutMs ?? 10_000).unref();
  }

  async respond(requestId: string, response: RuntimeResponse): Promise<void> {
    this.broker.respond(requestId, response);
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.broker.cancelAll();
    this.mapper.endTurn({ type: "interrupted" });
    this.events.close();
    await this.rpc?.close();
  }

  // ---------------------------------------------------------------- internals

  /**
   * Stop pressed while `send()` still starts the agent: the turn ends now as interrupted (with
   * the user's message, so the transcript shows what was stopped) and its prompt is never sent.
   * The agent keeps starting, for the next message.
   */
  private stopStartingSend(): void {
    const pending = this.startingSend;
    if (!pending || this.closed) return;
    this.startingSend = undefined;
    pending.stopped = true;
    this.mapper.beginTurn(pending.turnId);
    this.mapper.userMessage(pending.input);
    this.flushNotice();
    this.mapper.endTurn({ type: "interrupted" });
  }

  private async runPrompt(rpc: AcpRpc, turnId: string, prompt: unknown): Promise<void> {
    try {
      const result = await rpc.request<AcpPromptResult>("session/prompt", {
        sessionId: this.acpSession,
        prompt,
      });
      if (this.mapper.currentTurnId !== turnId) return;
      this.mapper.promptUsage(result?.usage);
      const outcome = stopOutcome(result?.stopReason, this.config.spec.label);
      const limit = stopNotice(result?.stopReason, this.config.spec.label);
      if (limit) this.mapper.notice("warning", limit, String(result?.stopReason));
      this.mapper.endTurn(
        this.interrupted && outcome.type === "completed" ? { type: "interrupted" } : outcome,
      );
    } catch (error) {
      if (this.mapper.currentTurnId !== turnId) return;
      this.mapper.endTurn(
        this.interrupted ? { type: "interrupted" } : failedPrompt(error, this.config.spec.label),
      );
    }
  }

  private ensureAgent(): Promise<AcpRpc> {
    if (this.rpc && !this.rpc.isClosed) return Promise.resolve(this.rpc);
    this.starting ??= this.boot().finally(() => {
      this.starting = undefined;
    });
    return this.starting;
  }

  private async boot(): Promise<AcpRpc> {
    const { spec } = this.config;
    // Set once the handshake is done: an exit during it rejects `startAgent` instead.
    let started: AcpRpc | undefined;
    const { rpc, info } = await startAgent(
      this.config.executable,
      {
        onNotification: (m) => this.onNotification(m),
        onRequest: (m) => this.onRequest(m),
        onExit: (code, stderr) => {
          if (started) this.onExit(started, code, stderr);
        },
      },
      {
        args: spec.args,
        label: spec.label,
        ...(spec.authMethod ? { authMethod: spec.authMethod } : {}),
        ...(spec.extensions?.clientCapabilities
          ? { clientCapabilities: spec.extensions.clientCapabilities }
          : {}),
        cwd: this.opts.cwd,
        ...(this.opts.env ? { env: this.opts.env } : {}),
        ...(this.config.startTimeoutMs ? { timeoutMs: this.config.startTimeoutMs } : {}),
      },
    );
    started = rpc;
    try {
      if (this.closed) throw new ProviderSessionError("closed", "Session is closed");
      this.rpc = rpc;
      this.info = info;
      await this.openSession(rpc);
      return rpc;
    } catch (error) {
      this.rpc = undefined;
      await rpc.close();
      throw error;
    }
  }

  /** `session/load` the resume token when the agent can; else (or when that fails) a new one. */
  private async openSession(rpc: AcpRpc): Promise<void> {
    const { label } = this.config.spec;
    const { servers, skipped } = acpMcpServers(this.opts.mcpServers, agentCan(this.info, "http"));
    this.addNotice(skippedNotice(label, skipped));
    // `session/load` replays the history first, mode and config updates included: none of it
    // is news, and a replayed mode change must not end plan mode.
    this.mapper.replaying = true;
    const opened = await openOrLoad(rpc, {
      cwd: this.opts.cwd,
      mcpServers: servers,
      ...(this.acpSession ? { resumeId: this.acpSession } : {}),
      canLoad: agentCan(this.info, "load"),
      label,
    }).finally(() => {
      this.mapper.replaying = false;
    });
    this.addNotice(opened.notice);
    this.acpSession = opened.sessionId;
    if (!opened.resumed) this.instructions = this.opts.systemPrompt?.trim() || undefined;
    this.setup = opened.setup;
    this.mode = currentMode(opened.setup);
    this.config.onSetup?.(opened.setup, this.info);
    await this.applyMode();
    if (this.model) {
      const setup = this.setup;
      this.setup = await setModel(rpc, opened.sessionId, setup, this.model).catch(() => setup);
    }
    const model = this.model ?? modelsOf(opened.setup)?.current;
    this.events.push({
      type: "session.updated",
      resumeToken: opened.sessionId,
      ...(model ? { model } : {}),
    });
  }

  /** Put the agent in the mode the session needs: planning, read-only, or full tools. */
  private async applyMode(): Promise<void> {
    const { modes } = this.config.spec;
    const want =
      this.planning && modes.plan
        ? modes.plan
        : this.policy.isReadOnly && modes.readOnly
          ? modes.readOnly
          : modes.agent;
    const rpc = this.rpc;
    if (!rpc || !this.acpSession || want === this.mode) return;
    const next = await setMode(rpc, this.acpSession, this.setup, want);
    if (!next) return;
    this.setup = next;
    this.mode = want;
  }

  private async applyModelChange(rpc: AcpRpc): Promise<void> {
    const next = this.nextModel;
    if (next === undefined || !this.acpSession) return;
    this.nextModel = undefined;
    const model = explicitModel(next);
    if (!model || model === this.model) return;
    this.setup = await setModel(rpc, this.acpSession, this.setup, model);
    this.model = model;
    this.events.push({ type: "session.updated", model });
  }

  private onAgentMode(mode: string): void {
    this.mode = mode;
    const plan = this.config.spec.modes.plan;
    if (plan && this.planning && mode !== plan) {
      this.planning = false;
      this.policy.planning = false;
      this.events.push({ type: "session.updated", planMode: false });
    }
  }

  private onConfigOptions(options: AcpConfigOption[]): void {
    this.setup = { ...this.setup, configOptions: options };
    const mode = currentMode({ configOptions: options });
    if (mode && mode !== this.mode) this.onAgentMode(mode);
    this.config.onSetup?.(this.setup, this.info);
  }

  /** The host for an extension call from the ACP session `acpSessionId` (the root or a child). */
  private host(acpSessionId: string | undefined): AcpExtensionHost {
    return extensionHost({
      cwd: this.opts.cwd,
      broker: this.broker,
      mapper: this.mapperOf(acpSessionId) ?? this.mapper,
      subagents: this.subagents,
      childSessions: () => agentCan(this.info, "subagents"),
      planning: () => this.planning,
      exitPlanMode: () => this.exitPlanMode(),
    });
  }

  /** The mapper for an ACP session id: the root session's, a child's, or none (unknown). */
  private mapperOf(acpSessionId: string | undefined): AcpEventMapper | undefined {
    if (!acpSessionId || acpSessionId === this.acpSession) return this.mapper;
    return this.subagents.mapperFor(acpSessionId);
  }

  /** The user approved the plan: leave plan mode for the session's level, and say so. */
  private async exitPlanMode(): Promise<void> {
    if (!this.planning) return;
    this.planning = false;
    this.policy.planning = false;
    this.events.push({ type: "session.updated", planMode: false });
    await this.applyMode().catch(() => undefined);
  }

  /**
   * Updates go to the mapper of the session they name: the root session's, or a subagent's
   * child session's. Updates of sessions CodeDen doesn't know are dropped.
   */
  private onNotification(message: AcpIncoming): void {
    if (message.method === "session/update") {
      const params = message.params as AcpSessionNotification | undefined;
      const mapper = params?.sessionId ? this.mapperOf(params.sessionId) : undefined;
      if (!params?.update || !mapper) return;
      if (!this.subagents.handle(params.update, mapper)) mapper.handle(params.update);
      return;
    }
    const host = this.host(sessionIdOf(message.params));
    this.config.spec.extensions?.notification?.(message.method, message.params, host);
  }

  /** Requests from a child session (permissions, vendor requests) go to its child thread. */
  private async onRequest(message: AcpIncoming): Promise<unknown> {
    const mapper = this.mapperOf(sessionIdOf(message.params)) ?? this.mapper;
    if (message.method === "session/request_permission") {
      const req = message.params as AcpPermissionRequest;
      const ext = this.config.spec.extensions;
      return answerPermission(req, {
        broker: this.broker,
        policy: this.policy,
        mapper,
        cwd: this.opts.cwd,
        mcpServers: this.mcpServers,
        trustedServers: this.trusted,
        ...(ext?.permission
          ? { own: (call) => ext.permission?.(req, call, this.host(sessionIdOf(req))) }
          : {}),
      });
    }
    const handled = this.config.spec.extensions?.request?.(
      message.method,
      message.params,
      this.host(sessionIdOf(message.params)),
    );
    if (handled) return handled;
    throw new AcpRpcError(METHOD_NOT_FOUND, `CodeDen does not support ${message.method}`);
  }

  /** Show a warning in the next turn (once, however often the agent restarts before it). */
  private addNotice(message: string | undefined, code = "provider_notice"): void {
    if (message && !this.notices.some((n) => n.message === message)) {
      this.notices.push({ message, code });
    }
  }

  private flushNotice(): void {
    const notices = this.notices;
    this.notices = [];
    for (const { message, code } of notices) this.mapper.notice("warning", message, code);
  }

  private onExit(rpc: AcpRpc, code: number | null, stderr: string): void {
    if (this.closed || rpc !== this.rpc) return;
    this.rpc = undefined;
    this.broker.cancelAll();
    this.mapper.endTurn(exitedOutcome(this.config.spec.label, code, stderr));
    this.turnPending = false;
  }
}

/** A message `send()` took while the agent was starting; `stopped` once Stop ended its turn. */
type StartingSend = { turnId: string; input: UserInput; stopped: boolean };

/** The ACP session id a request or notification names, if any. */
function sessionIdOf(params: unknown): string | undefined {
  const id = (params as { sessionId?: unknown } | null | undefined)?.sessionId;
  return typeof id === "string" && id ? id : undefined;
}

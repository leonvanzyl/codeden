import { randomUUID } from "node:crypto";
import type {
  AgentEvent,
  AutonomyLevel,
  RuntimeResponse,
  SessionOptions,
  UserInput,
} from "@codeden/contracts";
import { type ProviderSession, ProviderSessionError, type SessionConfigChange } from "../adapter";
import { ApprovalBroker } from "../approvals";
import { AsyncQueue } from "../async-queue";
import type { ResolvedCommand } from "../util/exec";
import { explicitModel } from "../util/model";
import { answerPermission } from "./approvals";
import { acpMcpServers, modelsOf } from "./config";
import { failedPrompt, stopNotice, stopOutcome } from "./errors";
import type { AcpExtensionHost, AcpExtensions } from "./extensions";
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

/** How one ACP agent is driven: its command, auth method, modes and vendor extensions. */
export interface AcpAgentSpec {
  /** "Cursor": shown in errors and notices. */
  label: string;
  /** Arguments that start its ACP server, e.g. `["acp"]`. */
  args: readonly string[];
  authMethod?: string;
  /** Its mode ids: full tools, planning, and read-only (when it has them). */
  modes: { agent: string; plan?: string; readOnly?: string };
  extensions?: AcpExtensions;
}

export interface AcpSessionConfig {
  executable: ResolvedCommand;
  spec: AcpAgentSpec;
  /** The agent reported its session setup (models, modes): for the adapter's model list. */
  onSetup?: (setup: AcpSessionSetup, info: AcpInitializeResult) => void;
  startTimeoutMs?: number;
  interruptTimeoutMs?: number;
}

/**
 * A session on an ACP agent (§7.2): one agent process per CodeDen session, since every session
 * has its own MCP servers and role-scoped token. A new session runs `session/new` in the
 * worktree; a resumed one `session/load`s the agent's own session (the resume token) and drops
 * its replayed history. When the agent exits, the next `send()` starts it again and resumes.
 */
export class AcpSession implements ProviderSession {
  readonly events = new AsyncQueue<AgentEvent>();
  private readonly mapper: AcpEventMapper;
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
  private interrupted = false;
  private model: string | undefined;
  private nextModel: string | null | undefined;
  private instructions: string | undefined;
  private mode: string | undefined;
  private planning: boolean;
  private notice: string | undefined;

  constructor(
    private readonly opts: SessionOptions,
    private readonly config: AcpSessionConfig,
  ) {
    const emit = (event: AgentEvent) => {
      if (
        event.type === "turn.completed" ||
        event.type === "turn.failed" ||
        event.type === "turn.interrupted"
      ) {
        this.turnPending = false;
      }
      this.events.push(event);
    };
    this.mcpServers = opts.mcpServers.map((s) => s.name);
    this.trusted = trustedServers(opts);
    this.mapper = new AcpEventMapper({
      sessionId: opts.sessionId,
      emit,
      tools: { cwd: opts.cwd, mcpServers: this.mcpServers },
      onMode: (mode) => this.onAgentMode(mode),
      onConfigOptions: (options) => this.onConfigOptions(options),
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
    this.events.push({ type: "thread.started", thread: { id: this.mapper.rootThreadId } });
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
    const turnId = `turn-${randomUUID()}`;
    let prompt: ReturnType<typeof promptBlocks>;
    let rpc: AcpRpc;
    try {
      rpc = await this.ensureAgent();
      await this.applyModelChange(rpc);
      prompt = promptBlocks(withInstructions(input, this.instructions), this.capable("images"));
      this.instructions = undefined;
    } catch (error) {
      this.turnPending = false;
      throw error;
    }
    this.interrupted = false;
    this.mapper.beginTurn(turnId);
    this.mapper.userMessage(input);
    this.flushNotice();
    void this.runPrompt(rpc, turnId, prompt);
  }

  /** `session/cancel`; the prompt then ends as cancelled. Waiting requests are cancelled. */
  async interrupt(): Promise<void> {
    const turnId = this.mapper.currentTurnId;
    if (!turnId) return;
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

  private capable(what: "images" | "load" | "http"): boolean {
    const caps = this.info.agentCapabilities;
    if (what === "images") return caps?.promptCapabilities?.image === true;
    if (what === "load") return caps?.loadSession === true;
    return caps?.mcpCapabilities?.http === true;
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
    const { servers, skipped } = acpMcpServers(this.opts.mcpServers, this.capable("http"));
    if (skipped.length) {
      this.notice = `${label} can't connect to HTTP MCP servers, so ${skipped.join(", ")} ${skipped.length === 1 ? "is" : "are"} not available in this session.`;
    }
    const opened = await openOrLoad(rpc, {
      cwd: this.opts.cwd,
      mcpServers: servers,
      ...(this.acpSession ? { resumeId: this.acpSession } : {}),
      canLoad: this.capable("load"),
      label,
    });
    this.notice = opened.notice ?? this.notice;
    this.acpSession = opened.sessionId;
    if (!opened.resumed) this.instructions = this.opts.systemPrompt?.trim() || undefined;
    this.setup = opened.setup;
    this.mode = currentMode(opened.setup);
    this.config.onSetup?.(opened.setup, this.info);
    await this.applyMode();
    if (this.model) {
      await setModel(rpc, opened.sessionId, this.setup, this.model).catch(() => undefined);
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
    if (await setMode(rpc, this.acpSession, this.setup, want)) this.mode = want;
  }

  private async applyModelChange(rpc: AcpRpc): Promise<void> {
    const next = this.nextModel;
    if (next === undefined || !this.acpSession) return;
    this.nextModel = undefined;
    const model = explicitModel(next);
    if (!model || model === this.model) return;
    await setModel(rpc, this.acpSession, this.setup, model);
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

  private host(): AcpExtensionHost {
    const self = this;
    return {
      cwd: this.opts.cwd,
      broker: this.broker,
      mapper: this.mapper,
      ctx: () => this.mapper.ctx(),
      get planning() {
        return self.planning;
      },
      exitPlanMode: async () => {
        if (!this.planning) return;
        this.planning = false;
        this.policy.planning = false;
        this.events.push({ type: "session.updated", planMode: false });
        await this.applyMode().catch(() => undefined);
      },
    };
  }

  private onNotification(message: AcpIncoming): void {
    if (message.method === "session/update") {
      const params = message.params as AcpSessionNotification | undefined;
      if (!params?.update || params.sessionId !== this.acpSession) return;
      this.mapper.handle(params.update);
      return;
    }
    this.config.spec.extensions?.notification?.(message.method, message.params, this.host());
  }

  private async onRequest(message: AcpIncoming): Promise<unknown> {
    if (message.method === "session/request_permission") {
      return answerPermission(message.params as AcpPermissionRequest, {
        broker: this.broker,
        policy: this.policy,
        mapper: this.mapper,
        cwd: this.opts.cwd,
        mcpServers: this.mcpServers,
        trustedServers: this.trusted,
      });
    }
    const handled = this.config.spec.extensions?.request?.(
      message.method,
      message.params,
      this.host(),
    );
    if (handled) return handled;
    throw new AcpRpcError(METHOD_NOT_FOUND, `CodeDen does not support ${message.method}`);
  }

  private flushNotice(): void {
    const message = this.notice;
    if (!message) return;
    this.notice = undefined;
    this.mapper.notice("warning", message, "provider_notice");
  }

  private onExit(rpc: AcpRpc, code: number | null, stderr: string): void {
    if (this.closed || rpc !== this.rpc) return;
    this.rpc = undefined;
    this.broker.cancelAll();
    this.mapper.endTurn({
      type: "failed",
      code: "provider_exited",
      // The next message starts the agent again and resumes the session.
      kind: "transient",
      message: `${this.config.spec.label} exited (code ${code ?? "unknown"})`,
      ...(stderr ? { detail: stderr.slice(-2000) } : {}),
    });
    this.turnPending = false;
  }
}

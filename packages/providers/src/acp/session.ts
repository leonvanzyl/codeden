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
import { acpMcpServers, findOption, modeIds, modelsOf, optionId } from "./config";
import { failedPrompt, stopOutcome } from "./errors";
import type { AcpExtensionHost, AcpExtensions } from "./extensions";
import { promptBlocks } from "./items";
import { AcpEventMapper } from "./mapper";
import { AcpPolicy } from "./policy";
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
    this.trusted = opts.mcpServers
      .filter((s) => s.transport === "http" && s.trusted)
      .map((s) => s.name);
    this.mapper = new AcpEventMapper({
      sessionId: opts.sessionId,
      emit,
      tools: { cwd: opts.cwd, mcpServers: this.mcpServers },
      onMode: (mode) => this.onAgentMode(mode),
      onConfigOptions: (options) => this.onConfigOptions(options),
    });
    this.broker = new ApprovalBroker(emit);
    this.policy = new AcpPolicy(
      opts.autonomy,
      {
        cwd: opts.cwd,
        extraRoots: opts.additionalDirectories,
        ...(opts.codedenHome ? { codedenHome: opts.codedenHome } : {}),
      },
      opts.readOnly ?? false,
      this.trusted,
      this.mcpServers,
    );
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
      prompt = promptBlocks(this.withInstructions(input), this.capable("images"));
    } catch (error) {
      this.turnPending = false;
      throw error;
    }
    this.interrupted = false;
    this.mapper.beginTurn(turnId);
    this.events.push({
      type: "item.completed",
      threadId: this.mapper.rootThreadId,
      turnId,
      item: { id: `user-${randomUUID()}`, kind: "user_message", status: "completed", input },
    });
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
      if (result?.stopReason === "max_tokens" || result?.stopReason === "max_turn_requests") {
        this.mapper.notice(
          "warning",
          `${this.config.spec.label} stopped: ${result.stopReason === "max_tokens" ? "the response hit its token limit" : "the turn hit its request limit"}.`,
          result.stopReason,
        );
      }
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
    const { servers, skipped } = acpMcpServers(this.opts.mcpServers, this.capable("http"));
    if (skipped.length) {
      this.notice = `${this.config.spec.label} can't connect to HTTP MCP servers, so ${skipped.join(", ")} ${skipped.length === 1 ? "is" : "are"} not available in this session.`;
    }
    const base = { cwd: this.opts.cwd, mcpServers: servers };
    let setup: AcpSessionSetup | undefined;
    const resumeId = this.acpSession;
    if (resumeId) {
      try {
        if (!this.capable("load")) throw new Error("the agent can't load sessions");
        setup =
          (await rpc.request<AcpSessionSetup>("session/load", { ...base, sessionId: resumeId })) ??
          {};
      } catch (error) {
        setup = undefined;
        this.notice = `Could not resume ${this.config.spec.label} session ${resumeId} (${error instanceof Error ? error.message : String(error)}); started a new one.`;
      }
    }
    if (!setup) {
      setup = (await rpc.request<AcpSessionSetup>("session/new", base)) ?? {};
      if (typeof setup.sessionId !== "string" || !setup.sessionId) {
        throw new AcpRpcError(-32000, `${this.config.spec.label} returned no session id`);
      }
      this.acpSession = setup.sessionId;
      this.instructions = this.opts.systemPrompt?.trim() || undefined;
    }
    this.setup = setup;
    this.mode =
      setup.modes?.currentModeId ??
      stringValue(findOption(setup.configOptions, "mode")?.currentValue);
    this.config.onSetup?.(setup, this.info);
    await this.applyMode();
    if (this.model) await this.setModel(rpc, this.model).catch(() => undefined);
    const current = modelsOf(setup)?.current;
    this.events.push({
      type: "session.updated",
      ...(this.acpSession ? { resumeToken: this.acpSession } : {}),
      ...((this.model ?? current) ? { model: this.model ?? current } : {}),
    });
  }

  /** The mode the session should be in: planning, read-only, or full tools. */
  private wantedMode(): string {
    const { modes } = this.config.spec;
    if (this.planning && modes.plan) return modes.plan;
    if (this.policy.isReadOnly && modes.readOnly) return modes.readOnly;
    return modes.agent;
  }

  private async applyMode(): Promise<void> {
    const rpc = this.rpc;
    const want = this.wantedMode();
    if (!rpc || !this.acpSession || want === this.mode) return;
    const available = modeIds(this.setup);
    if (available.length && !available.includes(want)) return;
    const option = findOption(this.setup.configOptions, "mode");
    const id = option ? optionId(option) : undefined;
    if (id) {
      await rpc.request("session/set_config_option", {
        sessionId: this.acpSession,
        configId: id,
        value: want,
      });
    } else {
      await rpc.request("session/set_mode", { sessionId: this.acpSession, modeId: want });
    }
    this.mode = want;
  }

  private async applyModelChange(rpc: AcpRpc): Promise<void> {
    const next = this.nextModel;
    if (next === undefined) return;
    this.nextModel = undefined;
    const model = explicitModel(next);
    if (!model || model === this.model) return;
    await this.setModel(rpc, model);
    this.model = model;
    this.events.push({ type: "session.updated", model });
  }

  /** The agent's `model` config option when it has one, else `session/set_model`. */
  private async setModel(rpc: AcpRpc, model: string): Promise<void> {
    const option = findOption(this.setup.configOptions, "model");
    const id = option ? optionId(option) : undefined;
    if (id) {
      await rpc.request("session/set_config_option", {
        sessionId: this.acpSession,
        configId: id,
        value: model,
      });
    } else {
      await rpc.request("session/set_model", { sessionId: this.acpSession, modelId: model });
    }
  }

  private withInstructions(input: UserInput): UserInput {
    const text = this.instructions;
    if (!text) return input;
    this.instructions = undefined;
    return { ...input, text: `<instructions>\n${text}\n</instructions>\n\n${input.text}` };
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
    const mode = stringValue(findOption(options, "mode")?.currentValue);
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

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined;
}

import { randomUUID } from "node:crypto";
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
import { type ApprovalDeps, handleForm, handlePermission } from "./approvals";
import { seg } from "./client";
import { OpenCodeCommands, type OpenCodeRoute, runCommand, withSkill } from "./commands";
import { mcpName, openCodeConfig, toPromptBody } from "./config";
import type { TurnOutcome } from "./errors";
import { userMessageEvent } from "./items";
import { OpenCodeEventMapper } from "./mapper";
import { OpenCodePolicy } from "./policy";
import type { OcEvent } from "./protocol";
import { OpenCodeServer } from "./server";
import { OpenCodeModelChoice, openOrResume } from "./session-open";

export interface OpenCodeSessionConfig {
  executable: ResolvedCommand;
  /** Directory of the env-guard plugin (`guardPluginDir()`); none in some tests. */
  pluginDir?: string;
  /** Reasoning efforts a model (CodeDen id) offers, from the model list. */
  modelEfforts?: (model: string | undefined) => readonly ReasoningEffort[] | undefined;
  /** Context window of a model (CodeDen id), from the model list. */
  contextWindow?: (model: string | undefined) => number | undefined;
  interruptTimeoutMs?: number;
  startTimeoutMs?: number;
}

/**
 * An OpenCode session (§7.2): one private `opencode serve` per CodeDen session, and one
 * OpenCode session in it, created in the session's working directory. OpenCode keeps the
 * conversation in its own database, so after a crash or restart the next `send()` starts a
 * new server and continues the same OpenCode session (the resume token).
 */
export class OpenCodeSession implements ProviderSession {
  readonly events = new AsyncQueue<AgentEvent>();
  private readonly mapper: OpenCodeEventMapper;
  private readonly broker: ApprovalBroker;
  private readonly policy: OpenCodePolicy;
  /** The `/` commands and skills OpenCode lists for the worktree, and how input is routed. */
  private readonly commands: OpenCodeCommands;
  private server: OpenCodeServer | undefined;
  private starting: Promise<OpenCodeServer> | undefined;
  private stream: AbortController | undefined;
  private closed = false;
  private turnPending = false;
  /** The model and effort, and a change queued for the next turn. */
  private readonly models: OpenCodeModelChoice;
  /** Worktree and MCP server names for labelling tool calls; names grow once `/api/mcp` answers. */
  private readonly toolCtx: { cwd: string; mcpServers: string[] };
  /** Instructions that could not be set on the session go in front of the next prompt. */
  private inlineInstructions: string | undefined;
  private pendingNotice: string | undefined;
  /** The prompt being sent: recorded as the user message of its turn once the turn starts. */
  private pendingInput: { turnId: string; input: UserInput } | undefined;

  constructor(
    private readonly opts: SessionOptions,
    private readonly config: OpenCodeSessionConfig,
  ) {
    const emit = (event: AgentEvent) => {
      if (
        (event.type === "turn.completed" ||
          event.type === "turn.failed" ||
          event.type === "turn.interrupted") &&
        event.threadId === this.mapper.rootThreadId
      ) {
        this.turnPending = false;
      }
      this.events.push(event);
      // The turn opens (on OpenCode's execution event or once the prompt is queued, whichever
      // comes first): its user message comes before anything the agent does.
      const pending = this.pendingInput;
      if (event.type === "turn.started" && pending?.turnId === event.turnId) {
        this.pendingInput = undefined;
        this.events.push(userMessageEvent(event.threadId, event.turnId, pending.input));
      }
    };
    this.toolCtx = { cwd: opts.cwd, mcpServers: opts.mcpServers.map((s) => mcpName(s.name)) };
    this.mapper = new OpenCodeEventMapper({
      sessionId: opts.sessionId,
      emit,
      tools: this.toolCtx,
      contextWindow: (model) => config.contextWindow?.(model),
    });
    this.mapper.rootSession = opts.resumeToken;
    this.broker = new ApprovalBroker(emit);
    this.policy = new OpenCodePolicy(
      opts.autonomy,
      {
        cwd: opts.cwd,
        extraRoots: opts.additionalDirectories,
        ...(opts.codedenHome ? { codedenHome: opts.codedenHome } : {}),
        ...(opts.artifactsDir ? { artifactsDir: opts.artifactsDir } : {}),
        ...(opts.env ? { env: { ...process.env, ...opts.env } } : {}),
      },
      opts.readOnly ?? false,
    );
    this.models = new OpenCodeModelChoice(opts.model, opts.effort, config.modelEfforts);
    this.commands = new OpenCodeCommands(opts.cwd, (commands) =>
      this.events.push({ type: "session.updated", commands }),
    );
  }

  /** Start the server and open (or resume) the OpenCode session. */
  async start(): Promise<void> {
    this.events.push({ type: "thread.started", thread: { id: this.mapper.rootThreadId } });
    await this.ensureServer();
  }

  resumeToken(): string | undefined {
    return this.mapper.rootSession;
  }

  /** Model/effort for the next turn on; OpenCode switches the session's model. */
  async configure(change: SessionConfigChange): Promise<void> {
    this.models.queue(change);
  }

  /** Applies from the next permission request, inside a running turn too (`liveAutonomy`). */
  async setAutonomy(level: AutonomyLevel): Promise<void> {
    this.policy.setAutonomy(level);
  }

  async send(input: UserInput): Promise<void> {
    if (this.closed) throw new ProviderSessionError("closed", "Session is closed");
    if (this.turnPending || this.mapper.currentTurnId) {
      throw new ProviderSessionError("turn_running", "A turn is already running");
    }
    this.turnPending = true;
    const turnId = `turn-${randomUUID()}`;
    try {
      const server = await this.ensureServer();
      await this.applyModelChange(server);
      const route = await this.commands.resolve(input.text, server.client);
      this.mapper.pendingTurnId = turnId;
      this.pendingInput = { turnId, input };
      const refused = await this.dispatch(server, input, route);
      this.mapper.beginTurn(turnId);
      if (refused) this.mapper.endTurn(refused);
      else this.flushNotice();
    } catch (error) {
      if (this.mapper.pendingTurnId === turnId) this.mapper.pendingTurnId = undefined;
      if (this.pendingInput?.turnId === turnId) this.pendingInput = undefined;
      if (this.mapper.currentTurnId === turnId) {
        this.mapper.endTurn({ type: "failed", message: errorMessage(error), code: "send_failed" });
      }
      this.turnPending = false;
      throw error;
    }
  }

  /**
   * Compact the session now (`POST /api/session/:id/compact`): OpenCode queues a compaction and
   * runs it as an execution of its own, which opens and ends the turn like a prompt's, with its
   * `session.compaction.*` events as the notices. No user message.
   */
  async compact(): Promise<void> {
    if (this.closed) throw new ProviderSessionError("closed", "Session is closed");
    if (this.turnPending || this.mapper.currentTurnId) {
      throw new ProviderSessionError("turn_running", "A turn is already running");
    }
    this.turnPending = true;
    const turnId = `turn-${randomUUID()}`;
    try {
      const server = await this.ensureServer();
      this.mapper.pendingTurnId = turnId;
      await server.client.post(`/api/session/${seg(this.sessionId())}/compact`, {});
      this.mapper.beginTurn(turnId);
      this.flushNotice();
    } catch (error) {
      if (this.mapper.pendingTurnId === turnId) this.mapper.pendingTurnId = undefined;
      if (this.mapper.currentTurnId === turnId) {
        this.mapper.endTurn({
          type: "failed",
          message: errorMessage(error),
          code: "compact_failed",
        });
      }
      this.turnPending = false;
      throw error;
    }
  }

  /** Delivered at the next step boundary of the running turn (`delivery: "steer"`). */
  async steer(input: UserInput): Promise<void> {
    const server = this.server;
    const turnId = this.mapper.currentTurnId;
    if (!turnId || !server || server.exited) {
      throw new ProviderSessionError("no_turn", "No turn is running");
    }
    await server.client.post(
      `/api/session/${seg(this.sessionId())}/prompt`,
      toPromptBody(input, "steer"),
    );
    this.events.push(userMessageEvent(this.mapper.rootThreadId, turnId, input));
  }

  async interrupt(): Promise<void> {
    const turnId = this.mapper.currentTurnId;
    const server = this.server;
    if (!turnId || !server) return;
    this.broker.cancelAll();
    try {
      await server.client.post(`/api/session/${seg(this.sessionId())}/interrupt`);
    } catch {
      // Server gone or the turn already over; the timeout below closes the turn.
    }
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
    this.stream?.abort();
    await this.server?.close();
  }

  // ---------------------------------------------------------------- internals

  /**
   * Send the input by its route (§13): `/<name>` runs a command OpenCode listed, or attaches a
   * skill it listed; anything else is a prompt. A command OpenCode refuses comes back as the
   * turn's failure. Instructions not yet given wait for the next prompt (a command's text is
   * its arguments).
   */
  private async dispatch(
    server: OpenCodeServer,
    input: UserInput,
    route: OpenCodeRoute,
  ): Promise<TurnOutcome | undefined> {
    const path = `/api/session/${seg(this.sessionId())}`;
    if (route.type === "command") return runCommand(server.client, path, route, input);
    const body = toPromptBody(this.withInstructions(input));
    const moved = body.text.length - input.text.length;
    await server.client.post(`${path}/prompt`, withSkill(body, route, moved));
    return undefined;
  }

  private sessionId(): string {
    const id = this.mapper.rootSession;
    if (!id) throw new ProviderSessionError("not_started", "OpenCode session is not started");
    return id;
  }

  private ensureServer(): Promise<OpenCodeServer> {
    if (this.server && !this.server.exited) return Promise.resolve(this.server);
    this.starting ??= this.boot().finally(() => {
      this.starting = undefined;
    });
    return this.starting;
  }

  private async boot(): Promise<OpenCodeServer> {
    const server = await OpenCodeServer.start(this.config.executable, {
      cwd: this.opts.cwd,
      ...(this.opts.env ? { env: this.opts.env } : {}),
      config: openCodeConfig({
        mcpServers: this.opts.mcpServers,
        ...(this.config.pluginDir ? { pluginDir: this.config.pluginDir } : {}),
      }),
      ...(this.config.startTimeoutMs ? { startTimeoutMs: this.config.startTimeoutMs } : {}),
    });
    try {
      if (this.closed) throw new ProviderSessionError("closed", "Session is closed");
      this.server = server;
      server.onExit((code, stderr) => this.onExit(server, code, stderr));
      this.stream?.abort();
      const stream = new AbortController();
      this.stream = stream;
      await server.client.subscribe(
        (event) => this.onEvent(event),
        stream.signal,
        () => {
          // The event stream ended while the server runs: without events nothing can be
          // followed, so stop the server; the next send starts a new one and resumes.
          if (!this.closed && this.server === server) void server.close();
        },
      );
      await this.openSession(server);
      void this.loadMcpNames(server);
      void this.commands.refresh(server.client);
      return server;
    } catch (error) {
      await server.close();
      throw error;
    }
  }

  /**
   * Resume the OpenCode session when there is one, else create it (`session-open.ts`). CodeDen's
   * role prompt is a session instruction, else it goes in front of the first prompt.
   */
  private async openSession(server: OpenCodeServer): Promise<void> {
    const opened = await openOrResume({
      client: server.client,
      resumeId: this.mapper.rootSession,
      directory: this.opts.cwd,
      models: this.models,
      systemPrompt: this.opts.systemPrompt,
      adopt: (id) => {
        this.mapper.rootSession = id;
      },
    });
    if (opened.notice) this.pendingNotice = opened.notice;
    if (opened.inlineInstructions) this.inlineInstructions = opened.inlineInstructions;
    this.mapper.currentModel = opened.model;
    this.events.push({
      type: "session.updated",
      resumeToken: opened.id,
      ...(opened.model ? { model: opened.model } : {}),
    });
  }

  private withInstructions(input: UserInput): UserInput {
    const text = this.inlineInstructions;
    if (!text) return input;
    this.inlineInstructions = undefined;
    return { ...input, text: `<instructions>\n${text}\n</instructions>\n\n${input.text}` };
  }

  /** Apply a `configure()` change: the session switches model (and variant) for good. */
  private async applyModelChange(server: OpenCodeServer): Promise<void> {
    const ref = await this.models.takeChange(server.client);
    if (!ref) return;
    await server.client.post(`/api/session/${seg(this.sessionId())}/model`, { model: ref });
  }

  /** MCP servers the session can see, so their tools render as MCP calls. */
  private async loadMcpNames(server: OpenCodeServer): Promise<void> {
    try {
      const res = await server.client.get<{ data?: { name?: string; id?: string }[] }>("/api/mcp");
      const names = (res.data ?? [])
        .map((s) => s.name ?? s.id)
        .filter((n): n is string => typeof n === "string");
      this.toolCtx.mcpServers = [...new Set([...this.toolCtx.mcpServers, ...names.map(mcpName)])];
    } catch {
      // Only affects how other MCP tools are labelled.
    }
  }

  private deps(): ApprovalDeps {
    return {
      client: () => this.server?.client,
      broker: this.broker,
      policy: this.policy,
      mapper: this.mapper,
      cwd: this.opts.cwd,
    };
  }

  private onEvent(event: OcEvent): void {
    if (event.type === "permission.asked") {
      void handlePermission(event.data, this.deps());
      return;
    }
    if (event.type === "form.created") {
      void handleForm(event.data.form, this.deps());
      return;
    }
    if (event.type === "command.updated" || event.type === "skill.updated") {
      if (this.server) this.commands.updated(this.server.client);
      return;
    }
    this.mapper.handle(event);
  }

  private flushNotice(): void {
    const message = this.pendingNotice;
    const turnId = this.mapper.currentTurnId;
    if (!message || !turnId) return;
    this.pendingNotice = undefined;
    this.events.push({
      type: "item.completed",
      threadId: this.mapper.rootThreadId,
      turnId,
      item: {
        id: `resume-${turnId}`,
        kind: "notice",
        status: "completed",
        level: "warning",
        code: "resume_failed",
        message,
      },
    });
  }

  private onExit(server: OpenCodeServer, code: number | null, stderr: string): void {
    if (this.closed || server !== this.server) return;
    this.stream?.abort();
    this.broker.cancelAll();
    this.mapper.endTurn({
      type: "failed",
      code: "provider_exited",
      // The next message starts a new server and resumes the session.
      kind: "transient",
      message: `opencode serve exited (code ${code ?? "unknown"})`,
      ...(stderr ? { detail: stderr.slice(-2000) } : {}),
    });
    this.turnPending = false;
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

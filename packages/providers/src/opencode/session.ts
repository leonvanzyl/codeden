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
import { explicitModel } from "../util/model";
import { type ApprovalDeps, handleForm, handlePermission } from "./approvals";
import { OpenCodeHttpError, seg } from "./client";
import {
  mcpName,
  modelId,
  modelRef,
  openCodeConfig,
  openCodeVariant,
  SESSION_PERMISSIONS,
  toPromptBody,
} from "./config";
import { OpenCodeEventMapper } from "./mapper";
import { OpenCodePolicy } from "./policy";
import type { OcEvent, OcModel, OcModelRef, OcSession } from "./protocol";
import { OpenCodeServer } from "./server";

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

/** Key of CodeDen's entry in the session's instructions (`<context key="codeden">`). */
const INSTRUCTIONS_KEY = "codeden";

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
  private server: OpenCodeServer | undefined;
  private starting: Promise<OpenCodeServer> | undefined;
  private stream: AbortController | undefined;
  private closed = false;
  private turnPending = false;
  /** CodeDen model id; undefined = OpenCode's configured default. */
  private model: string | undefined;
  private effort: ReasoningEffort | undefined;
  private nextTurn: SessionConfigChange = {};
  /** Worktree and MCP server names for labelling tool calls; names grow once `/api/mcp` answers. */
  private readonly toolCtx: { cwd: string; mcpServers: string[] };
  /** Instructions that could not be set on the session go in front of the next prompt. */
  private inlineInstructions: string | undefined;
  private pendingNotice: string | undefined;

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
      { cwd: opts.cwd, extraRoots: opts.additionalDirectories },
      opts.readOnly ?? false,
    );
    this.model = explicitModel(opts.model);
    this.effort = opts.effort;
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
    this.nextTurn = { ...this.nextTurn, ...change };
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
      this.mapper.pendingTurnId = turnId;
      await server.client.post(
        `/api/session/${seg(this.sessionId())}/prompt`,
        toPromptBody(this.withInstructions(input)),
      );
      this.mapper.beginTurn(turnId);
      this.flushNotice();
    } catch (error) {
      if (this.mapper.pendingTurnId === turnId) this.mapper.pendingTurnId = undefined;
      if (this.mapper.currentTurnId === turnId) {
        this.mapper.endTurn({ type: "failed", message: errorMessage(error), code: "send_failed" });
      }
      this.turnPending = false;
      throw error;
    }
  }

  /** Delivered at the next step boundary of the running turn (`delivery: "steer"`). */
  async steer(input: UserInput): Promise<void> {
    const server = this.server;
    if (!this.mapper.currentTurnId || !server || server.exited) {
      throw new ProviderSessionError("no_turn", "No turn is running");
    }
    await server.client.post(
      `/api/session/${seg(this.sessionId())}/prompt`,
      toPromptBody(input, "steer"),
    );
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
      return server;
    } catch (error) {
      await server.close();
      throw error;
    }
  }

  /** Resume the OpenCode session when there is one, else create it. */
  private async openSession(server: OpenCodeServer): Promise<void> {
    const client = server.client;
    const ref = await this.modelRefNow(server);
    let session: OcSession | undefined;
    const resumeId = this.mapper.rootSession;
    if (resumeId) {
      try {
        session = (await client.get<{ data: OcSession }>(`/api/session/${seg(resumeId)}`)).data;
        await client.patch(`/api/session/${seg(resumeId)}`, { permissions: SESSION_PERMISSIONS });
        if (ref) await client.post(`/api/session/${seg(resumeId)}/model`, { model: ref });
      } catch (error) {
        if (!(error instanceof OpenCodeHttpError) || error.status !== 404) throw error;
        session = undefined;
        this.pendingNotice = `Could not resume OpenCode session ${resumeId}; started a new one.`;
      }
    }
    session ??= (
      await client.post<{ data: OcSession }>("/api/session", {
        location: { directory: this.opts.cwd },
        permissions: SESSION_PERMISSIONS,
        ...(ref ? { model: ref } : {}),
      })
    ).data;
    this.mapper.rootSession = session.id;
    await this.setInstructions(server, session.id);
    const model = ref
      ? modelId(ref)
      : session.model
        ? modelId(session.model)
        : await this.defaultModel(server);
    this.mapper.currentModel = model;
    this.events.push({
      type: "session.updated",
      resumeToken: session.id,
      ...(model ? { model } : {}),
    });
  }

  /** CodeDen's role prompt as a session instruction; else in front of the first prompt. */
  private async setInstructions(server: OpenCodeServer, id: string): Promise<void> {
    const text = this.opts.systemPrompt?.trim();
    if (!text) return;
    try {
      await server.client.request(
        "PUT",
        `/api/experimental/session/${seg(id)}/instructions/entries/${INSTRUCTIONS_KEY}`,
        { value: text },
      );
    } catch {
      this.inlineInstructions = text;
    }
  }

  private withInstructions(input: UserInput): UserInput {
    const text = this.inlineInstructions;
    if (!text) return input;
    this.inlineInstructions = undefined;
    return { ...input, text: `<instructions>\n${text}\n</instructions>\n\n${input.text}` };
  }

  /** The model reference for the current model and effort (undefined = OpenCode's default). */
  private async modelRefNow(server: OpenCodeServer): Promise<OcModelRef | undefined> {
    const variant = openCodeVariant(
      this.effort,
      this.config.modelEfforts?.(this.model ?? (await this.defaultModel(server))),
    );
    const ref = modelRef(this.model, variant);
    if (ref || !variant) return ref;
    // An effort on the default model needs the default's real id.
    const fallback = await this.defaultModel(server);
    return modelRef(fallback, variant);
  }

  private async defaultModel(server: OpenCodeServer): Promise<string | undefined> {
    try {
      const res = await server.client.get<{ data: OcModel | null }>("/api/model/default");
      return res.data ? modelId(res.data) : undefined;
    } catch {
      return undefined;
    }
  }

  /** Apply a `configure()` change: the session switches model (and variant) for good. */
  private async applyModelChange(server: OpenCodeServer): Promise<void> {
    const change = this.nextTurn;
    if (change.model === undefined && change.effort === undefined) return;
    this.nextTurn = {};
    if (change.model !== undefined) this.model = explicitModel(change.model);
    if (change.effort !== undefined) this.effort = change.effort ?? undefined;
    const ref = (await this.modelRefNow(server)) ?? modelRef(await this.defaultModel(server));
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

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
import { codexConfigOverrides, codexPolicy, codexSandboxPolicy, toCodexInput } from "./config";
import { CodexEventMapper } from "./mapper";
import { startAppServer } from "./process";
import type { ServerNotification } from "./protocol";
import type {
  Model,
  ThreadResumeResponse,
  ThreadStartResponse,
  TurnStartParams,
  TurnStartResponse,
} from "./protocol/v2";
import type { CodexRpc } from "./rpc";

export interface CodexSessionConfig {
  executable: ResolvedCommand;
  onModels?: (models: Model[]) => void;
  /** Reasoning efforts a model lists (from `model/list`), when known. */
  modelEfforts?: (model: string) => readonly ReasoningEffort[] | undefined;
  interruptTimeoutMs?: number;
}

/**
 * CodeDen effort -> Codex reasoning effort. `max` is sent only to models that list it
 * (`supported`); older models top out at `xhigh`.
 */
export function codexEffort(
  effort: ReasoningEffort | undefined,
  supported?: readonly ReasoningEffort[],
): string | undefined {
  if (!effort) return undefined;
  if (effort !== "max") return effort;
  return supported?.includes("max") ? "max" : "xhigh";
}

/**
 * A Codex session over `codex app-server` (§7.2): one app-server process and one thread per
 * session. If the process exits, the next `send()` restarts it and resumes the thread.
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

  constructor(
    private readonly opts: SessionOptions,
    private readonly config: CodexSessionConfig,
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
    this.mapper = new CodexEventMapper(opts.sessionId, emit);
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
      const model = await this.turnModel(rpc);
      const inUse = model ?? explicitModel(this.opts.model) ?? this.threadModel;
      const effort = codexEffort(
        this.nextTurn.effort !== undefined ? (this.nextTurn.effort ?? undefined) : this.opts.effort,
        inUse ? this.config.modelEfforts?.(inUse) : undefined,
      );
      const res = await rpc.request<TurnStartResponse>("turn/start", {
        threadId: this.threadId(),
        input: toCodexInput(input),
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
    await this.rpc.request("turn/steer", {
      threadId: this.threadId(),
      input: toCodexInput(input),
      expectedTurnId: turnId,
    });
  }

  /**
   * Stop the running turn. If app-server doesn't end it in time (or never answers
   * `turn/interrupt` at all), the turn is closed as interrupted anyway.
   */
  async interrupt(): Promise<void> {
    const turnId = this.mapper.currentTurnId;
    const rpc = this.rpc;
    if (!turnId || !rpc) return;
    this.broker.cancelAll();
    await interruptWithDeadline(
      () => rpc.request("turn/interrupt", { threadId: this.threadId(), turnId }),
      this.config.interruptTimeoutMs ?? 10_000,
      () => {
        if (this.mapper.currentTurnId === turnId)
          this.mapper.endTurn({ type: "interrupted" }, turnId);
      },
    );
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
            },
            autonomy: () => (this.opts.readOnly ? "read_only" : this.autonomy),
            ctx: (turnId) => ({ threadId: this.mapper.rootThreadId, turnId }),
            filePaths: (itemId) => this.filePaths.get(itemId),
          }),
        onExit: (code, stderr) => this.onExit(code, stderr),
      },
      { env: this.opts.env, cwd: this.opts.cwd },
    );
    this.rpc = rpc;
    const opts = this.currentOptions();
    const { approvalPolicy, sandbox } = codexPolicy(opts.autonomy, opts.readOnly);
    const common = {
      cwd: this.opts.cwd,
      approvalPolicy,
      sandbox,
      config: codexConfigOverrides(opts),
      // "Default" is left out so Codex uses the model from the user's config.
      ...(explicitModel(this.opts.model) ? { model: explicitModel(this.opts.model) } : {}),
      ...(this.opts.systemPrompt ? { developerInstructions: this.opts.systemPrompt } : {}),
    };
    let res: ThreadStartResponse | ThreadResumeResponse | undefined;
    const resumeId = this.mapper.codexThreadId;
    if (resumeId) {
      // A thread has a single writer: while a previous app-server is still shutting down,
      // resume fails with "already has an active writer". Retry briefly, then give up loudly.
      for (let attempt = 0; !res; attempt += 1) {
        try {
          res = await rpc.request<ThreadResumeResponse>("thread/resume", {
            threadId: resumeId,
            excludeTurns: true,
            ...common,
          });
        } catch (error) {
          const message = (error as Error).message;
          if (/active writer/i.test(message)) {
            if (attempt < 5) {
              await new Promise((r) => setTimeout(r, 500 * (attempt + 1)));
              continue;
            }
            await rpc.close();
            throw new ProviderSessionError(
              "resume_conflict",
              `Codex thread ${resumeId} is still open in another process`,
            );
          }
          this.noticeOutsideTurn(
            `Could not resume Codex thread ${resumeId}; started a new one. ${message}`,
          );
          break;
        }
      }
    }
    res ??= await rpc.request<ThreadStartResponse>("thread/start", common);
    this.mapper.codexThreadId = res.thread.id;
    this.threadModel = res.model || undefined;
    this.events.push({ type: "session.updated", resumeToken: res.thread.id, model: res.model });
    if (this.config.onModels) {
      rpc.request<{ data: Model[] }>("model/list", {}).then(
        (r) => this.config.onModels?.(r.data),
        () => {},
      );
    }
    return rpc;
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
    this.mapper.endTurn({
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

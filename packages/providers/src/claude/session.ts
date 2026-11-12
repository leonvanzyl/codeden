import { randomUUID } from "node:crypto";
import os from "node:os";
import type {
  CanUseTool,
  PermissionResult,
  Query,
  SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import type {
  AgentEvent,
  AutonomyLevel,
  ItemOf,
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
import { str, toJson } from "../util/text";
import { policyHook, type ShellState } from "./hook";
import { ClaudeEventMapper } from "./mapper";
import { claudeNotesDirs } from "./notes-dirs";
import { buildQueryOptions, claudeEffort, toSdkUserMessage } from "./options";
import { ClaudePolicy, permissionModeFor } from "./permissions";
import { carriesToolResult, planApprovalItem, planDecision, planText } from "./plan-review";
import { askQuestion } from "./questions";
import type { ClaudeSdkModule } from "./sdk";
import { approvalTitle, PLAN_TOOL, QUESTION_TOOL } from "./tools";

/**
 * `Query.interrupt` as the SDK implements it: `cancelQueued` also cancels user messages still
 * waiting in the CLI's queue (CLIs advertising `interrupt_cancel_queued_v1`; older ones ignore
 * it). The receipt lists the uuids that were cancelled.
 */
type InterruptibleQuery = {
  interrupt(opts?: {
    cancelQueued?: boolean;
  }): Promise<{ still_queued: string[]; cancelled?: string[] } | undefined>;
};

export interface ClaudeSessionConfig {
  executable: ResolvedCommand;
  /** Called with the CLI's model list once a session is initialized. */
  onModels?: (models: Awaited<ReturnType<Query["supportedModels"]>>) => void;
  /** The SDK's `query()`, loaded by the adapter (installed on demand in the published build). */
  query: ClaudeSdkModule["query"];
  /** How long to wait for the CLI to confirm an interrupt before forcing the turn closed. */
  interruptTimeoutMs?: number;
  /** Claude's notes folders (plans, auto-memory); found from the user's settings by default. */
  notesRoots?: readonly string[];
}

/** Home and Claude config folder for a session (`CLAUDE_CONFIG_DIR` moves the latter). */
function claudeHomes(env: Record<string, string> | undefined): {
  home: string;
  configDir?: string;
} {
  const configDir = env?.CLAUDE_CONFIG_DIR ?? process.env.CLAUDE_CONFIG_DIR;
  return { home: os.homedir(), ...(configDir ? { configDir } : {}) };
}

/**
 * A Claude Code session over the Agent SDK with streaming input (§7.2). One `query()` per
 * session; turns are user messages pushed into its prompt queue. If the CLI exits, the next
 * `send()` starts a new query that resumes the same Claude session.
 */
export class ClaudeSession implements ProviderSession {
  readonly events = new AsyncQueue<AgentEvent>();
  private readonly mapper: ClaudeEventMapper;
  private readonly broker: ApprovalBroker;
  private readonly policy: ClaudePolicy;
  private q: Query | undefined;
  private prompts: AsyncQueue<SDKUserMessage> | undefined;
  private abort: AbortController | undefined;
  private stderrTail = "";
  private closed = false;
  /** The shell's current directory from the latest PreToolUse hook, for relative paths. */
  private readonly shell: ShellState = {};
  /** Current autonomy: a query restarted after the CLI exits starts with it. */
  private autonomy: AutonomyLevel;
  /** Plan mode right now (not just at launch): a restarted query starts with it too. */
  private planMode: boolean;
  /** The approved ExitPlanMode call whose result re-applies the permission level. */
  private planExitToolUseId: string | undefined;
  /** Uuids of messages steered into the running turn, so a Stop can tell which it cancelled. */
  private readonly steered = new Set<string>();

  constructor(
    private readonly opts: SessionOptions,
    private readonly config: ClaudeSessionConfig,
  ) {
    const emit = (event: AgentEvent) => this.events.push(event);
    this.mapper = new ClaudeEventMapper({ sessionId: opts.sessionId, cwd: opts.cwd, emit });
    this.broker = new ApprovalBroker(emit);
    this.autonomy = opts.autonomy;
    this.policy = new ClaudePolicy(
      opts.autonomy,
      {
        cwd: opts.cwd,
        extraRoots: opts.additionalDirectories,
        ...(opts.ownBranch ? { ownBranch: opts.ownBranch } : {}),
        ...(opts.codedenHome ? { codedenHome: opts.codedenHome } : {}),
        notesRoots:
          config.notesRoots ?? claudeNotesDirs({ cwd: opts.cwd, ...claudeHomes(opts.env) }),
      },
      opts.readOnly,
    );
    this.planMode = opts.planMode;
    this.policy.setPlanning(opts.planMode);
    this.mapper.start(opts.resumeToken);
    this.ensureQuery();
  }

  resumeToken(): string | undefined {
    return this.mapper.resumeToken ?? this.opts.resumeToken;
  }

  /**
   * Switch autonomy. The policy changes at once, so the next tool call (even in a running
   * turn) follows the new level; approvals already waiting stay waiting. The CLI's own
   * permission mode follows (`applyPermissionMode`), except while planning: the CLI stays in
   * `plan` and the new level applies once the plan is approved or plan mode is turned off.
   * Rejects when the CLI refuses the mode, so CodeDen keeps the change pending and sends it
   * again.
   */
  async setAutonomy(level: AutonomyLevel): Promise<void> {
    this.autonomy = level;
    this.policy.setAutonomy(level);
    if (!this.planMode) await this.applyPermissionMode();
  }

  /**
   * Turn plan mode on or off, from the next tool call. Off returns to the autonomy level.
   * CodeDen's policy follows at once. Rejects when the CLI refuses the mode; the change is never
   * skipped as already done, so sending it again (CodeDen keeps it pending) retries the CLI.
   */
  async setPlanMode(on: boolean): Promise<void> {
    this.planMode = on;
    this.policy.setPlanning(on);
    await this.applyPermissionMode();
  }

  /** Model/effort for the following turns, applied live through the SDK's streaming query. */
  async configure(change: SessionConfigChange): Promise<void> {
    const q = this.q;
    if (!q) return;
    if (change.model !== undefined) await q.setModel(explicitModel(change.model));
    if (change.effort !== undefined) {
      await q.applyFlagSettings({ effortLevel: claudeEffort(change.effort ?? undefined) ?? null });
    }
  }

  async send(input: UserInput): Promise<void> {
    if (this.closed) throw new ProviderSessionError("closed", "Session is closed");
    if (this.mapper.turnId)
      throw new ProviderSessionError("turn_running", "A turn is already running");
    const message = toSdkUserMessage(input);
    const prompts = this.ensureQuery();
    this.steered.clear();
    const turnId = this.mapper.beginTurn();
    this.emitUserMessage(turnId, input);
    prompts.push(message);
  }

  /** Queue input into the running turn; the CLI folds it in at the next tool boundary. */
  async steer(input: UserInput): Promise<void> {
    const turnId = this.mapper.turnId;
    if (!turnId || !this.prompts) throw new ProviderSessionError("no_turn", "No turn is running");
    const message = toSdkUserMessage(input);
    // A uuid lets a Stop cancel it while it still waits in the CLI's queue.
    const uuid = randomUUID();
    this.steered.add(uuid);
    this.emitUserMessage(turnId, input);
    this.prompts.push({ ...message, uuid });
  }

  /**
   * Stop the running turn. Messages steered into it that the CLI hasn't read yet are cancelled
   * with it, so they can't start a new turn after the Stop. If the CLI doesn't confirm in time
   * (or never answers the interrupt at all), the turn is closed as interrupted anyway.
   */
  async interrupt(): Promise<void> {
    const turnId = this.mapper.turnId;
    if (!turnId) return;
    this.mapper.requestInterrupt();
    this.broker.cancelAll();
    const q = this.q as InterruptibleQuery | undefined;
    await interruptWithDeadline(
      async () => {
        const receipt = await q?.interrupt({ cancelQueued: true });
        this.noteCancelled(turnId, receipt?.cancelled ?? []);
      },
      this.config.interruptTimeoutMs ?? 10_000,
      () => {
        if (this.mapper.turnId === turnId)
          this.mapper.endTurn({ type: "interrupted", reason: "user" });
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
    this.mapper.closeAll();
    this.prompts?.close();
    try {
      this.q?.close();
    } catch {
      this.abort?.abort();
    }
    this.events.close();
  }

  // ---------------------------------------------------------------- internals

  /**
   * Put the CLI in the permission mode for the current level and plan state. Without a running
   * CLI there is nothing to do: the next query starts in that mode. When the CLI refuses
   * `bypassPermissions` (it needs a launch flag), `acceptEdits` serves, as CodeDen's policy
   * decides through the PreToolUse hook and `canUseTool` either way. Any other refusal, or a
   * refused fallback, rejects.
   */
  private async applyPermissionMode(): Promise<void> {
    const q = this.q;
    if (!q) return;
    const mode = permissionModeFor(this.autonomy, this.planMode);
    try {
      await q.setPermissionMode(mode);
    } catch (error) {
      if (mode !== "bypassPermissions") throw error;
      await q.setPermissionMode("acceptEdits");
    }
  }

  /** The plan was approved: implement at the session's level, and tell CodeDen. */
  private leavePlanMode(toolUseId: string): void {
    this.planExitToolUseId = toolUseId;
    if (!this.planMode) return;
    this.planMode = false;
    this.policy.setPlanning(false);
    this.events.push({ type: "session.updated", planMode: false });
  }

  /**
   * Once the approved ExitPlanMode call has run, set the permission level again, in case the
   * CLI picked its own mode on the way out of `plan`.
   */
  private afterMessage(message: unknown): void {
    const id = this.planExitToolUseId;
    if (!id || !carriesToolResult(message, id)) return;
    this.planExitToolUseId = undefined;
    // Only a guard: the CLI already took the level's mode with the approval.
    if (!this.planMode) void this.applyPermissionMode().catch(() => {});
  }

  /** Say in the transcript when a Stop dropped steered messages the agent never read. */
  private noteCancelled(turnId: string, cancelled: string[]): void {
    const count = cancelled.filter((uuid) => this.steered.has(uuid)).length;
    if (count === 0 || this.mapper.turnId !== turnId) return;
    this.mapper.item({ threadId: this.mapper.rootThreadId, turnId }, "item.completed", {
      id: `cancelled-${turnId}`,
      kind: "notice",
      status: "completed",
      level: "info",
      code: "queued_messages_cancelled",
      message:
        count === 1
          ? "Stopped before the agent read your last message; it was not delivered."
          : `Stopped before the agent read your last ${count} messages; they were not delivered.`,
    });
  }

  private emitUserMessage(turnId: string, input: UserInput): void {
    this.mapper.item({ threadId: this.mapper.rootThreadId, turnId }, "item.completed", {
      id: `user-${turnId}-${Date.now().toString(36)}`,
      kind: "user_message",
      status: "completed",
      input,
    });
  }

  private ensureQuery(): AsyncQueue<SDKUserMessage> {
    if (this.q && this.prompts) return this.prompts;
    const prompts = new AsyncQueue<SDKUserMessage>();
    const abort = new AbortController();
    const preToolUse = policyHook(this.policy, this.shell);
    const q = this.config.query({
      prompt: prompts,
      options: buildQueryOptions({
        session: { ...this.opts, autonomy: this.autonomy, planMode: this.planMode },
        executable: this.config.executable,
        canUseTool: this.canUseTool,
        hooks: { PreToolUse: [{ hooks: [preToolUse] }] },
        abortController: abort,
        resume: this.resumeToken(),
        stderr: (data) => {
          this.stderrTail = (this.stderrTail + data).slice(-4000);
        },
      }),
    });
    this.q = q;
    this.prompts = prompts;
    this.abort = abort;
    void this.pump(q);
    // The composer's `/` menu lists what Claude Code would run (built-in commands included).
    q.supportedCommands().then(
      (commands) => this.mapper.reportCommands(commands),
      () => {},
    );
    if (this.config.onModels) {
      q.supportedModels().then(this.config.onModels, () => {});
    }
    return prompts;
  }

  private async pump(q: Query): Promise<void> {
    let failure: unknown;
    try {
      for await (const message of q) {
        this.mapper.handle(message);
        this.afterMessage(message);
      }
    } catch (error) {
      failure = error;
    }
    if (this.q === q) {
      this.q = undefined;
      this.prompts = undefined;
    }
    if (this.closed) return;
    this.broker.cancelAll();
    if (this.mapper.turnId) {
      const message =
        failure instanceof Error ? failure.message : "Claude Code exited unexpectedly";
      this.mapper.endTurn({
        type: "failed",
        error: {
          code: "provider_exited",
          message,
          retryable: true,
          // The next message starts Claude Code again and resumes the conversation.
          kind: "transient",
          ...(this.stderrTail ? { detail: this.stderrTail } : {}),
        },
      });
    }
  }

  private readonly canUseTool: CanUseTool = async (toolName, input, options) => {
    if (toolName === QUESTION_TOOL) {
      const deps = { broker: this.broker, mapper: this.mapper };
      return askQuestion(deps, input, options.toolUseID, options.signal);
    }
    if (toolName === PLAN_TOOL) return this.reviewPlan(input, options);
    const denied = this.policy.denial(toolName, input, this.shell.dir);
    if (denied) return { behavior: "deny", message: denied };
    const gate = this.policy.needsUser(toolName, input, this.shell.dir);
    if (!gate.ask) return { behavior: "allow", updatedInput: input };
    const ctx = this.mapper.ctxForTool(options.toolUseID);
    const item: ItemOf<"approval_request"> = {
      id: `approval-${options.requestId ?? options.toolUseID}`,
      kind: "approval_request",
      status: "in_progress",
      requestId: options.requestId ?? options.toolUseID,
      action: gate.action,
      title: approvalTitle(toolName, input),
      reason:
        options.decisionReason && options.decisionReason !== gate.reason
          ? `${gate.reason}. ${options.decisionReason}`
          : gate.reason,
      toolName,
      toolInput: toJson(input),
      toolCallItemId: options.toolUseID,
      options: ["allow_once", "allow_session", "deny"],
      ...(str(input, "command") ? { command: str(input, "command"), cwd: this.opts.cwd } : {}),
      ...(str(input, "file_path") ? { paths: [str(input, "file_path") as string] } : {}),
    };
    const response = await this.broker.request(ctx, item, options.signal);
    return this.toPermissionResult(toolName, input, response);
  };

  private toPermissionResult(
    toolName: string,
    input: Record<string, unknown>,
    response: RuntimeResponse,
  ): PermissionResult {
    if (response.kind === "approval" && response.decision !== "deny") {
      if (response.decision === "allow_session") {
        this.policy.allowForSession(toolName, input, this.shell.dir);
      }
      return { behavior: "allow", updatedInput: input };
    }
    if (response.kind === "approval") {
      return { behavior: "deny", message: response.message ?? "The user denied this action." };
    }
    return { behavior: "deny", message: "The request was cancelled.", interrupt: true };
  }

  /**
   * ExitPlanMode: show the plan and ask the user to approve it. Approving leaves plan mode at
   * the session's level; declining keeps Claude planning, with the user's note as feedback.
   * `bypassPermissions` is set after the tool has run (`afterMessage`), where a refusal can
   * fall back to `acceptEdits`.
   */
  private async reviewPlan(
    input: Record<string, unknown>,
    options: Parameters<CanUseTool>[2],
  ): Promise<PermissionResult> {
    const ctx = this.mapper.ctxForTool(options.toolUseID);
    const text = planText(input);
    if (text) {
      const id = `plan-${options.toolUseID}`;
      this.mapper.item(ctx, "item.completed", { id, kind: "plan", status: "completed", text });
    }
    const item = planApprovalItem(options.requestId ?? options.toolUseID, input);
    const response = await this.broker.request(ctx, item, options.signal);
    const level = permissionModeFor(this.autonomy, false);
    const mode = level === "bypassPermissions" ? "acceptEdits" : level;
    const result = planDecision(input, response, mode);
    if (result.behavior === "allow") this.leavePlanMode(options.toolUseID);
    return result;
  }
}

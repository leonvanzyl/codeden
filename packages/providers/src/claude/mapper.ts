import { randomUUID } from "node:crypto";
import type { AgentEvent, ErrorInfo, Item, Usage } from "@codeden/contracts";
import { str } from "../util/text";
import { toProviderCommands } from "./commands";
import { rejectedResetsAt, resultError, type TurnErrorSignals } from "./errors";
import { apiRetryNotice, compactedNotice, compactFailedNotice, compactingNotice } from "./notices";
import { StreamAssembler } from "./stream";
import { SubagentTracker, type ThreadCtx } from "./subagents";
import { ToolTracker } from "./tool-tracker";
import {
  contextTokensFromMessageUsage,
  turnDelta,
  usageFromRateLimit,
  usageFromResult,
} from "./usage";

type Raw = Record<string, unknown>;
type Block = Raw & { type?: string };

export type TurnOutcome =
  | { type: "completed"; stopReason?: string }
  | { type: "failed"; error: ErrorInfo }
  | { type: "interrupted"; reason: "user" | "runner_restart" | "provider" };

export interface MapperOptions {
  sessionId: string;
  cwd: string;
  emit: (event: AgentEvent) => void;
  newId?: () => string;
}

/**
 * Stateful translator from Claude Agent SDK messages to normalized `AgentEvent`s. Pure with
 * respect to I/O: the session feeds it SDK messages and turn boundaries; it emits events.
 * Root-thread text and tool input stream through `stream_event`s; the full `assistant`
 * message that follows completes the item.
 */
export class ClaudeEventMapper {
  readonly rootThreadId: string;
  private readonly emit: (event: AgentEvent) => void;
  private readonly newId: () => string;
  private readonly subagents: SubagentTracker;
  private readonly tools: ToolTracker;
  private rootTurnId: string | undefined;
  private readonly stream: StreamAssembler;
  private contextTokens: number | undefined;
  private interruptRequested = false;
  private claudeSessionId: string | undefined;
  private model: string | undefined;
  /** Running usage total of this query (process), from the latest `result`. */
  private queryTotal: Usage | undefined;
  /** `queryTotal` when the current root turn began. */
  private turnBaseline: Usage | undefined;
  /** The "compacting" notice that the compaction's outcome replaces. */
  private compactNoticeId: string | undefined;
  /** The notice of the current run of API retries. */
  private retryNoticeId: string | undefined;
  /** What the current turn said about a failure, for classifying it (`errors.ts`). */
  private signals: TurnErrorSignals = {};
  /**
   * The `uuid` of the current root turn's last main-chain transcript message (an `assistant`
   * or `user` message without `parent_tool_use_id`): the turn's fork point, where
   * `forkSession({ upToMessageId })` ends a copy that keeps this turn and no later one.
   */
  private lastChainUuid: string | undefined;
  /** The `/` command list last reported, so an unchanged list isn't sent again. */
  private commandsKey: string | undefined;

  constructor(opts: MapperOptions) {
    this.rootThreadId = `${opts.sessionId}:thread-root`;
    this.emit = opts.emit;
    this.newId = opts.newId ?? randomUUID;
    this.subagents = new SubagentTracker(opts.sessionId, this.emit, this.newId, (ctx, ok) =>
      this.tools.finishTurn(ctx, ok),
    );
    this.tools = new ToolTracker(
      opts.cwd,
      (ctx, phase, item) => this.item(ctx, phase, item),
      this.subagents,
      this.newId,
    );
    this.stream = new StreamAssembler({
      rootCtx: () => this.rootCtx(),
      emit: this.emit,
      item: (ctx, phase, item) => this.item(ctx, phase, item),
      tools: this.tools,
      newId: this.newId,
    });
  }

  get turnId(): string | undefined {
    return this.rootTurnId;
  }

  get resumeToken(): string | undefined {
    return this.claudeSessionId;
  }

  /**
   * Report the session's `/` commands (from `supportedCommands()` or a `commands_changed`
   * push) as `session.updated { commands }`, when they differ from the last list reported.
   */
  reportCommands(commands: unknown): void {
    const list = toProviderCommands(commands);
    const key = JSON.stringify(list);
    if (key === this.commandsKey) return;
    this.commandsKey = key;
    this.emit({ type: "session.updated", commands: list });
  }

  /** Emit `thread.started` for the root thread (once, at session open). */
  start(resumeToken?: string): void {
    this.emit({ type: "thread.started", thread: { id: this.rootThreadId } });
    if (resumeToken) {
      this.claudeSessionId = resumeToken;
      this.emit({ type: "session.updated", resumeToken });
    }
  }

  /** Begin a root turn (no-op if one is running). Returns its id. */
  beginTurn(): string {
    if (this.rootTurnId) return this.rootTurnId;
    const turnId = this.newId();
    this.rootTurnId = turnId;
    this.turnBaseline = this.queryTotal;
    this.signals = {};
    this.lastChainUuid = undefined;
    this.emit({ type: "turn.started", threadId: this.rootThreadId, turnId });
    return turnId;
  }

  /** Root context for the current turn, starting an implicit turn if the CLI began one itself. */
  private rootCtx(): ThreadCtx {
    return { threadId: this.rootThreadId, turnId: this.beginTurn() };
  }

  /** Thread/turn of the thread a message belongs to (`parent_tool_use_id`). */
  private ctxFor(parentToolUseId: unknown): ThreadCtx {
    if (typeof parentToolUseId === "string" && parentToolUseId) {
      const child = this.subagents.ctx(parentToolUseId);
      if (child) return child;
    }
    return this.rootCtx();
  }

  /** Thread/turn of a tool call by its `tool_use` id (for approvals). */
  ctxForTool(toolUseId: string): ThreadCtx {
    return this.tools.ctx(toolUseId) ?? this.rootCtx();
  }

  /** Emit an item event in a context. */
  item(
    ctx: ThreadCtx,
    phase: "item.started" | "item.updated" | "item.completed",
    item: Item,
  ): void {
    this.emit({ type: phase, threadId: ctx.threadId, turnId: ctx.turnId, item });
  }

  /** Feed one SDK message. */
  handle(message: unknown): void {
    const msg = message as Raw;
    switch (msg.type) {
      case "stream_event":
        if (!msg.parent_tool_use_id) this.stream.onEvent(msg.event as Raw);
        return;
      case "assistant":
        this.onAssistant(msg);
        this.noteChainMessage(msg);
        return;
      case "user":
        this.onUser(msg);
        this.noteChainMessage(msg);
        return;
      case "system":
        this.onSystem(msg);
        return;
      case "rate_limit_event": {
        const resetsAt = rejectedResetsAt(msg);
        if (resetsAt) this.signals.rejectedResetsAt = resetsAt;
        const usage = usageFromRateLimit(msg);
        if (usage) {
          this.emit({
            type: "usage.updated",
            threadId: this.rootThreadId,
            turnId: this.rootTurnId,
            usage,
          });
        }
        return;
      }
      case "result":
        this.onResult(msg);
        return;
      default:
        return;
    }
  }

  // ------------------------------------------------------------ full messages

  /** Keep a root turn's latest main-chain message as its fork point (subagents' don't count). */
  private noteChainMessage(msg: Raw): void {
    if (msg.parent_tool_use_id || !this.rootTurnId) return;
    const uuid = str(msg, "uuid");
    if (uuid) this.lastChainUuid = uuid;
  }

  private onAssistant(msg: Raw): void {
    const message = (msg.message ?? {}) as Raw;
    const ctx = this.ctxFor(msg.parent_tool_use_id);
    const isRoot = !msg.parent_tool_use_id;
    const messageId = str(message, "id") ?? this.newId();
    if (isRoot)
      this.contextTokens = contextTokensFromMessageUsage(message.usage) ?? this.contextTokens;
    const content = Array.isArray(message.content) ? (message.content as Block[]) : [];
    for (const block of content) {
      if (
        block.type === "text" ||
        block.type === "thinking" ||
        block.type === "redacted_thinking"
      ) {
        const type = block.type === "text" ? "text" : "thinking";
        const sb = isRoot ? this.stream.claim(messageId, type) : undefined;
        const id = sb?.itemId ?? `${messageId}:${this.newId().slice(0, 8)}`;
        if (sb) sb.completed = true;
        if (type === "text") {
          const text = str(block, "text") ?? sb?.text ?? "";
          this.item(ctx, "item.completed", {
            id,
            kind: "assistant_message",
            status: "completed",
            text,
          });
        } else {
          const text = str(block, "thinking") ?? "";
          this.item(ctx, "item.completed", {
            id,
            kind: "reasoning",
            status: "completed",
            text,
            ...(text ? {} : { redacted: true }),
          });
        }
      } else if (block.type === "tool_use" || block.type === "server_tool_use") {
        if (isRoot) this.stream.claim(messageId, "tool_use");
        const id = str(block, "id");
        const raw = str(block, "name");
        const name = block.type === "server_tool_use" && raw === "web_search" ? "WebSearch" : raw;
        const input = (block.input && typeof block.input === "object" ? block.input : {}) as Raw;
        if (id && name) this.tools.onToolUse(ctx, id, name, input);
      } else if (
        typeof block.type === "string" &&
        block.type.endsWith("_tool_result") &&
        typeof block.tool_use_id === "string"
      ) {
        this.tools.onToolResult(
          block.tool_use_id,
          block.content,
          block.type.includes("error"),
          undefined,
        );
      }
    }
    const error = str(msg, "error");
    if (error && !msg.aborted) {
      if (isRoot) this.signals.assistantError = error;
      const text = content
        .map((b) => str(b, "text") ?? "")
        .join("")
        .trim();
      this.item(ctx, "item.completed", {
        id: this.newId(),
        kind: "error",
        status: "completed",
        error: {
          code: error,
          message: text || `Claude reported an error: ${error}`,
          retryable: error === "rate_limit" || error === "overloaded" || error === "server_error",
        },
      });
    }
  }

  private onUser(msg: Raw): void {
    const message = (msg.message ?? {}) as Raw;
    if (!Array.isArray(message.content)) return;
    for (const block of message.content as Block[]) {
      if (block.type === "tool_result" && typeof block.tool_use_id === "string") {
        this.tools.onToolResult(
          block.tool_use_id,
          block.content,
          block.is_error === true,
          msg.tool_use_result,
        );
      }
    }
  }

  private onSystem(msg: Raw): void {
    if (msg.subtype === "init") {
      const sessionId = str(msg, "session_id");
      const model = str(msg, "model");
      if (sessionId !== this.claudeSessionId || model !== this.model) {
        this.claudeSessionId = sessionId ?? this.claudeSessionId;
        this.model = model ?? this.model;
        this.emit({
          type: "session.updated",
          resumeToken: this.claudeSessionId,
          model: this.model,
        });
      }
    } else if (msg.subtype === "commands_changed") {
      this.reportCommands(msg.commands);
    } else if (msg.subtype === "task_started") {
      this.subagents.onTaskStarted(msg);
    } else if (msg.subtype === "task_notification") {
      this.subagents.onTaskNotification(msg);
    } else if (msg.subtype === "compact_boundary") {
      this.item(this.rootCtx(), "item.completed", compactedNotice(this.takeCompactNoticeId()));
    } else if (msg.subtype === "api_retry") {
      // One notice per run of retries, updated in place as the attempts go up.
      if (msg.attempt === 1 || !this.retryNoticeId) this.retryNoticeId = `retrying-${this.newId()}`;
      this.item(this.rootCtx(), "item.completed", apiRetryNotice(msg, this.retryNoticeId));
    } else if (msg.subtype === "status") {
      if (msg.status === "compacting" && !this.compactNoticeId) {
        this.compactNoticeId = this.newId();
        this.item(this.rootCtx(), "item.completed", compactingNotice(this.compactNoticeId));
      } else if (msg.compact_result === "failed") {
        const notice = compactFailedNotice(this.takeCompactNoticeId(), msg);
        this.item(this.rootCtx(), "item.completed", notice);
      }
    }
  }

  /** The id of the "compacting" notice to replace, or a fresh one. */
  private takeCompactNoticeId(): string {
    const id = this.compactNoticeId ?? this.newId();
    this.compactNoticeId = undefined;
    return id;
  }

  /** The user pressed stop: the next `result` ends the turn as interrupted. */
  requestInterrupt(): void {
    if (this.rootTurnId) this.interruptRequested = true;
  }

  private onResult(msg: Raw): void {
    if (!this.rootTurnId) return;
    // `result` carries running totals for the whole query; report this turn's own share.
    const total = usageFromResult(msg, this.contextTokens);
    this.queryTotal = total;
    this.emit({
      type: "usage.updated",
      threadId: this.rootThreadId,
      turnId: this.rootTurnId,
      usage: turnDelta(total, this.turnBaseline),
    });
    if (this.interruptRequested) {
      this.endTurn({ type: "interrupted", reason: "user" });
      return;
    }
    // Queued (steered) input that ran as its own CLI turn still belongs to this CodeDen turn.
    if (typeof msg.queued_turn_count === "number" && msg.queued_turn_count > 0) return;
    const subtype = str(msg, "subtype");
    if (subtype === "success" && msg.is_error !== true) {
      this.endTurn({ type: "completed", stopReason: str(msg, "stop_reason") ?? "end_turn" });
      return;
    }
    this.endTurn({ type: "failed", error: resultError(msg, this.signals) });
  }

  /** Close the root turn: finish dangling items and emit the terminal turn event. */
  endTurn(outcome: TurnOutcome): void {
    const turnId = this.rootTurnId;
    if (!turnId) return;
    const ctx = { threadId: this.rootThreadId, turnId };
    const status = outcome.type === "completed" ? "completed" : "cancelled";
    this.stream.finish(status, (item) => this.item(ctx, "item.completed", item));
    if (outcome.type !== "completed") this.subagents.interruptForeground(turnId);
    this.tools.finishTurn(ctx, outcome.type === "completed");
    this.rootTurnId = undefined;
    this.interruptRequested = false;
    const end = { ...ctx, ...(this.lastChainUuid ? { forkPoint: this.lastChainUuid } : {}) };
    this.lastChainUuid = undefined;
    if (outcome.type === "completed") {
      this.emit({ type: "turn.completed", ...end, stopReason: outcome.stopReason });
    } else if (outcome.type === "failed") {
      this.emit({ type: "turn.failed", ...end, error: outcome.error });
    } else {
      this.emit({ type: "turn.interrupted", ...end, reason: outcome.reason });
    }
  }

  /** Session closing: end the running turn and any still-running subagent threads. */
  closeAll(): void {
    if (this.rootTurnId) this.endTurn({ type: "interrupted", reason: "user" });
    this.subagents.interruptAll();
  }
}

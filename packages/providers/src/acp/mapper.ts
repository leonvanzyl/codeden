import { randomUUID } from "node:crypto";
import type {
  AgentEvent,
  GeneratedImage,
  Item,
  ItemOf,
  JsonValue,
  ProviderCommand,
  Usage,
  UserInput,
} from "@codeden/contracts";
import { count as int } from "../util/text";
import type { AcpTurnOutcome } from "./errors";
import {
  type AcpToolContext,
  type AcpToolState,
  blockText,
  mergeToolCall,
  toolCallItem,
} from "./items";
import type {
  AcpConfigOption,
  AcpPlanEntry,
  AcpPromptResult,
  AcpSessionUpdate,
  AcpToolCall,
} from "./protocol";
import { mergeTodos, planTodos, type Todo } from "./todos";

export { planTodos, type Todo, todoStatus } from "./todos";

/** Where an item lives. */
export interface ThreadCtx {
  threadId: string;
  turnId: string;
}

export interface AcpMapperOptions {
  sessionId: string;
  emit: (event: AgentEvent) => void;
  tools: AcpToolContext;
  /** The thread it writes to; default the session's root thread. */
  threadId?: string;
  /**
   * A subagent's child session: its mode, config, command and usage updates are its own and
   * never change the CodeDen session.
   */
  child?: boolean;
  /** The agent switched mode on its own (`current_mode_update`). */
  onMode?: (modeId: string) => void;
  /** The agent's config options changed (`config_option_update`). */
  onConfigOptions?: (options: AcpConfigOption[]) => void;
  /** The turn is about to end (`ok`: it completed): close what hangs off it first. */
  beforeEnd?: (ok: boolean) => void;
  /** A tool call finished (completed or failed). */
  onToolDone?: (state: AcpToolState) => void;
}

/** Updates that describe the whole session, ignored from a subagent's child session. */
const SESSION_WIDE = new Set([
  "current_mode_update",
  "config_option_update",
  "available_commands_update",
  "usage_update",
]);

/**
 * Translates one ACP session's `session/update` notifications into normalized `AgentEvent`s
 * (§7.3). A CodeDen turn is one `session/prompt`; message and thought chunks stream into
 * items that close when something else starts, tool calls are upserted by `toolCallId`, and
 * the agent's plan becomes the turn's todo list. Updates outside a turn (the history replay of
 * `session/load`) are dropped: CodeDen keeps its own transcript. A subagent's child session
 * has a mapper of its own, writing to its child thread.
 */
export class AcpEventMapper {
  readonly threadId: string;
  /** While `session/load` replays the history: every update is dropped. */
  replaying = false;
  private turnId: string | undefined;
  private text: { id: string; kind: "assistant_message" | "reasoning"; text: string } | undefined;
  private seq = 0;
  private readonly tools = new Map<string, AcpToolState>();
  private todos: { ctx: ThreadCtx; item: ItemOf<"todo_list"> } | undefined;
  private usage: Usage = {};
  /** The agent's cumulative cost when the turn started, to report the turn's own share. */
  private costAtStart: number | undefined;
  private lastCost: number | undefined;

  constructor(private readonly opts: AcpMapperOptions) {
    this.threadId = opts.threadId ?? `${opts.sessionId}:thread-root`;
  }

  get currentTurnId(): string | undefined {
    return this.turnId;
  }

  /** The current turn's context, while one runs. */
  ctx(): ThreadCtx | undefined {
    return this.turnId ? { threadId: this.threadId, turnId: this.turnId } : undefined;
  }

  /** A tool call of this turn that has started and not finished yet. */
  hasOpenTool(toolCallId: string): boolean {
    const status = this.tools.get(toolCallId)?.status;
    return this.tools.has(toolCallId) && status !== "completed" && status !== "failed";
  }

  /**
   * The item id of a tool call: scoped to its turn, since an agent may reuse a call id in a
   * later turn and item ids are unique per session.
   */
  toolItemId(toolCallId: string): string {
    return `${this.turnId ?? "turn"}:${toolCallId}`;
  }

  /** What is known about a tool call (for permission requests), merged with `call`. */
  tool(call: AcpToolCall): AcpToolState {
    const known = this.tools.get(call.toolCallId);
    const state: AcpToolState = known ? { ...known } : { toolCallId: call.toolCallId };
    mergeToolCall(state, call);
    return state;
  }

  beginTurn(turnId: string): void {
    if (this.turnId) this.endTurn({ type: "interrupted" });
    this.turnId = turnId;
    this.usage = {};
    this.costAtStart = this.lastCost;
    this.opts.emit({ type: "turn.started", threadId: this.threadId, turnId });
  }

  handle(update: AcpSessionUpdate): void {
    if (this.replaying) return;
    const kind = update.sessionUpdate;
    if (this.opts.child && SESSION_WIDE.has(kind)) return;
    if (kind === "current_mode_update") {
      const mode = (update as { currentModeId?: unknown }).currentModeId;
      if (typeof mode === "string") this.opts.onMode?.(mode);
      return;
    }
    if (kind === "config_option_update") {
      const options = (update as { configOptions?: unknown }).configOptions;
      if (Array.isArray(options)) this.opts.onConfigOptions?.(options as AcpConfigOption[]);
      return;
    }
    if (kind === "available_commands_update") {
      this.commands(update as { availableCommands?: unknown });
      return;
    }
    if (kind === "usage_update") {
      this.usageUpdate(update as { used?: unknown; size?: unknown; cost?: unknown });
      return;
    }
    const ctx = this.ctx();
    if (!ctx) return; // Replayed history, or a late update after the turn ended.
    switch (kind) {
      case "agent_message_chunk":
      case "agent_thought_chunk":
        this.chunk(ctx, kind === "agent_thought_chunk" ? "reasoning" : "assistant_message", update);
        return;
      case "tool_call":
      case "tool_call_update":
        this.toolCall(ctx, update as AcpToolCall);
        return;
      case "plan": {
        const entries = (update as { entries?: unknown }).entries;
        if (Array.isArray(entries)) this.setTodos(planTodos(entries as AcpPlanEntry[]), false);
        return;
      }
      default:
        return; // user_message_chunk (CodeDen records prompts itself) and unknown kinds.
    }
  }

  /** Replace (or, with `merge`, update by id) the turn's todo list. */
  setTodos(todos: Todo[], merge: boolean): void {
    const ctx = this.todos?.ctx ?? this.ctx();
    if (!ctx) return;
    if (this.todos) {
      const next = merge ? mergeTodos(this.todos.item.todos, todos) : todos;
      this.todos.item = { ...this.todos.item, todos: next };
      this.opts.emit({ type: "item.updated", ...ctx, item: this.todos.item });
      return;
    }
    this.closeText();
    const item: ItemOf<"todo_list"> = {
      id: `todos-${ctx.turnId}`,
      kind: "todo_list",
      status: "in_progress",
      todos,
    };
    this.todos = { ctx, item };
    this.opts.emit({ type: "item.started", ...ctx, item });
  }

  /** Add the token counts a `session/prompt` result reports. */
  promptUsage(usage: AcpPromptResult["usage"]): void {
    if (!usage || !this.turnId) return;
    const cached = int(usage.cachedReadTokens);
    const input = int(usage.inputTokens);
    this.usage = {
      ...this.usage,
      ...(input !== undefined
        ? { inputTokens: Math.max(0, input - (cached ?? 0) - (int(usage.cachedWriteTokens) ?? 0)) }
        : {}),
      ...(int(usage.outputTokens) !== undefined ? { outputTokens: int(usage.outputTokens) } : {}),
      ...(cached !== undefined ? { cachedInputTokens: cached } : {}),
      ...(int(usage.cachedWriteTokens) !== undefined
        ? { cacheWriteTokens: int(usage.cachedWriteTokens) }
        : {}),
      ...(int(usage.thoughtTokens) !== undefined
        ? { reasoningTokens: int(usage.thoughtTokens) }
        : {}),
    };
    this.emitUsage();
  }

  /** The message CodeDen sent, as the turn's user message (ACP doesn't echo prompts). */
  userMessage(input: UserInput): void {
    this.emitItem({ id: `user-${randomUUID()}`, kind: "user_message", status: "completed", input });
  }

  /** A finished item in the current turn (after any message that was streaming). */
  emitItem(item: Item): void {
    const ctx = this.ctx();
    if (!ctx) return;
    this.closeText();
    this.opts.emit({ type: "item.completed", ...ctx, item });
  }

  /** Start an item in the current turn (after any message that was streaming); its context. */
  startItem(item: Item): ThreadCtx | undefined {
    const ctx = this.ctx();
    if (!ctx) return undefined;
    this.closeText();
    this.opts.emit({ type: "item.started", ...ctx, item });
    return ctx;
  }

  /**
   * Images a tool call created: they go on the agent's own call with that id while it runs
   * (shown once it completes), else on a finished call of their own (§7.3 `generatedImages`).
   */
  imagesCreated(toolCallId: string, images: GeneratedImage[], input: JsonValue): void {
    const ctx = this.ctx();
    if (!ctx || !images.length) return;
    const state = this.tools.get(toolCallId);
    if (state && this.hasOpenTool(toolCallId)) {
      state.generatedImages = images;
      const item = toolCallItem(state, this.opts.tools, this.toolItemId(toolCallId));
      this.opts.emit({ type: "item.updated", ...ctx, item });
      return;
    }
    this.emitItem({
      id: this.toolItemId(`image-${toolCallId}`),
      kind: "tool_call",
      toolKind: "other",
      status: "completed",
      toolName: "generate_image",
      title: "Generate image",
      input,
      generatedImages: images,
    });
  }

  /** A notice in the current turn. */
  notice(level: "info" | "warning", message: string, code: string): void {
    const ctx = this.ctx();
    if (!ctx) return;
    this.emitItem({
      id: `${code}-${ctx.turnId}-${++this.seq}`,
      kind: "notice",
      status: "completed",
      level,
      code,
      message,
    });
  }

  /** Close the current turn: open items complete (or cancel), then the turn ends. */
  endTurn(outcome: AcpTurnOutcome): void {
    const turnId = this.turnId;
    if (!turnId) return;
    const ok = outcome.type === "completed";
    this.opts.beforeEnd?.(ok);
    this.closeText();
    const ctx = { threadId: this.threadId, turnId };
    for (const state of this.tools.values()) {
      if (state.status === "completed" || state.status === "failed") continue;
      const item = toolCallItem(state, this.opts.tools, this.toolItemId(state.toolCallId));
      this.opts.emit({
        type: "item.completed",
        ...ctx,
        item: { ...item, status: ok ? "completed" : "cancelled" } as Item,
      });
    }
    this.tools.clear();
    if (this.todos) {
      const status = ok ? "completed" : "cancelled";
      this.opts.emit({
        type: "item.completed",
        ...this.todos.ctx,
        item: { ...this.todos.item, status },
      });
      this.todos = undefined;
    }
    this.turnId = undefined;
    if (outcome.type === "completed") {
      this.opts.emit({
        type: "turn.completed",
        ...ctx,
        stopReason: outcome.stopReason ?? "end_turn",
      });
    } else if (outcome.type === "interrupted") {
      this.opts.emit({ type: "turn.interrupted", ...ctx, reason: outcome.reason ?? "user" });
    } else {
      this.opts.emit({
        type: "turn.failed",
        ...ctx,
        error: {
          code: outcome.code ?? "turn_failed",
          message: outcome.message,
          ...(outcome.detail ? { detail: outcome.detail } : {}),
          ...(outcome.kind ? { kind: outcome.kind } : {}),
        },
      });
    }
  }

  // ---------------------------------------------------------------- internals

  private chunk(
    ctx: ThreadCtx,
    kind: "assistant_message" | "reasoning",
    update: AcpSessionUpdate,
  ): void {
    const text = blockText((update as { content?: never }).content);
    if (!text) return;
    if (this.text?.kind !== kind) {
      this.closeText();
      const id = `${kind === "reasoning" ? "reasoning" : "message"}-${ctx.turnId}-${++this.seq}`;
      this.text = { id, kind, text: "" };
      this.opts.emit({
        type: "item.started",
        ...ctx,
        item: { id, kind, status: "in_progress", text: "" },
      });
    }
    this.text.text += text;
    this.opts.emit({
      type: "item.delta",
      ...ctx,
      itemId: this.text.id,
      delta: { type: "text", text },
    });
  }

  /** Complete the streaming message or thought, if any. */
  private closeText(): void {
    const open = this.text;
    const ctx = this.ctx() ?? this.todos?.ctx;
    this.text = undefined;
    if (!open || !ctx) return;
    this.opts.emit({
      type: "item.completed",
      ...ctx,
      item: { id: open.id, kind: open.kind, status: "completed", text: open.text },
    });
  }

  private toolCall(ctx: ThreadCtx, call: AcpToolCall): void {
    if (typeof call.toolCallId !== "string" || !call.toolCallId) return;
    const known = this.tools.get(call.toolCallId);
    const state: AcpToolState = known ?? { toolCallId: call.toolCallId, startedAt: Date.now() };
    mergeToolCall(state, call);
    this.tools.set(call.toolCallId, state);
    if (!known) this.closeText();
    const done = state.status === "completed" || state.status === "failed";
    const finished = done && state.endedAt === undefined;
    if (done) state.endedAt ??= Date.now();
    const item = toolCallItem(state, this.opts.tools, this.toolItemId(state.toolCallId));
    const type = done ? "item.completed" : known ? "item.updated" : "item.started";
    if (done && !known)
      this.opts.emit({ type: "item.started", ...ctx, item: { ...item, status: "in_progress" } });
    this.opts.emit({ type, ...ctx, item });
    if (finished) this.opts.onToolDone?.(state);
  }

  private commands(update: { availableCommands?: unknown }): void {
    if (!Array.isArray(update.availableCommands)) return;
    const commands: ProviderCommand[] = [];
    for (const c of update.availableCommands as { name?: unknown; description?: unknown }[]) {
      if (typeof c?.name !== "string" || !c.name) continue;
      commands.push({
        name: c.name.replace(/^\//, ""),
        description: typeof c.description === "string" ? c.description : "",
      });
    }
    this.opts.emit({ type: "session.updated", commands });
  }

  private usageUpdate(update: { used?: unknown; size?: unknown; cost?: unknown }): void {
    const cost = update.cost as { amount?: unknown; currency?: unknown } | null | undefined;
    if (typeof cost?.amount === "number" && (!cost.currency || cost.currency === "USD")) {
      this.lastCost = cost.amount;
      if (this.turnId) {
        this.usage.costUsd = Math.max(0, cost.amount - (this.costAtStart ?? 0));
      }
    }
    const used = int(update.used);
    const size = int(update.size);
    if (used !== undefined) this.usage.contextTokens = used;
    if (size !== undefined && size > 0) this.usage.contextWindow = size;
    this.emitUsage();
  }

  private emitUsage(): void {
    if (!Object.keys(this.usage).length) return;
    this.opts.emit({
      type: "usage.updated",
      threadId: this.threadId,
      ...(this.turnId ? { turnId: this.turnId } : {}),
      usage: { ...this.usage },
    });
  }
}

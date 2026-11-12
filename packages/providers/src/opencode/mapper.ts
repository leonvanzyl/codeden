import type { AgentEvent, Item, ItemOf } from "@codeden/contracts";
import { shorten } from "../util/text";
import { modelId } from "./config";
import { failure, type TurnOutcome } from "./errors";
import {
  contentText,
  diffsOf,
  subagentSummary,
  type ToolMapContext,
  type ToolState,
  todosOf,
  toolCallItem,
} from "./items";
import type { OcEvent, OcEventOf } from "./protocol";
import { OpenCodeSubagents, type ThreadCtx } from "./subagents";
import { TurnUsage } from "./usage";

export type { ThreadCtx };

export interface MapperOptions {
  sessionId: string;
  emit: (event: AgentEvent) => void;
  tools: ToolMapContext;
  /** Context window of a model (CodeDen id), for usage. */
  contextWindow?: (model: string | undefined) => number | undefined;
}

/**
 * Translates OpenCode's v2 events for one session (and its subagent sessions) into normalized
 * `AgentEvent`s (§7.3). A CodeDen turn spans one OpenCode execution of the root session;
 * subagent sessions become child threads of the `subagent` item that started them.
 */
export class OpenCodeEventMapper {
  readonly rootThreadId: string;
  /** The OpenCode session id (also the resume token). */
  rootSession: string | undefined;
  /** Turn id the next execution of the root session opens (set by `send()`). */
  pendingTurnId: string | undefined;
  private turnId: string | undefined;
  private readonly ended = new Set<string>();
  private turnCount = 0;
  private usage: TurnUsage | undefined;
  private model: string | undefined;
  private readonly open = new Map<string, { ctx: ThreadCtx; item: Item }>();
  private readonly tools = new Map<string, ToolState & { session: string }>();
  private readonly subagents: OpenCodeSubagents;
  private todos: { id: string; ctx: ThreadCtx; item: ItemOf<"todo_list"> } | undefined;

  constructor(private readonly opts: MapperOptions) {
    this.rootThreadId = `${opts.sessionId}:thread-root`;
    this.subagents = new OpenCodeSubagents(opts.sessionId, opts.emit, (threadId, ok) =>
      this.closeOpen(ok, threadId),
    );
  }

  get currentTurnId(): string | undefined {
    return this.turnId;
  }

  /** The model the session runs (CodeDen id), once known. */
  get currentModel(): string | undefined {
    return this.model;
  }

  set currentModel(model: string | undefined) {
    this.model = model;
  }

  /** The thread context of an OpenCode session (root or subagent), while a turn runs. */
  ctxFor(session: string): ThreadCtx | undefined {
    if (session === this.rootSession) {
      return this.turnId ? { threadId: this.rootThreadId, turnId: this.turnId } : undefined;
    }
    return this.subagents.ctxFor(session);
  }

  /** The tool call a permission request or form belongs to. */
  tool(callId: string | undefined): ToolState | undefined {
    return callId ? this.tools.get(callId) : undefined;
  }

  /**
   * Start a turn by id. Idempotent, and a no-op for a turn that already ended. Consumes
   * `pendingTurnId` when it names this turn, so a later execution OpenCode starts on its own
   * (a late steer, a queued prompt) gets a turn of its own instead of this ended one.
   */
  beginTurn(turnId: string): void {
    if (this.pendingTurnId === turnId) this.pendingTurnId = undefined;
    if (this.turnId === turnId || this.ended.has(turnId)) return;
    if (this.turnId) this.endTurn({ type: "interrupted" });
    this.turnId = turnId;
    this.turnCount += 1;
    this.usage = new TurnUsage(this.opts.contextWindow?.(this.model));
    this.opts.emit({ type: "turn.started", threadId: this.rootThreadId, turnId });
  }

  handle(event: OcEvent): void {
    switch (event.type) {
      case "session.created":
        if (event.data.parentID) {
          this.subagents.onSessionCreated(event.data.sessionID, event.data.parentID);
        }
        return;
      case "session.execution.started":
        if (event.data.sessionID === this.rootSession) this.onExecutionStarted();
        return;
      case "session.execution.succeeded":
        if (event.data.sessionID === this.rootSession) this.endTurn({ type: "completed" });
        return;
      case "session.execution.failed":
        if (event.data.sessionID === this.rootSession) this.endTurn(failure(event.data.error));
        return;
      case "session.execution.interrupted":
        if (event.data.sessionID === this.rootSession) {
          this.endTurn({
            type: "interrupted",
            reason: event.data.reason === "user" ? "user" : "provider",
          });
        }
        return;
      case "session.step.started":
        if (event.data.sessionID === this.rootSession && event.data.model) {
          this.noteModel(modelId(event.data.model));
        }
        return;
      case "session.step.ended":
      case "session.step.failed":
        this.addUsage(event.data.sessionID, event.data.tokens, event.data.cost);
        return;
      case "session.compaction.ended":
        this.addUsage(event.data.sessionID, event.data.tokens, event.data.cost);
        this.notice(event.data.sessionID, "info", "Context compacted", "context_compacted");
        return;
      case "session.compaction.failed":
        this.addUsage(event.data.sessionID, event.data.tokens, event.data.cost);
        this.notice(
          event.data.sessionID,
          "warning",
          `Context compaction failed: ${event.data.error.message}`,
          "compaction_failed",
        );
        return;
      case "session.retry.scheduled":
        this.notice(
          event.data.sessionID,
          "warning",
          `Retrying (attempt ${event.data.attempt}): ${shorten(event.data.error.message, 200)}`,
          "retrying",
        );
        return;
      case "session.model.selected":
        if (event.data.sessionID === this.rootSession) this.noteModel(modelId(event.data.model));
        return;
      case "session.text.started":
      case "session.reasoning.started":
        this.startText(event);
        return;
      case "session.text.delta":
      case "session.reasoning.delta":
        this.deltaText(event);
        return;
      case "session.text.ended":
      case "session.reasoning.ended":
        this.endText(event);
        return;
      case "session.tool.input.started":
        this.onToolInput(event);
        return;
      case "session.tool.called":
        this.onToolCalled(event);
        return;
      case "session.tool.progress":
        this.subagents.onProgress(event.data.id, event.data.metadata);
        return;
      case "session.tool.success":
      case "session.tool.failed":
        this.onToolEnded(event);
        return;
      default:
        return;
    }
  }

  /** Remember file diffs a permission request showed for a tool call. */
  noteDiffs(callId: string | undefined, metadata: Record<string, unknown> | undefined): void {
    const state = callId ? this.tools.get(callId) : undefined;
    const diffs = diffsOf(metadata);
    if (state && diffs) state.diffs = diffs;
  }

  /** Close the current turn (also when the server dies or the session closes). */
  endTurn(outcome: TurnOutcome): void {
    const turnId = this.turnId;
    if (!turnId) return;
    const ok = outcome.type === "completed";
    this.subagents.endTurn(ok);
    this.closeOpen(ok);
    if (this.todos) {
      this.opts.emit({
        type: "item.completed",
        ...this.todos.ctx,
        item: { ...this.todos.item, status: ok ? "completed" : "cancelled" },
      });
      this.todos = undefined;
    }
    const ctx = { threadId: this.rootThreadId, turnId };
    this.turnId = undefined;
    this.usage = undefined;
    this.ended.add(turnId);
    this.tools.clear();
    if (outcome.type === "completed") {
      this.opts.emit({ type: "turn.completed", ...ctx, stopReason: "end_turn" });
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
          ...(outcome.retryAt ? { retryAt: outcome.retryAt } : {}),
        },
      });
    }
  }

  // ---------------------------------------------------------------- internals

  private onExecutionStarted(): void {
    if (this.turnId) return;
    const pending = this.pendingTurnId;
    this.pendingTurnId = undefined;
    // An execution always opens a turn: never under an id that already ended.
    const id =
      pending && !this.ended.has(pending)
        ? pending
        : `turn-${this.turnCount + 1}-${Date.now().toString(36)}`;
    this.beginTurn(id);
  }

  private noteModel(model: string): void {
    if (model === this.model) return;
    this.model = model;
    this.opts.emit({ type: "session.updated", model });
  }

  /** Complete the open items (of one thread, or all), as completed or cancelled. */
  private closeOpen(ok: boolean, threadId?: string): void {
    for (const [id, { ctx, item }] of this.open) {
      if (threadId && ctx.threadId !== threadId) continue;
      this.opts.emit({
        type: "item.completed",
        ...ctx,
        item: { ...item, status: ok ? "completed" : "cancelled" } as Item,
      });
      this.open.delete(id);
    }
  }

  private textKey(data: { assistantMessageID: string; ordinal: number }, kind: string): string {
    return `${data.assistantMessageID}-${kind}-${data.ordinal}`;
  }

  private startText(
    event: OcEventOf<"session.text.started"> | OcEventOf<"session.reasoning.started">,
  ): void {
    const ctx = this.ctxFor(event.data.sessionID);
    if (!ctx) return;
    const reasoning = event.type === "session.reasoning.started";
    const id = this.textKey(event.data, reasoning ? "reasoning" : "text");
    if (this.open.has(id)) return;
    const item: Item = reasoning
      ? { id, kind: "reasoning", status: "in_progress", text: "" }
      : { id, kind: "assistant_message", status: "in_progress", text: "" };
    this.open.set(id, { ctx, item });
    this.opts.emit({ type: "item.started", ...ctx, item });
  }

  private deltaText(
    event: OcEventOf<"session.text.delta"> | OcEventOf<"session.reasoning.delta">,
  ): void {
    const reasoning = event.type === "session.reasoning.delta";
    const id = this.textKey(event.data, reasoning ? "reasoning" : "text");
    const open = this.open.get(id);
    if (!open || !event.data.delta) return;
    // Kept on the open item, so a turn that ends early (an interrupt) keeps what streamed.
    open.item = { ...open.item, text: streamedText(open.item) + event.data.delta } as Item;
    this.opts.emit({
      type: "item.delta",
      ...open.ctx,
      itemId: id,
      delta: { type: "text", text: event.data.delta },
    });
  }

  private endText(
    event: OcEventOf<"session.text.ended"> | OcEventOf<"session.reasoning.ended">,
  ): void {
    const reasoning = event.type === "session.reasoning.ended";
    const id = this.textKey(event.data, reasoning ? "reasoning" : "text");
    const open = this.open.get(id);
    const ctx = open?.ctx ?? this.ctxFor(event.data.sessionID);
    if (!ctx) return;
    this.open.delete(id);
    // The final text, or what streamed when the end event carries none (a cut-off step).
    const text = event.data.text || (open ? streamedText(open.item) : "");
    if (!reasoning && !text.trim() && !open) return;
    const item: Item = reasoning
      ? {
          id,
          kind: "reasoning",
          status: "completed",
          text,
          ...(text.trim() ? {} : { redacted: true }),
        }
      : { id, kind: "assistant_message", status: "completed", text };
    this.opts.emit({ type: "item.completed", ...ctx, item });
  }

  private onToolInput(event: OcEventOf<"session.tool.input.started">): void {
    const { id, name, sessionID } = event.data;
    if (this.tools.has(id)) return;
    this.tools.set(id, { id, name, input: {}, status: "in_progress", session: sessionID });
  }

  private onToolCalled(event: OcEventOf<"session.tool.called">): void {
    const { id, sessionID, input } = event.data;
    const state = this.tools.get(id) ?? {
      id,
      name: "tool",
      input: {},
      status: "in_progress" as const,
      session: sessionID,
    };
    state.input = input ?? {};
    state.startedAt = Date.now();
    this.tools.set(id, state);
    const ctx = this.ctxFor(sessionID);
    if (!ctx) return;
    if (state.name === "subagent") {
      this.subagents.start(state, ctx);
      return;
    }
    if (state.name === "todowrite") {
      this.updateTodos(ctx, state.input);
      return;
    }
    const item = toolCallItem(state, this.opts.tools);
    if (!item) return;
    this.open.set(id, { ctx, item });
    this.opts.emit({ type: "item.started", ...ctx, item });
  }

  private onToolEnded(
    event: OcEventOf<"session.tool.success"> | OcEventOf<"session.tool.failed">,
  ): void {
    const { id, sessionID } = event.data;
    const state = this.tools.get(id);
    if (!state) return;
    state.endedAt = Date.now();
    state.output = contentText(event.data.content);
    state.metadata = event.data.metadata;
    state.diffs = diffsOf(event.data.metadata) ?? state.diffs;
    if (event.type === "session.tool.failed") {
      const type = event.data.error.type;
      state.status =
        type === "permission.rejected" ? "declined" : type === "aborted" ? "cancelled" : "failed";
      state.error = event.data.error.message;
    } else {
      state.status = "completed";
    }
    if (this.subagents.has(id)) {
      this.subagents.finish(
        id,
        state.status === "completed"
          ? "completed"
          : state.status === "cancelled"
            ? "interrupted"
            : "failed",
        subagentSummary(state.output || state.error || ""),
      );
      return;
    }
    if (state.name === "todowrite") return;
    const open = this.open.get(id);
    const ctx = open?.ctx ?? this.ctxFor(sessionID);
    const item = toolCallItem(state, this.opts.tools);
    if (!ctx || !item) return;
    this.open.delete(id);
    this.opts.emit({ type: "item.completed", ...ctx, item });
  }

  private updateTodos(ctx: ThreadCtx, input: Record<string, unknown>): void {
    const todos = todosOf(input);
    if (!todos) return;
    if (this.todos) {
      this.todos.item = { ...this.todos.item, todos };
      this.opts.emit({ type: "item.updated", ...this.todos.ctx, item: this.todos.item });
      return;
    }
    const item: ItemOf<"todo_list"> = {
      id: `todos-${ctx.turnId}`,
      kind: "todo_list",
      status: "in_progress",
      todos,
    };
    this.todos = { id: item.id, ctx, item };
    this.opts.emit({ type: "item.started", ...ctx, item });
  }

  private addUsage(
    session: string,
    tokens: Parameters<TurnUsage["add"]>[0],
    cost: number | undefined,
  ): void {
    if (!this.usage || !this.turnId || (!tokens && !cost)) return;
    if (session !== this.rootSession && !this.subagents.isChildSession(session)) return;
    this.usage.add(tokens, cost, session === this.rootSession);
    this.opts.emit({
      type: "usage.updated",
      threadId: this.rootThreadId,
      turnId: this.turnId,
      usage: this.usage.snapshot(),
    });
  }

  private notice(session: string, level: "info" | "warning", message: string, code: string): void {
    const ctx = this.ctxFor(session);
    if (!ctx) return;
    this.opts.emit({
      type: "item.completed",
      ...ctx,
      item: {
        id: `${code}-${ctx.turnId}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
        kind: "notice",
        status: "completed",
        level,
        code,
        message,
      },
    });
  }
}

/** The text streamed so far into an open message or reasoning item. */
function streamedText(item: Item): string {
  return item.kind === "assistant_message" || item.kind === "reasoning" ? item.text : "";
}

import type { AgentEvent, ErrorKind, Item, ItemOf } from "@codeden/contracts";
import type { AgentNames } from "./collab";
import { classifyCodexError, codexErrorCode, usageLimitResetsAt } from "./errors";
import { mapThreadItem, startedItem } from "./items";
import type { ServerNotification } from "./protocol";
import type { RateLimitSnapshot, ThreadItem, Turn } from "./protocol/v2";
import { CodexTurnUsage } from "./usage";

type Todo = ItemOf<"todo_list">["todos"][number];

/** How a turn ended. */
export type TurnOutcome =
  | { type: "completed" }
  | { type: "interrupted" }
  | {
      type: "failed";
      message: string;
      detail?: string;
      code?: string;
      kind?: ErrorKind;
      retryAt?: string;
    };

/** Items in which one agent starts, messages or reports on other agents. */
export type AgentItem = Extract<ThreadItem, { type: "collabAgentToolCall" | "subAgentActivity" }>;

/** The sub-agent tracker, as a thread sees it. */
export interface ThreadLinks {
  /**
   * An agent item from `from`. Returns true when it was consumed (a spawn becomes a `subagent`
   * item; activity reports update one), false when it is shown as a tool call.
   */
  agentItem(
    from: CodexThreadMapper,
    turnId: string,
    item: AgentItem,
    phase: "started" | "completed",
  ): boolean;
  /** Display names of sub-agents, for the titles of calls between agents. */
  names: AgentNames;
}

export interface ThreadMapperOptions {
  /** CodeDen thread id. */
  threadId: string;
  /**
   * True for the session's own thread. Only it reports model changes and context size;
   * sub-agent threads never change what the session shows for those.
   */
  root: boolean;
  emit: (event: AgentEvent) => void;
  links: ThreadLinks;
  /** The latest rate-limit snapshot, for when a reached usage limit lifts. */
  limits: () => RateLimitSnapshot | undefined;
  /**
   * The root thread's user messages, with the sender restored. Without it (sub-agent threads)
   * user messages are reported to `onItemCompleted` but not shown: they come from the parent
   * agent, whose calls already show them.
   */
  userMessage?: (item: Item, clientId: string | null) => Item;
  onTurnStarted?: (turnId: string) => void;
  onTurnEnded?: (turnId: string, outcome: TurnOutcome) => void;
  /** Every completed item of this thread. */
  onItemCompleted?: (item: Item) => void;
  /** The thread's running token total, as Codex reports it. */
  onTokens?: (totalTokens: number) => void;
}

/**
 * Translates the `codex app-server` notifications of one Codex thread (the session's own, or a
 * sub-agent's) into `AgentEvent`s on one CodeDen thread. Codex turn and item ids are used as-is
 * (they are unique UUIDs / call ids across threads).
 */
export class CodexThreadMapper {
  private current: string | undefined;
  private readonly open = new Map<string, Item>();
  private plan: { id: string; todos: Todo[] } | undefined;
  private readonly turnUsage = new CodexTurnUsage();

  constructor(private readonly o: ThreadMapperOptions) {}

  get threadId(): string {
    return this.o.threadId;
  }

  /** The running turn, if any. */
  get turnId(): string | undefined {
    return this.current;
  }

  /** Start a turn by id. Idempotent; a different running turn ends as interrupted first. */
  beginTurn(turnId: string): void {
    if (this.current === turnId) return;
    if (this.current) this.endTurn({ type: "interrupted" }, this.current);
    this.current = turnId;
    this.o.emit({ type: "turn.started", threadId: this.threadId, turnId });
    this.o.onTurnStarted?.(turnId);
  }

  private ctx(turnId: string): { threadId: string; turnId: string } {
    return { threadId: this.threadId, turnId };
  }

  handle(n: ServerNotification): void {
    switch (n.method) {
      case "turn/started":
        this.beginTurn(n.params.turn.id);
        return;
      case "item/started": {
        const raw = n.params.item;
        if (this.agentItem(n.params.turnId, raw, "started")) return;
        const item = startedItem(raw, this.o.links.names);
        if (!item || item.kind === "user_message") return;
        this.beginTurn(n.params.turnId);
        this.open.set(item.id, item);
        this.o.emit({ type: "item.started", ...this.ctx(n.params.turnId), item });
        return;
      }
      case "item/completed": {
        const raw = n.params.item;
        if (this.agentItem(n.params.turnId, raw, "completed")) return;
        const mapped = mapThreadItem(raw, this.o.links.names);
        if (!mapped) return;
        if (mapped.kind === "user_message" && !this.o.userMessage) {
          this.o.onItemCompleted?.(mapped);
          return;
        }
        const item =
          raw.type === "userMessage" && this.o.userMessage
            ? this.o.userMessage(mapped, raw.clientId)
            : mapped;
        this.beginTurn(n.params.turnId);
        this.open.delete(item.id);
        this.o.onItemCompleted?.(item);
        this.o.emit({ type: "item.completed", ...this.ctx(n.params.turnId), item });
        return;
      }
      case "item/agentMessage/delta":
      case "item/plan/delta":
      case "item/reasoning/textDelta":
        this.delta(n.params.turnId, n.params.itemId, { type: "text", text: n.params.delta });
        return;
      case "item/reasoning/summaryTextDelta":
        this.delta(n.params.turnId, n.params.itemId, {
          type: "reasoning_summary",
          text: n.params.delta,
        });
        return;
      case "item/commandExecution/outputDelta":
      case "item/fileChange/outputDelta":
        this.delta(n.params.turnId, n.params.itemId, { type: "tool_output", text: n.params.delta });
        return;
      case "turn/plan/updated":
        this.updatePlan(n.params.turnId, n.params.plan);
        return;
      case "thread/tokenUsage/updated": {
        this.o.onTokens?.(n.params.tokenUsage.total.totalTokens);
        const usage = this.turnUsage.add(n.params.turnId, n.params.tokenUsage);
        // The context meter is the session's own agent's: a sub-agent's context is not it.
        if (!this.o.root) {
          delete usage.contextTokens;
          delete usage.contextWindow;
        }
        this.o.emit({ type: "usage.updated", ...this.ctx(n.params.turnId), usage });
        return;
      }
      case "model/rerouted":
        if (this.o.root) this.o.emit({ type: "session.updated", model: n.params.toModel });
        return;
      case "error":
        this.notice(
          n.params.turnId,
          "warning",
          n.params.error.message,
          n.params.willRetry ? "retrying" : "provider_error",
          !n.params.willRetry,
        );
        return;
      case "warning":
        if (this.current)
          this.notice(this.current, "warning", n.params.message, "provider_warning", false);
        return;
      case "thread/compacted":
        this.notice(n.params.turnId, "info", "Context compacted", "context_compacted", false);
        return;
      case "turn/completed":
        this.completeTurn(n.params.turn);
        return;
      default:
        return;
    }
  }

  /** Hand agent items to the sub-agent tracker; true when it consumed the item. */
  private agentItem(turnId: string, raw: ThreadItem, phase: "started" | "completed"): boolean {
    if (raw.type !== "collabAgentToolCall" && raw.type !== "subAgentActivity") return false;
    return this.o.links.agentItem(this, turnId, raw, phase);
  }

  private delta(
    turnId: string,
    itemId: string,
    delta: { type: "text" | "reasoning_summary" | "tool_output"; text: string },
  ): void {
    if (!delta.text) return;
    this.beginTurn(turnId);
    this.o.emit({ type: "item.delta", ...this.ctx(turnId), itemId, delta });
  }

  private notice(
    turnId: string,
    level: "info" | "warning",
    message: string,
    code: string,
    asError: boolean,
  ): void {
    const id = `${code}-${turnId}-${Date.now().toString(36)}`;
    const item: Item = asError
      ? { id, kind: "error", status: "completed", error: { code, message } }
      : { id, kind: "notice", status: "completed", level, code, message };
    this.o.emit({ type: "item.completed", ...this.ctx(turnId), item });
  }

  private updatePlan(turnId: string, steps: { step: string; status: string }[]): void {
    this.beginTurn(turnId);
    const todos: Todo[] = steps.map((s, i) => ({
      id: String(i + 1),
      text: s.step,
      status:
        s.status === "inProgress"
          ? "in_progress"
          : s.status === "completed"
            ? "completed"
            : "pending",
    }));
    const item = { kind: "todo_list" as const, status: "in_progress" as const, todos };
    if (this.plan) {
      this.plan.todos = todos;
      this.o.emit({
        type: "item.updated",
        ...this.ctx(turnId),
        item: { id: this.plan.id, ...item },
      });
    } else {
      this.plan = { id: `todos-${turnId}`, todos };
      this.o.emit({
        type: "item.started",
        ...this.ctx(turnId),
        item: { id: this.plan.id, ...item },
      });
    }
  }

  private completeTurn(turn: Turn): void {
    this.beginTurn(turn.id);
    if (turn.status === "completed") this.endTurn({ type: "completed" }, turn.id);
    else if (turn.status === "interrupted") this.endTurn({ type: "interrupted" }, turn.id);
    else {
      const info = turn.error?.codexErrorInfo;
      const kind = classifyCodexError(info);
      const retryAt = kind === "usage_limit" ? usageLimitResetsAt(this.o.limits()) : undefined;
      this.endTurn(
        {
          type: "failed",
          message: turn.error?.message ?? "Codex turn failed",
          detail: turn.error?.additionalDetails ?? undefined,
          code: codexErrorCode(info),
          kind,
          retryAt,
        },
        turn.id,
      );
    }
  }

  /** Close the running turn (also used when the process dies or the session closes). */
  endTurn(outcome: TurnOutcome, turnId = this.current): void {
    if (!turnId || turnId !== this.current) return;
    const ctx = this.ctx(turnId);
    const ok = outcome.type === "completed";
    for (const item of this.open.values()) {
      this.o.emit({
        type: "item.completed",
        ...ctx,
        item: { ...item, status: ok ? "completed" : "cancelled" } as Item,
      });
    }
    this.open.clear();
    if (this.plan) {
      this.o.emit({
        type: "item.completed",
        ...ctx,
        item: {
          id: this.plan.id,
          kind: "todo_list",
          status: ok ? "completed" : "cancelled",
          todos: this.plan.todos,
        },
      });
      this.plan = undefined;
    }
    this.current = undefined;
    if (outcome.type === "completed")
      this.o.emit({ type: "turn.completed", ...ctx, stopReason: "end_turn" });
    else if (outcome.type === "interrupted")
      this.o.emit({ type: "turn.interrupted", ...ctx, reason: "user" });
    else {
      this.o.emit({
        type: "turn.failed",
        ...ctx,
        error: {
          code: outcome.code ?? "turn_failed",
          message: outcome.message,
          ...(outcome.detail ? { detail: outcome.detail } : {}),
          ...(outcome.kind
            ? {
                kind: outcome.kind,
                retryable: outcome.kind === "transient" || outcome.kind === "usage_limit",
              }
            : {}),
          ...(outcome.retryAt ? { retryAt: outcome.retryAt } : {}),
        },
      });
    }
    this.o.onTurnEnded?.(turnId, outcome);
  }
}

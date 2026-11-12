import { randomUUID } from "node:crypto";
import type {
  AgentEvent,
  ErrorKind,
  Item,
  ItemOf,
  MessageSender,
  Usage,
  UserInput,
} from "@codeden/contracts";
import { count, unixToIso } from "../util/text";
import { classifyCodexError, codexErrorCode, usageLimitResetsAt } from "./errors";
import { mapThreadItem, startedItem } from "./items";
import type { ServerNotification } from "./protocol";
import type { RateLimitSnapshot, ThreadTokenUsage, Turn } from "./protocol/v2";

type Todo = ItemOf<"todo_list">["todos"][number];

/**
 * Translates `codex app-server` notifications for one thread into normalized `AgentEvent`s.
 * Codex turn and item ids are used as-is (they are unique UUIDs / call ids).
 */
export class CodexEventMapper {
  readonly rootThreadId: string;
  /** Codex thread id (also the resume token). */
  codexThreadId: string | undefined;
  private turnId: string | undefined;
  private readonly open = new Map<string, Item>();
  private plan: { id: string; todos: Todo[] } | undefined;
  private readonly turnUsage = new CodexTurnUsage();
  /** The latest rate-limit snapshot, for when a reached usage limit lifts. */
  private limits: RateLimitSnapshot | undefined;
  /**
   * Who sent each input that went out with a `clientUserMessageId`, until Codex echoes it back
   * as a user message (with that id as `clientId`). Codex keeps only the text, so the sender
   * would otherwise be lost.
   */
  private readonly senders = new Map<string, MessageSender>();

  constructor(
    sessionId: string,
    private readonly emit: (event: AgentEvent) => void,
  ) {
    this.rootThreadId = `${sessionId}:thread-root`;
  }

  get currentTurnId(): string | undefined {
    return this.turnId;
  }

  /** Start a turn by id (from the `turn/start` response or `turn/started`). Idempotent. */
  beginTurn(turnId: string): void {
    if (this.turnId === turnId) return;
    if (this.turnId) this.endTurn({ type: "interrupted" }, this.turnId);
    this.turnId = turnId;
    this.emit({ type: "turn.started", threadId: this.rootThreadId, turnId });
  }

  private ctx(turnId: string): { threadId: string; turnId: string } {
    return { threadId: this.rootThreadId, turnId };
  }

  /**
   * The `clientUserMessageId` to send with `input`, so its echo keeps the sender. Undefined for
   * the user's own messages (no sender recorded).
   */
  clientMessageId(input: UserInput): string | undefined {
    if (!input.from) return undefined;
    const id = randomUUID();
    // Bounded: an id whose echo never came (a failed turn/start) is dropped after a while.
    if (this.senders.size >= 50) this.senders.delete(this.senders.keys().next().value as string);
    this.senders.set(id, input.from);
    return id;
  }

  /** A user message with the sender recorded for its `clientId`. */
  private withSender(item: Item, clientId: string | null): Item {
    const from = clientId ? this.senders.get(clientId) : undefined;
    if (item.kind !== "user_message" || !clientId || !from) return item;
    this.senders.delete(clientId);
    return { ...item, input: { ...item.input, from } };
  }

  handle(n: ServerNotification): void {
    const params = n.params as { threadId?: string | null; turnId?: string };
    if (params.threadId && this.codexThreadId && params.threadId !== this.codexThreadId) return;
    switch (n.method) {
      case "turn/started":
        this.beginTurn(n.params.turn.id);
        return;
      case "item/started": {
        const item = startedItem(n.params.item);
        if (!item || item.kind === "user_message") return;
        this.beginTurn(n.params.turnId);
        this.open.set(item.id, item);
        this.emit({ type: "item.started", ...this.ctx(n.params.turnId), item });
        return;
      }
      case "item/completed": {
        const mapped = mapThreadItem(n.params.item);
        if (!mapped) return;
        const raw = n.params.item;
        const item = raw.type === "userMessage" ? this.withSender(mapped, raw.clientId) : mapped;
        this.beginTurn(n.params.turnId);
        this.open.delete(item.id);
        this.emit({ type: "item.completed", ...this.ctx(n.params.turnId), item });
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
      case "thread/tokenUsage/updated":
        this.emit({
          type: "usage.updated",
          ...this.ctx(n.params.turnId),
          usage: this.turnUsage.add(n.params.turnId, n.params.tokenUsage),
        });
        return;
      case "account/rateLimits/updated":
        this.limits = n.params.rateLimits;
        this.emit({
          type: "usage.updated",
          threadId: this.rootThreadId,
          ...(this.turnId ? { turnId: this.turnId } : {}),
          usage: rateLimits(n.params.rateLimits),
        });
        return;
      case "model/rerouted":
        this.emit({ type: "session.updated", model: n.params.toModel });
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
        if (this.turnId)
          this.notice(this.turnId, "warning", n.params.message, "provider_warning", false);
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

  private delta(
    turnId: string,
    itemId: string,
    delta: { type: "text" | "reasoning_summary" | "tool_output"; text: string },
  ): void {
    if (!delta.text) return;
    this.beginTurn(turnId);
    this.emit({ type: "item.delta", ...this.ctx(turnId), itemId, delta });
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
    this.emit({ type: "item.completed", ...this.ctx(turnId), item });
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
    if (this.plan) {
      this.plan.todos = todos;
      this.emit({
        type: "item.updated",
        ...this.ctx(turnId),
        item: { id: this.plan.id, kind: "todo_list", status: "in_progress", todos },
      });
    } else {
      this.plan = { id: `todos-${turnId}`, todos };
      this.emit({
        type: "item.started",
        ...this.ctx(turnId),
        item: { id: this.plan.id, kind: "todo_list", status: "in_progress", todos },
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
      const retryAt = kind === "usage_limit" ? usageLimitResetsAt(this.limits) : undefined;
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

  /** Close the current turn (also used when the process dies). */
  endTurn(
    outcome:
      | { type: "completed" }
      | { type: "interrupted" }
      | {
          type: "failed";
          message: string;
          detail?: string;
          code?: string;
          kind?: ErrorKind;
          retryAt?: string;
        },
    turnId = this.turnId,
  ): void {
    if (!turnId || turnId !== this.turnId) return;
    const ctx = this.ctx(turnId);
    const ok = outcome.type === "completed";
    for (const item of this.open.values()) {
      this.emit({
        type: "item.completed",
        ...ctx,
        item: { ...item, status: ok ? "completed" : "cancelled" } as Item,
      });
    }
    this.open.clear();
    if (this.plan) {
      this.emit({
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
    this.turnId = undefined;
    if (outcome.type === "completed")
      this.emit({ type: "turn.completed", ...ctx, stopReason: "end_turn" });
    else if (outcome.type === "interrupted")
      this.emit({ type: "turn.interrupted", ...ctx, reason: "user" });
    else {
      this.emit({
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
  }
}

type Breakdown = ThreadTokenUsage["total"];
const BREAKDOWN_KEYS = [
  "totalTokens",
  "inputTokens",
  "cachedInputTokens",
  "cacheWriteInputTokens",
  "outputTokens",
  "reasoningOutputTokens",
] as const;

function addBreakdown(a: Breakdown, b: Breakdown, sign = 1): Breakdown {
  const out = { ...a };
  for (const k of BREAKDOWN_KEYS) out[k] = Math.max(0, (a[k] ?? 0) + sign * (b[k] ?? 0));
  return out;
}

const ZERO: Breakdown = {
  totalTokens: 0,
  inputTokens: 0,
  cachedInputTokens: 0,
  cacheWriteInputTokens: 0,
  outputTokens: 0,
  reasoningOutputTokens: 0,
};

/**
 * Per-turn token accounting for one thread. Codex reports the thread's running `total` (which
 * survives resumes) and the `last` request. A turn's usage is the growth of `total` since the
 * previous report in this process; the first report after a (re)start counts only `last`, so
 * history from before a resume is never charged again. Repeated reports add nothing.
 */
export class CodexTurnUsage {
  private previousTotal: Breakdown | undefined;
  private readonly turns = new Map<string, Breakdown>();

  /** Fold a report into its turn and return the turn's usage so far. */
  add(turnId: string, u: ThreadTokenUsage): Usage {
    const step = this.previousTotal ? addBreakdown(u.total, this.previousTotal, -1) : u.last;
    this.previousTotal = u.total;
    const turn = addBreakdown(this.turns.get(turnId) ?? ZERO, step);
    this.turns.set(turnId, turn);
    return tokenUsage({ ...u, total: turn });
  }
}

/**
 * Codex token usage in CodeDen's terms, from `u.total` (context from `last`). OpenAI counts
 * cached input inside `inputTokens`; CodeDen's `inputTokens` is the uncached part.
 */
export function tokenUsage(u: ThreadTokenUsage): Usage {
  const usage: Usage = {
    inputTokens: count(Math.max(0, u.total.inputTokens - u.total.cachedInputTokens)),
    outputTokens: count(u.total.outputTokens),
    cachedInputTokens: count(u.total.cachedInputTokens),
    cacheWriteTokens: count(u.total.cacheWriteInputTokens),
    reasoningTokens: count(u.total.reasoningOutputTokens),
    contextTokens: count(u.last.totalTokens),
  };
  if (u.modelContextWindow && u.modelContextWindow > 0)
    usage.contextWindow = Math.round(u.modelContextWindow);
  return usage;
}

function windowId(minutes: number | null, fallback: string): string {
  if (minutes === 300) return "5h";
  if (minutes === 10080) return "weekly";
  if (minutes && minutes % 1440 === 0) return `${minutes / 1440}d`;
  if (minutes && minutes % 60 === 0) return `${minutes / 60}h`;
  return fallback;
}

/** Codex rate-limit snapshot -> usage rate limits. */
export function rateLimits(snapshot: RateLimitSnapshot): Usage {
  const out: NonNullable<Usage["rateLimits"]> = [];
  for (const [name, w] of [
    ["primary", snapshot.primary],
    ["secondary", snapshot.secondary],
  ] as const) {
    if (!w) continue;
    const used = Math.min(100, Math.max(0, w.usedPercent));
    const resetsAt = unixToIso(w.resetsAt);
    out.push({
      id: windowId(w.windowDurationMins, name),
      status:
        snapshot.rateLimitReachedType || used >= 100 ? "limited" : used >= 80 ? "warning" : "ok",
      usedPercent: used,
      ...(resetsAt ? { resetsAt } : {}),
    });
  }
  return { rateLimits: out };
}

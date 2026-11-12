import { randomUUID } from "node:crypto";
import type { AgentEvent, Item, MessageSender, UserInput } from "@codeden/contracts";
import type { ItemCtx } from "../approvals";
import type { ServerNotification } from "./protocol";
import type { RateLimitSnapshot } from "./protocol/v2";
import { CodexSubagents } from "./subagents";
import { CodexThreadMapper, type TurnOutcome } from "./thread-mapper";
import { rateLimits } from "./usage";

export type { TurnOutcome } from "./thread-mapper";
export { CodexTurnUsage, rateLimits, tokenUsage } from "./usage";

/**
 * Translates `codex app-server` notifications into normalized `AgentEvent`s. The session's own
 * Codex thread maps to the root thread; threads of agents it spawns map to child threads
 * (`CodexSubagents`), and notifications from threads nobody spawned are dropped.
 */
export class CodexEventMapper {
  readonly rootThreadId: string;
  /** Codex thread id (also the resume token). */
  codexThreadId: string | undefined;
  private readonly root: CodexThreadMapper;
  private readonly subagents: CodexSubagents;
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
    now: () => number = Date.now,
  ) {
    this.rootThreadId = `${sessionId}:thread-root`;
    const limits = () => this.limits;
    this.subagents = new CodexSubagents({ sessionId, emit, limits, now });
    this.root = new CodexThreadMapper({
      threadId: this.rootThreadId,
      root: true,
      emit,
      links: this.subagents,
      limits,
      userMessage: (item, clientId) => this.withSender(item, clientId),
    });
  }

  get currentTurnId(): string | undefined {
    return this.root.turnId;
  }

  /** Start a turn by id (from the `turn/start` response or `turn/started`). Idempotent. */
  beginTurn(turnId: string): void {
    this.root.beginTurn(turnId);
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
    if (n.method === "account/rateLimits/updated") {
      this.limits = n.params.rateLimits;
      const turnId = this.root.turnId;
      this.emit({
        type: "usage.updated",
        threadId: this.rootThreadId,
        ...(turnId ? { turnId } : {}),
        usage: rateLimits(n.params.rateLimits),
      });
      return;
    }
    const threadId = (n.params as { threadId?: string | null }).threadId;
    if (threadId && this.codexThreadId && threadId !== this.codexThreadId) {
      this.subagents.route(threadId, n);
      return;
    }
    this.root.handle(n);
  }

  /**
   * Where an approval or question from a Codex thread goes: a sub-agent's child thread, or the
   * root thread (also for threads CodeDen doesn't know).
   */
  requestCtx(codexThreadId: string | undefined, turnId: string): ItemCtx {
    if (codexThreadId && codexThreadId !== this.codexThreadId) {
      const child = this.subagents.requestCtx(codexThreadId, turnId);
      if (child) return child;
      return { threadId: this.rootThreadId, turnId: this.root.turnId ?? turnId };
    }
    return { threadId: this.rootThreadId, turnId };
  }

  /** Running sub-agent turns, to stop them with the session's turn. */
  runningSubagentTurns(): { codexThreadId: string; turnId: string }[] {
    return this.subagents.runningTurns();
  }

  /** Close the session's running turn. */
  endTurn(outcome: TurnOutcome, turnId = this.root.turnId): void {
    this.root.endTurn(outcome, turnId);
  }

  /**
   * Close the session's turn and every sub-agent's (stop without an answer, close, process
   * exit): their cards end as cancelled, or failed when `outcome` is a failure.
   */
  endAll(outcome: TurnOutcome): void {
    this.root.endTurn(outcome);
    this.subagents.endAll(outcome);
  }
}

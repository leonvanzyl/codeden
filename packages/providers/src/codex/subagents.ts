import type { AgentEvent, ItemOf, ItemStatus, SubagentStats } from "@codeden/contracts";
import type { ItemCtx } from "../approvals";
import { shorten } from "../util/text";
import { type CollabItem, FINAL_AGENT_STATUSES } from "./collab";
import type { ServerNotification } from "./protocol";
import type {
  CollabAgentState,
  CollabAgentStatus,
  RateLimitSnapshot,
  ThreadTokenUsage,
} from "./protocol/v2";
import {
  type AgentItem,
  CodexThreadMapper,
  type ThreadLinks,
  type TurnOutcome,
} from "./thread-mapper";
import { subagentUsage } from "./usage";

/**
 * Notifications held for a thread no spawn has claimed yet, and how many such threads are held
 * at once. A spawned agent's first events can arrive before its parent's spawn call completes;
 * threads nobody claims (Codex's own internal workers) are dropped.
 */
const MAX_HELD_PER_THREAD = 2000;
const MAX_HELD_THREADS = 8;

/** One spawned agent: the `subagent` card in its parent and its own thread. */
interface Run {
  parent: ItemCtx;
  item: ItemOf<"subagent">;
  startedAt: number;
  codexThreadId?: string;
  thread?: CodexThreadMapper;
  /** Turns the agent has run (stats are reported once it ran one). */
  turns: number;
  /** Tool calls it started or finished (a turn cut short closes started ones for it). */
  toolCalls: Set<string>;
  /** The agent thread's latest token report (running total). */
  tokens?: ThreadTokenUsage;
  /** The model its spawn asked for; absent when it runs the session's. */
  model?: string;
  /** When the card last closed, for its duration. */
  endedAt?: number;
  /** The agent's last message in its current turn: the card's summary. */
  lastMessage?: string;
  /** A final message Codex reported for it this turn (`agentsStates`): the summary's fallback. */
  reported?: string;
  /** What the card was closed with (a failure's message). */
  note?: string;
  /** True while the card shows the agent as working. */
  open: boolean;
  /**
   * Stop came before the agent ran a turn (its spawn was pending, or it had not started): the
   * next turn it starts is stopped too, unless the session's own next turn began first.
   */
  stopping?: boolean;
}

export interface CodexSubagentsOptions {
  sessionId: string;
  emit: (event: AgentEvent) => void;
  limits: () => RateLimitSnapshot | undefined;
  now: () => number;
  /** Interrupt a sub-agent turn that started after Stop cancelled its agent. */
  stopTurn?: (codexThreadId: string, turnId: string) => void;
}

/**
 * Codex sub-agents as child threads (§7.3). A spawn in any thread (`collabAgentToolCall`
 * `spawnAgent`, or a `subAgentActivity` `started` report) becomes a `subagent` card in that
 * thread, and the spawned agent's Codex thread, whose notifications arrive on the same
 * connection under its own thread id, maps into the card's child thread. The card follows the
 * agent's turns: working while one runs, finished with its last message when it ends.
 */
export class CodexSubagents implements ThreadLinks {
  /** By spawn call id. */
  private readonly runs = new Map<string, Run>();
  /** By the spawned agent's Codex thread id. */
  private readonly byThread = new Map<string, Run>();
  private readonly held = new Map<string, ServerNotification[]>();
  /** True while CodeDen itself closes turns (close, exit, a stop's deadline), not Codex. */
  private forcing = false;

  constructor(private readonly o: CodexSubagentsOptions) {}

  readonly names = (codexThreadId: string): string | undefined =>
    this.byThread.get(codexThreadId)?.item.description;

  /** A notification from a thread other than the session's own. */
  route(codexThreadId: string, n: ServerNotification): void {
    const thread = this.byThread.get(codexThreadId)?.thread;
    if (thread) {
      thread.handle(n);
      return;
    }
    let queue = this.held.get(codexThreadId);
    if (!queue) {
      if (this.held.size >= MAX_HELD_THREADS)
        this.held.delete(this.held.keys().next().value as string);
      queue = [];
      this.held.set(codexThreadId, queue);
    }
    if (queue.length >= MAX_HELD_PER_THREAD) queue.shift();
    queue.push(n);
  }

  agentItem(
    from: CodexThreadMapper,
    turnId: string,
    item: AgentItem,
    phase: "started" | "completed",
  ): boolean {
    if (item.type === "subAgentActivity") {
      if (item.kind === "started") {
        const name = item.agentPath.split("/").filter(Boolean).pop();
        this.bind(this.claim(from, turnId, item.id, { description: name }), item.agentThreadId);
      } else if (item.kind === "completed" || item.kind === "interrupted") {
        // Codex says the agent is done: the card closes even if its turn's end is still coming.
        const run = this.byThread.get(item.agentThreadId);
        if (run) this.settle(run, item.kind === "completed" ? "completed" : "cancelled");
      }
      return true;
    }
    if (item.tool !== "spawnAgent") {
      if (phase === "completed") this.noteStates(item.agentsStates);
      return false;
    }
    const run = this.claim(from, turnId, item.id, spawnDetails(item));
    if (item.model) run.model ??= item.model;
    const child = item.receiverThreadIds[0];
    if (child) this.bind(run, child);
    if (phase !== "completed") return true;
    if (!child && item.status === "interrupted") this.settle(run, "cancelled");
    else if (!child || item.status === "failed") {
      const message = child ? item.agentsStates[child]?.message : undefined;
      this.settle(run, "failed", message ?? "Could not start the agent");
    } else this.noteStates(item.agentsStates);
    return true;
  }

  /** CodeDen thread and turn for a request from a sub-agent's Codex thread, if it is one. */
  requestCtx(codexThreadId: string, turnId: string): ItemCtx | undefined {
    const thread = this.byThread.get(codexThreadId)?.thread;
    if (!thread) return undefined;
    thread.beginTurn(turnId);
    return { threadId: thread.threadId, turnId };
  }

  /** True once any agent was spawned, whatever became of it. */
  any(): boolean {
    return this.runs.size > 0;
  }

  /** Running sub-agent turns, by Codex thread id. */
  runningTurns(): { codexThreadId: string; turnId: string }[] {
    const out: { codexThreadId: string; turnId: string }[] = [];
    for (const [codexThreadId, run] of this.byThread) {
      const turnId = run.thread?.turnId;
      if (turnId) out.push({ codexThreadId, turnId });
    }
    return out;
  }

  /**
   * Stop: returns the running sub-agent turns to interrupt, and cancels the cards of agents not
   * running a turn yet (a pending spawn, or an agent that has not started). A turn such an agent
   * starts before the session's next turn is stopped as well (`stopTurn`).
   */
  stop(): { codexThreadId: string; turnId: string }[] {
    const running = this.runningTurns();
    for (const run of this.runs.values()) {
      if (!run.open || run.thread?.turnId) continue;
      run.stopping = true;
      this.settle(run, "cancelled");
    }
    return running;
  }

  /** The session's next turn began: what stopped agents do from now on is new work. */
  releaseStops(): void {
    for (const run of this.runs.values()) run.stopping = false;
  }

  /** End one sub-agent turn if it is still the one running (a stop that got no answer). */
  endTurn(codexThreadId: string, turnId: string, outcome: TurnOutcome): void {
    const thread = this.byThread.get(codexThreadId)?.thread;
    if (thread?.turnId === turnId) this.force(() => thread.endTurn(outcome, turnId));
  }

  /** End every running sub-agent turn and close every open card (close, process exit). */
  endAll(outcome: TurnOutcome): void {
    this.force(() => {
      for (const run of this.runs.values()) run.thread?.endTurn(outcome);
    });
    for (const run of this.runs.values()) {
      this.settle(run, statusOf(outcome), outcome.type === "failed" ? outcome.message : undefined);
    }
  }

  private force(close: () => void): void {
    this.forcing = true;
    try {
      close();
    } finally {
      this.forcing = false;
    }
  }

  /** The card for a spawn, created on first sight of the spawn call. */
  private claim(
    from: CodexThreadMapper,
    turnId: string,
    callId: string,
    details: { description?: string; prompt?: string },
  ): Run {
    const existing = this.runs.get(callId);
    if (existing) return existing;
    from.beginTurn(turnId);
    const parent = { threadId: from.threadId, turnId };
    const childThreadId = `${this.o.sessionId}:thread-${callId}`;
    const { description, prompt } = details;
    const item: ItemOf<"subagent"> = {
      id: callId,
      kind: "subagent",
      status: "in_progress",
      childThreadId,
      ...(description ? { description } : {}),
      ...(prompt ? { prompt } : {}),
    };
    const run: Run = {
      parent,
      item,
      startedAt: this.o.now(),
      turns: 0,
      toolCalls: new Set(),
      open: true,
    };
    this.runs.set(callId, run);
    this.o.emit({
      type: "thread.started",
      thread: {
        id: childThreadId,
        parentThreadId: from.threadId,
        parentItemId: callId,
        ...(description ? { title: description } : {}),
      },
    });
    this.o.emit({ type: "item.started", ...parent, item });
    return run;
  }

  /** Link a card to the spawned agent's Codex thread and replay what arrived before. */
  private bind(run: Run, codexThreadId: string): void {
    if (run.thread || this.byThread.has(codexThreadId)) return;
    run.codexThreadId = codexThreadId;
    this.byThread.set(codexThreadId, run);
    const thread = new CodexThreadMapper({
      threadId: run.item.childThreadId,
      root: false,
      emit: this.o.emit,
      links: this,
      limits: this.o.limits,
      onTurnStarted: (turnId) => this.turnStarted(run, turnId),
      onTurnEnded: (_turnId, outcome) => this.turnEnded(run, outcome),
      onItemStarted: (item) => {
        if (item.kind === "tool_call") run.toolCalls.add(item.id);
      },
      onItemCompleted: (item) => {
        if (item.kind === "tool_call") run.toolCalls.add(item.id);
        else if (item.kind === "assistant_message" && item.text.trim()) run.lastMessage = item.text;
        else if (item.kind === "user_message" && !run.item.prompt && item.input.text)
          run.item = { ...run.item, prompt: item.input.text };
      },
      onTokens: (usage) => {
        run.tokens = usage;
      },
    });
    run.thread = thread;
    const held = this.held.get(codexThreadId) ?? [];
    this.held.delete(codexThreadId);
    for (const n of held) thread.handle(n);
  }

  /** A turn started in the agent's thread: the card shows it working again. */
  private turnStarted(run: Run, turnId: string): void {
    run.turns += 1;
    run.lastMessage = undefined;
    run.reported = undefined;
    run.note = undefined;
    if (run.stopping) {
      // Stop cancelled this agent before it ran: stop the turn too; its end settles the card.
      run.stopping = false;
      if (run.codexThreadId) this.o.stopTurn?.(run.codexThreadId, turnId);
      return;
    }
    if (run.open) return;
    run.open = true;
    const { summary: _summary, stats: _stats, ...rest } = run.item;
    run.item = { ...rest, status: "in_progress" };
    this.o.emit({ type: "item.updated", ...run.parent, item: run.item });
  }

  /**
   * A turn of the agent ended. An open card closes with its outcome. A card that closed early
   * (Codex reported the agent done, or Stop cancelled it) takes the turn's actual outcome, with
   * a failure's message, and its final figures. When CodeDen closes the turn itself (close,
   * exit, a stop's deadline) a closed card keeps what it shows.
   */
  private turnEnded(run: Run, outcome: TurnOutcome): void {
    const note = outcome.type === "failed" ? outcome.message : undefined;
    if (run.open) {
      this.settle(run, statusOf(outcome), note);
    } else if (this.forcing) {
      this.refresh(run);
    } else {
      run.note = note;
      run.endedAt = this.o.now();
      this.refresh(run, statusOf(outcome));
    }
  }

  /**
   * A call between agents reported final states (multi-agent v1). A reported message is kept as
   * the summary's fallback. A card closes on the report only when no turn of the agent runs:
   * a running turn's own end follows and says how it went.
   */
  private noteStates(states: CollabItem["agentsStates"]): void {
    for (const [codexThreadId, state] of Object.entries(states)) {
      const run = this.byThread.get(codexThreadId);
      if (!run || !state || !FINAL_AGENT_STATUSES.has(state.status)) continue;
      if (state.message) run.reported = state.message;
      if (!run.open) this.refresh(run);
      else if (!run.thread?.turnId) this.settle(run, agentStatusOf(state));
    }
  }

  /** Close the card with the agent's last message (or a note) and what it used. */
  private settle(run: Run, status: ItemStatus, note?: string): void {
    if (!run.open) return;
    run.open = false;
    run.note = note;
    run.endedAt = this.o.now();
    run.item = this.card(run, status);
    this.o.emit({ type: "item.completed", ...run.parent, item: run.item });
  }

  /** Send a closed card again when a late report or its turn's end changed what it shows. */
  private refresh(run: Run, status: ItemStatus = run.item.status): void {
    const next = this.card(run, status);
    if (
      next.status === run.item.status &&
      next.summary === run.item.summary &&
      JSON.stringify(next.stats) === JSON.stringify(run.item.stats)
    )
      return;
    run.item = next;
    this.o.emit({ type: "item.completed", ...run.parent, item: run.item });
  }

  /** The closed card: the agent's own last words first, then what Codex reported. */
  private card(run: Run, status: ItemStatus): ItemOf<"subagent"> {
    const summary =
      status === "completed"
        ? (run.lastMessage ?? run.reported ?? run.note)
        : (run.note ?? run.reported ?? run.lastMessage);
    const stats = run.turns > 0 ? this.stats(run) : undefined;
    const { summary: _summary, stats: _stats, ...rest } = run.item;
    return { ...rest, status, ...(summary ? { summary } : {}), ...(stats ? { stats } : {}) };
  }

  private stats(run: Run): SubagentStats {
    const end = run.endedAt ?? this.o.now();
    return {
      ...(run.tokens ? { totalTokens: Math.max(0, Math.round(run.tokens.total.totalTokens)) } : {}),
      toolUses: run.toolCalls.size,
      durationMs: Math.max(0, Math.round(end - run.startedAt)),
      // Its tokens by category, for the card's cost (§7.3).
      ...(run.tokens ? { usage: [subagentUsage(run.tokens, run.model)] } : {}),
    };
  }
}

function spawnDetails(item: CollabItem): { description?: string; prompt?: string } {
  if (!item.prompt) return {};
  return { description: shorten(item.prompt, 60), prompt: item.prompt };
}

function statusOf(outcome: TurnOutcome): ItemStatus {
  return outcome.type === "completed"
    ? "completed"
    : outcome.type === "failed"
      ? "failed"
      : "cancelled";
}

const AGENT_STATUS: Partial<Record<CollabAgentStatus, ItemStatus>> = {
  completed: "completed",
  errored: "failed",
  notFound: "failed",
};

function agentStatusOf(state: CollabAgentState): ItemStatus {
  return AGENT_STATUS[state.status] ?? "cancelled";
}

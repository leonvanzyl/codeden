import type { AgentEvent, ItemOf, ItemStatus, SubagentStats } from "@codeden/contracts";
import type { ItemCtx } from "../approvals";
import { shorten } from "../util/text";
import { type CollabItem, FINAL_AGENT_STATUSES } from "./collab";
import type { ServerNotification } from "./protocol";
import type { CollabAgentState, CollabAgentStatus, RateLimitSnapshot } from "./protocol/v2";
import {
  type AgentItem,
  CodexThreadMapper,
  type ThreadLinks,
  type TurnOutcome,
} from "./thread-mapper";

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
  toolCalls: Set<string>;
  totalTokens?: number;
  /** The agent's last message in its current turn: the card's summary. */
  lastMessage?: string;
  /** True while the card shows the agent as working. */
  open: boolean;
}

export interface CodexSubagentsOptions {
  sessionId: string;
  emit: (event: AgentEvent) => void;
  limits: () => RateLimitSnapshot | undefined;
  now: () => number;
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
        this.stopped(item.agentThreadId, item.kind === "completed" ? "completed" : "cancelled");
      }
      return true;
    }
    if (item.tool !== "spawnAgent") {
      if (phase === "completed") this.noteStates(item.agentsStates);
      return false;
    }
    const run = this.claim(from, turnId, item.id, spawnDetails(item));
    const child = item.receiverThreadIds[0];
    if (child) this.bind(run, child);
    if (phase !== "completed") return true;
    if (!child && item.status === "interrupted") this.settle(run, "cancelled");
    else if (!child || item.status === "failed") {
      const message = child ? item.agentsStates[child]?.message : undefined;
      this.settle(run, "failed", message ?? "Could not start the agent");
    }
    return true;
  }

  /** CodeDen thread and turn for a request from a sub-agent's Codex thread, if it is one. */
  requestCtx(codexThreadId: string, turnId: string): ItemCtx | undefined {
    const thread = this.byThread.get(codexThreadId)?.thread;
    if (!thread) return undefined;
    thread.beginTurn(turnId);
    return { threadId: thread.threadId, turnId };
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

  /** End every running sub-agent turn and close every open card (stop, close, process exit). */
  endAll(outcome: TurnOutcome): void {
    for (const run of this.runs.values()) run.thread?.endTurn(outcome);
    for (const run of this.runs.values()) {
      this.settle(run, statusOf(outcome), outcome.type === "failed" ? outcome.message : undefined);
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
      onTurnStarted: () => this.turnStarted(run),
      onTurnEnded: (_turnId, outcome) =>
        this.settle(
          run,
          statusOf(outcome),
          outcome.type === "failed" ? outcome.message : undefined,
        ),
      onItemCompleted: (item) => {
        if (item.kind === "tool_call") run.toolCalls.add(item.id);
        else if (item.kind === "assistant_message" && item.text.trim()) run.lastMessage = item.text;
        else if (item.kind === "user_message" && !run.item.prompt && item.input.text)
          run.item = { ...run.item, prompt: item.input.text };
      },
      onTokens: (total) => {
        run.totalTokens = total;
      },
    });
    run.thread = thread;
    const held = this.held.get(codexThreadId) ?? [];
    this.held.delete(codexThreadId);
    for (const n of held) thread.handle(n);
  }

  /** A turn started in the agent's thread: the card shows it working again. */
  private turnStarted(run: Run): void {
    run.turns += 1;
    run.lastMessage = undefined;
    if (run.open) return;
    run.open = true;
    const { summary: _summary, stats: _stats, ...rest } = run.item;
    run.item = { ...rest, status: "in_progress" };
    this.o.emit({ type: "item.updated", ...run.parent, item: run.item });
  }

  /** The parent was told an agent stopped: close its card unless a turn of it still runs. */
  private stopped(codexThreadId: string, status: ItemStatus, message?: string): void {
    const run = this.byThread.get(codexThreadId);
    if (run && !run.thread?.turnId) this.settle(run, status, message);
  }

  private noteStates(states: CollabItem["agentsStates"]): void {
    for (const [codexThreadId, state] of Object.entries(states)) {
      if (state && FINAL_AGENT_STATUSES.has(state.status))
        this.stopped(codexThreadId, agentStatusOf(state), state.message ?? undefined);
    }
  }

  /** Close the card with the agent's last message (or `note`) and what it used. */
  private settle(run: Run, status: ItemStatus, note?: string): void {
    if (!run.open) return;
    run.open = false;
    const summary = status === "completed" ? (run.lastMessage ?? note) : (note ?? run.lastMessage);
    const stats = run.turns > 0 ? this.stats(run) : undefined;
    const { summary: _summary, stats: _stats, ...rest } = run.item;
    run.item = { ...rest, status, ...(summary ? { summary } : {}), ...(stats ? { stats } : {}) };
    this.o.emit({ type: "item.completed", ...run.parent, item: run.item });
  }

  private stats(run: Run): SubagentStats {
    return {
      ...(run.totalTokens !== undefined
        ? { totalTokens: Math.max(0, Math.round(run.totalTokens)) }
        : {}),
      toolUses: run.toolCalls.size,
      durationMs: Math.max(0, Math.round(this.o.now() - run.startedAt)),
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

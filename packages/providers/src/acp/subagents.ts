import { randomUUID } from "node:crypto";
import type { AgentEvent, ItemOf, ItemStatus } from "@codeden/contracts";
import { str } from "../util/text";
import type { AcpTurnOutcome } from "./errors";
import { type AcpToolContext, type AcpToolState, toolText } from "./items";
import { AcpEventMapper, type ThreadCtx } from "./mapper";
import type { AcpSessionUpdate } from "./protocol";

/** What is known about a subagent run when it starts, or what an agent reports about one. */
export interface AcpTaskReport {
  /** The parent's tool call that runs it (a `Task` call). */
  toolCallId?: string;
  description?: string;
  prompt?: string;
  agentType?: string;
  /** How long it ran, when the agent says. */
  durationMs?: number;
}

/** One subagent: its card in the parent thread and its own child thread. */
interface Run {
  key: string;
  parent: ThreadCtx;
  /** The mapper of the thread the card is in. */
  from: AcpEventMapper;
  item: ItemOf<"subagent">;
  /** Writes the child thread. */
  mapper: AcpEventMapper;
  /** The ACP child session it runs in; absent for a run the agent only reported. */
  childSession?: string;
  toolCallId?: string;
  durationMs?: number;
  startedAt: number;
  toolCalls: Set<string>;
  lastMessage?: string;
  open: boolean;
}

export interface AcpSubagentsOptions {
  sessionId: string;
  emit: (event: AgentEvent) => void;
  tools: AcpToolContext;
  now?: () => number;
}

/** How a child session's state ends its run. */
const END_STATES: Record<string, ItemStatus> = {
  completed: "completed",
  failed: "failed",
  cancelled: "cancelled",
  disconnected: "cancelled",
};

/**
 * Subagents as child threads (§7.3). An agent that accepted the `subagents` client capability
 * announces each one with `subagent_spawned` on its parent's session, then streams it under
 * the child's own session id: the run gets a `subagent` card in the parent's turn and a child
 * thread with a mapper of its own, until `subagent_state_update` ends it (or the parent's turn
 * does). Agents without child sessions can still report a finished run (`report`): its card
 * gets a thread with the task and its result.
 */
export class AcpSubagents {
  private readonly runs: Run[] = [];
  private readonly bySession = new Map<string, Run>();

  constructor(private readonly o: AcpSubagentsOptions) {}

  /** The mapper of a child session this session started: its updates and requests go there. */
  mapperFor(acpSessionId: string | undefined): AcpEventMapper | undefined {
    return acpSessionId ? this.bySession.get(acpSessionId)?.mapper : undefined;
  }

  /**
   * `subagent_spawned` and `subagent_state_update` from the session `from` writes (the root
   * or a child, for nested subagents). False for any other update. Replayed history and
   * updates outside a turn start nothing.
   */
  handle(update: AcpSessionUpdate, from: AcpEventMapper): boolean {
    const kind = update.sessionUpdate;
    if (kind !== "subagent_spawned" && kind !== "subagent_state_update") return false;
    const child = str(update, "subagentSessionId");
    if (from.replaying || !child) return true;
    if (kind === "subagent_spawned") {
      this.spawn(update, child, from);
      return true;
    }
    const state = str(update, "state") ?? str(update, "status") ?? "";
    const run = this.bySession.get(child);
    const status = END_STATES[state];
    if (run && status) this.settle(run, status, errorOf(update));
    return true;
  }

  /**
   * A subagent the agent reports (Cursor's `cursor/task`). With `card`, a run that has no
   * card yet gets one: finished now, or when its parent tool call finishes if that still
   * runs. Without, it only fills in what an open run's card lacks.
   */
  report(task: AcpTaskReport, from: AcpEventMapper, card: boolean): void {
    const known = task.toolCallId
      ? this.runs.find(
          (r) =>
            r.toolCallId === task.toolCallId &&
            r.from === from &&
            (r.open || r.parent.turnId === from.currentTurnId),
        )
      : undefined;
    if (known || !card) {
      if (known) this.enrich(known, task);
      return;
    }
    const run = this.open(from, task);
    if (!run) return;
    run.durationMs = task.durationMs;
    if (!task.toolCallId || !from.hasOpenTool(task.toolCallId)) this.finishReported(run);
  }

  /** A tool call finished in `from`: reported runs it carries finish with its result. */
  toolDone(from: AcpEventMapper, state: AcpToolState): void {
    for (const run of this.runs) {
      if (run.open && !run.childSession && run.from === from && run.toolCallId === state.toolCallId)
        this.finishReported(run, state.status === "failed" ? toolText(state) || "Failed" : "");
    }
  }

  /** The parent's turn is ending: every open run ends with it. */
  endAll(ok: boolean): void {
    for (const run of this.runs) this.settle(run, ok ? "completed" : "cancelled");
    this.runs.length = 0;
  }

  // ---------------------------------------------------------------- internals

  private spawn(update: AcpSessionUpdate, child: string, from: AcpEventMapper): void {
    if (this.bySession.get(child)?.open) return;
    const meta = vendorMeta(update);
    const toolCallId = firstStr([update, meta], ["toolCallId", "parentToolCallId", "toolUseId"]);
    const run = this.open(from, {
      ...(toolCallId ? { toolCallId } : {}),
      description: firstStr([update], ["name", "title", "description"]),
      prompt: firstStr([update], ["task", "prompt"]),
      agentType: agentTypeOf(
        (update as { subagentType?: unknown }).subagentType ?? meta?.subagentType,
      ),
    });
    if (!run) return;
    run.childSession = child;
    this.bySession.set(child, run);
  }

  /**
   * The card, the child thread and its turn, with the task as its first message. Ids hang off
   * a fresh key, not the parent's ids, so nested subagents keep them short (ids are capped).
   */
  private open(from: AcpEventMapper, task: AcpTaskReport): Run | undefined {
    const parent = from.ctx();
    if (!parent) return undefined;
    const key = randomUUID();
    const childThreadId = `${this.o.sessionId}:thread-${key}`;
    const { description, prompt, agentType } = task;
    const item: ItemOf<"subagent"> = {
      id: `subagent-${key}`,
      kind: "subagent",
      status: "in_progress",
      childThreadId,
      ...(agentType ? { agentType } : {}),
      ...(description ? { description } : {}),
      ...(prompt ? { prompt } : {}),
    };
    const run: Run = {
      key,
      parent,
      from,
      item,
      mapper: new AcpEventMapper({
        sessionId: this.o.sessionId,
        threadId: childThreadId,
        child: true,
        tools: this.o.tools,
        emit: (event) => this.observe(run, event),
        onToolDone: (state) => this.toolDone(run.mapper, state),
      }),
      ...(task.toolCallId ? { toolCallId: task.toolCallId } : {}),
      startedAt: this.now(),
      toolCalls: new Set(),
      open: true,
    };
    this.runs.push(run);
    this.o.emit({
      type: "thread.started",
      thread: {
        id: childThreadId,
        parentThreadId: parent.threadId,
        parentItemId: item.id,
        ...(description ? { title: description } : {}),
        ...(agentType ? { agentType } : {}),
      },
    });
    from.startItem(item);
    run.mapper.beginTurn(`turn-${key}`);
    if (prompt) run.mapper.userMessage({ text: prompt, attachments: [] });
    return run;
  }

  /** What the child thread shows feeds its card: tool calls and its last message. */
  private observe(run: Run, event: AgentEvent): void {
    if (event.type === "item.started" || event.type === "item.completed") {
      const item = event.item;
      if (item.kind === "tool_call") run.toolCalls.add(item.id);
      else if (event.type === "item.completed" && item.kind === "assistant_message") {
        if (item.text.trim()) run.lastMessage = item.text;
      }
    }
    this.o.emit(event);
  }

  /** A reported run ends with its parent tool call's result as its answer (or a failure). */
  private finishReported(run: Run, failure = ""): void {
    const result = this.taskResult(run);
    if (result && !failure) {
      run.mapper.emitItem({
        id: `result-${run.key}`,
        kind: "assistant_message",
        status: "completed",
        text: result,
      });
    }
    this.settle(run, failure ? "failed" : "completed", failure || undefined);
  }

  private enrich(run: Run, task: AcpTaskReport): void {
    if (task.durationMs !== undefined) run.durationMs = task.durationMs;
    const next = { ...run.item };
    if (!next.agentType && task.agentType) next.agentType = task.agentType;
    if (!next.prompt && task.prompt) next.prompt = task.prompt;
    if (!next.description && task.description) next.description = task.description;
    if (!run.open || JSON.stringify(next) === JSON.stringify(run.item)) return;
    run.item = next;
    this.o.emit({ type: "item.updated", ...run.parent, item: run.item });
  }

  /** End the run's child turn (and its own subagents first), then close its card. */
  private settle(run: Run, status: ItemStatus, note?: string): void {
    if (!run.open) return;
    run.open = false;
    for (const nested of this.runs) {
      if (nested.open && nested.parent.threadId === run.item.childThreadId)
        this.settle(nested, status === "completed" ? "completed" : "cancelled");
    }
    run.mapper.endTurn(outcomeOf(status, note));
    const summary =
      status === "completed"
        ? (run.lastMessage ?? (this.taskResult(run) || undefined))
        : (note ?? run.lastMessage);
    const durationMs = Math.max(0, Math.round(run.durationMs ?? this.now() - run.startedAt));
    const { summary: _summary, stats: _stats, ...rest } = run.item;
    run.item = {
      ...rest,
      status,
      ...(summary ? { summary } : {}),
      // A reported run's own steps are unknown, so it has no tool count.
      stats: { ...(run.childSession ? { toolUses: run.toolCalls.size } : {}), durationMs },
    };
    this.o.emit({ type: "item.completed", ...run.parent, item: run.item });
  }

  /** The text result of the parent's tool call that ran it, when the parent knows it. */
  private taskResult(run: Run): string {
    return run.toolCallId ? toolText(run.from.tool({ toolCallId: run.toolCallId })).trim() : "";
  }

  private now(): number {
    return this.o.now?.() ?? Date.now();
  }
}

function outcomeOf(status: ItemStatus, note?: string): AcpTurnOutcome {
  if (status === "completed") return { type: "completed" };
  if (status === "failed") return { type: "failed", message: note || "The subagent failed" };
  return { type: "interrupted", reason: "user" };
}

/** A failed child's message, when the update carries one. */
function errorOf(update: AcpSessionUpdate): string | undefined {
  const error = (update as { error?: unknown }).error;
  return (
    str(update, "message") ??
    str(error, "message") ??
    (typeof error === "string" ? error : undefined)
  );
}

/** Vendor details of an update: the first `_meta.<vendor>` object, else `_meta` itself. */
function vendorMeta(update: AcpSessionUpdate): Record<string, unknown> | undefined {
  const meta = (update as { _meta?: unknown })._meta;
  if (!meta || typeof meta !== "object") return undefined;
  const nested = Object.values(meta).find((v) => v && typeof v === "object" && !Array.isArray(v));
  return (nested ?? meta) as Record<string, unknown>;
}

function firstStr(records: unknown[], keys: string[]): string | undefined {
  for (const record of records) {
    for (const key of keys) {
      const value = str(record, key)?.trim();
      if (value) return value;
    }
  }
  return undefined;
}

/** A subagent type: a name, or `{ custom: name }`; `unspecified` is no type. */
export function agentTypeOf(value: unknown): string | undefined {
  const name = typeof value === "string" ? value : str(value, "custom");
  return name?.trim() && name !== "unspecified" ? name.trim() : undefined;
}

import type { AgentEvent, ItemOf, SubagentStats } from "@codeden/contracts";
import { str } from "../util/text";
import {
  statsFromTaskNotification,
  statsFromToolUseResult,
  statsFromUsageTrailer,
} from "./subagent-stats";
import { toolResultText } from "./tools";

/** A thread plus the turn currently running in it. */
export interface ThreadCtx {
  threadId: string;
  turnId: string;
}

interface Subagent {
  parent: ThreadCtx;
  child: ThreadCtx;
  item: ItemOf<"subagent">;
  background: boolean;
  done: boolean;
}

type Raw = Record<string, unknown>;

/**
 * Subagent (Agent/Task tool) runs as child threads (§7.3). The parent gets a `subagent` item;
 * messages tagged with `parent_tool_use_id` go to the child thread. Background subagents
 * finish on `task_notification`, foreground ones on their `tool_result`.
 */
export class SubagentTracker {
  private readonly runs = new Map<string, Subagent>();

  constructor(
    private readonly sessionId: string,
    private readonly emit: (event: AgentEvent) => void,
    private readonly newId: () => string,
    private readonly onThreadEnd: (ctx: ThreadCtx, finished: boolean) => void = () => {},
  ) {}

  ctx(toolUseId: string): ThreadCtx | undefined {
    return this.runs.get(toolUseId)?.child;
  }

  start(parent: ThreadCtx, toolUseId: string, input: Raw): void {
    if (this.runs.has(toolUseId)) return;
    const childThreadId = `${this.sessionId}:thread-${toolUseId}`;
    const agentType = str(input, "subagent_type") ?? "general-purpose";
    const description = str(input, "description");
    const item: ItemOf<"subagent"> = {
      id: toolUseId,
      kind: "subagent",
      status: "in_progress",
      childThreadId,
      agentType,
      ...(description ? { description } : {}),
      ...(str(input, "prompt") ? { prompt: str(input, "prompt") } : {}),
    };
    const child = { threadId: childThreadId, turnId: this.newId() };
    this.runs.set(toolUseId, {
      parent,
      child,
      item,
      background: input.run_in_background === true,
      done: false,
    });
    this.emit({
      type: "thread.started",
      thread: {
        id: childThreadId,
        parentThreadId: parent.threadId,
        parentItemId: toolUseId,
        agentType,
        ...(description ? { title: description } : {}),
      },
    });
    this.emit({ type: "item.started", ...parent, item });
    this.emit({ type: "turn.started", ...child });
  }

  onTaskStarted(msg: Raw): void {
    const run = this.runs.get(str(msg, "tool_use_id") ?? "");
    if (run && msg.is_backgrounded === true) run.background = true;
  }

  onToolResult(
    toolUseId: string,
    content: unknown,
    isError: boolean,
    toolUseResult: unknown,
  ): void {
    const run = this.runs.get(toolUseId);
    if (!run || run.done) return;
    const status = str(toolUseResult, "status");
    if (
      !isError &&
      (status === "async_launched" || (toolUseResult as Raw | undefined)?.isAsync === true)
    ) {
      run.background = true;
      return;
    }
    const text = toolResultText(content);
    const stats = statsFromToolUseResult(toolUseResult) ?? statsFromUsageTrailer(text);
    this.finish(toolUseId, isError ? "failed" : "completed", cleanSummary(text), stats);
  }

  onTaskNotification(msg: Raw): void {
    const toolUseId = str(msg, "tool_use_id");
    if (!toolUseId) return;
    const status = str(msg, "status");
    const summary = str(msg, "summary");
    this.finish(
      toolUseId,
      status === "completed" ? "completed" : status === "failed" ? "failed" : "interrupted",
      summary,
      statsFromTaskNotification(msg),
    );
  }

  /** Root turn interrupted or failed: foreground subagents of that turn stop with it. */
  interruptForeground(rootTurnId: string): void {
    for (const [id, run] of this.runs) {
      if (!run.done && !run.background && run.parent.turnId === rootTurnId)
        this.finish(id, "interrupted");
    }
  }

  interruptAll(): void {
    for (const id of this.runs.keys()) this.finish(id, "interrupted");
  }

  private finish(
    toolUseId: string,
    outcome: "completed" | "failed" | "interrupted",
    summary?: string,
    stats?: SubagentStats,
  ): void {
    const run = this.runs.get(toolUseId);
    if (!run || run.done) return;
    run.done = true;
    this.onThreadEnd(run.child, outcome === "completed");
    if (outcome === "completed") {
      this.emit({ type: "turn.completed", ...run.child, stopReason: "end_turn" });
    } else if (outcome === "failed") {
      this.emit({
        type: "turn.failed",
        ...run.child,
        error: { message: summary || "Subagent failed" },
      });
    } else {
      this.emit({ type: "turn.interrupted", ...run.child, reason: "user" });
    }
    const status =
      outcome === "completed" ? "completed" : outcome === "failed" ? "failed" : "cancelled";
    this.emit({
      type: "item.completed",
      ...run.parent,
      item: { ...run.item, status, ...(summary ? { summary } : {}), ...(stats ? { stats } : {}) },
    });
  }
}

/** Drop the CLI's internal trailer (agent ids, usage) from a subagent result. */
function cleanSummary(text: string): string {
  return text.split(/\n(?=agentId:|<usage>)/)[0]?.trim() ?? "";
}

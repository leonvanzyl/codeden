import type { AgentEvent, ItemOf, SubagentStats } from "@codeden/contracts";
import { str } from "../util/text";
import {
  statsFromTaskNotification,
  statsFromToolUseResult,
  statsFromUsageTrailer,
} from "./subagent-stats";
import { SubagentUsage } from "./subagent-usage";
import { toolResultText } from "./tools";

/** A thread plus the turn currently running in it. */
export interface ThreadCtx {
  threadId: string;
  turnId: string;
}

interface Subagent {
  parent: ThreadCtx;
  child: ThreadCtx;
  /** The card as last sent (its final form once done). */
  item: ItemOf<"subagent">;
  background: boolean;
  done: boolean;
  /** Claude Code's id for the run (its `task_id`), which names its transcript. */
  agentId?: string;
  /** Tokens per model of the run's own calls. */
  usage: SubagentUsage;
}

type Raw = Record<string, unknown>;

/**
 * Subagent (Agent/Task tool) runs as child threads (§7.3). The parent gets a `subagent` item;
 * messages tagged with `parent_tool_use_id` go to the child thread. Background subagents
 * finish on `task_notification`, foreground ones on their `tool_result`. The card's figures
 * include the run's tokens per model, from its streamed messages; `onFinished` lets the
 * session read the final figures from the run's transcript (`correctUsage`).
 */
export class SubagentTracker {
  private readonly runs = new Map<string, Subagent>();

  constructor(
    private readonly sessionId: string,
    private readonly emit: (event: AgentEvent) => void,
    private readonly newId: () => string,
    private readonly onThreadEnd: (ctx: ThreadCtx, finished: boolean) => void = () => {},
    private readonly onFinished: (toolUseId: string, agentId: string) => void = () => {},
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
      usage: new SubagentUsage(),
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
    if (!run) return;
    if (msg.is_backgrounded === true) run.background = true;
    run.agentId ??= str(msg, "task_id");
  }

  /** One of the run's own `assistant` messages (`parent_tool_use_id` is its tool use). */
  onAssistant(toolUseId: string, msg: Raw): void {
    const run = this.runs.get(toolUseId);
    if (!run || run.done) return;
    run.agentId ??= str(msg, "agent_id");
    if (msg.message && typeof msg.message === "object") run.usage.addFrame(msg.message as Raw);
  }

  /**
   * The final figures of a finished run's calls, from its transcript: the card is sent again
   * when they change what it shows (§7.3).
   */
  correctUsage(toolUseId: string, transcript: readonly unknown[]): void {
    const run = this.runs.get(toolUseId);
    if (!run?.done || !run.usage.applyTranscript(transcript)) return;
    const usage = run.usage.summary();
    if (!usage) return;
    run.item = { ...run.item, stats: { ...run.item.stats, usage } };
    this.emit({ type: "item.completed", ...run.parent, item: run.item });
  }

  onToolResult(
    toolUseId: string,
    content: unknown,
    isError: boolean,
    toolUseResult: unknown,
  ): void {
    const run = this.runs.get(toolUseId);
    if (!run || run.done) return;
    run.agentId ??= str(toolUseResult, "agentId");
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
    const run = this.runs.get(toolUseId);
    if (run) run.agentId ??= str(msg, "task_id");
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
    // What the run used so far, also when it stopped early.
    const usage = run.usage.summary();
    const figures = usage ? { ...stats, usage } : stats;
    run.item = {
      ...run.item,
      status,
      ...(summary ? { summary } : {}),
      ...(figures ? { stats: figures } : {}),
    };
    this.emit({ type: "item.completed", ...run.parent, item: run.item });
    if (usage && run.agentId) this.onFinished(toolUseId, run.agentId);
  }
}

/** Drop the CLI's internal trailer (agent ids, usage) from a subagent result. */
function cleanSummary(text: string): string {
  return text.split(/\n(?=agentId:|<usage>)/)[0]?.trim() ?? "";
}

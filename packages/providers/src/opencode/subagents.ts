import type { AgentEvent, ItemOf } from "@codeden/contracts";
import type { ToolState } from "./items";

/** A thread plus the turn running in it. */
export interface ThreadCtx {
  threadId: string;
  turnId: string;
}

export type SubagentOutcome = "completed" | "failed" | "interrupted";

interface SubagentRun {
  callId: string;
  parentSession: string;
  parent: ThreadCtx;
  child: ThreadCtx;
  item: ItemOf<"subagent">;
  childSession?: string;
  done: boolean;
}

/**
 * OpenCode's `subagent` tool calls as child threads (§7.3). Each call opens a `subagent` item in
 * its parent thread plus a child thread, linked to the OpenCode child session that runs it
 * (from `session.created` or the tool's progress metadata). Runs last until their turn ends.
 */
export class OpenCodeSubagents {
  private readonly runs = new Map<string, SubagentRun>();
  private readonly childSessions = new Map<string, SubagentRun>();

  constructor(
    private readonly sessionId: string,
    private readonly emit: (event: AgentEvent) => void,
    /** Close the items still open in a thread (a finished subagent's child thread). */
    private readonly closeOpen: (threadId: string, ok: boolean) => void,
  ) {}

  /** Whether a tool call is a subagent run of this turn. */
  has(callId: string): boolean {
    return this.runs.has(callId);
  }

  /** The child thread of a running subagent, by its OpenCode session. */
  ctxFor(session: string): ThreadCtx | undefined {
    const run = this.childSessions.get(session);
    return run && !run.done ? run.child : undefined;
  }

  /** Whether an OpenCode session runs one of this turn's subagents (its usage counts). */
  isChildSession(session: string): boolean {
    return this.childSessions.has(session);
  }

  /** A new child session: it belongs to its parent's subagent call that has no child yet. */
  onSessionCreated(session: string, parentSession: string): void {
    if (this.childSessions.has(session)) return;
    const run = [...this.runs.values()].find(
      (r) => !r.done && !r.childSession && r.parentSession === parentSession,
    );
    if (run) this.link(run, session);
  }

  /** The subagent tool's progress names its child session. */
  onProgress(callId: string, metadata: Record<string, unknown> | undefined): void {
    const run = this.runs.get(callId);
    const child = metadata?.sessionID;
    if (run && typeof child === "string") this.link(run, child);
  }

  start(state: ToolState & { session: string }, parent: ThreadCtx): void {
    if (this.runs.has(state.id)) return;
    const childThreadId = `${this.sessionId}:thread-${state.id}`;
    const agentType = typeof state.input.agent === "string" ? state.input.agent : "general";
    const description =
      typeof state.input.description === "string" ? state.input.description : undefined;
    const prompt = typeof state.input.prompt === "string" ? state.input.prompt : undefined;
    const item: ItemOf<"subagent"> = {
      id: state.id,
      kind: "subagent",
      status: "in_progress",
      childThreadId,
      agentType,
      ...(description ? { description } : {}),
      ...(prompt ? { prompt } : {}),
    };
    const run: SubagentRun = {
      callId: state.id,
      parentSession: state.session,
      parent,
      child: { threadId: childThreadId, turnId: `${state.id}-turn` },
      item,
      done: false,
    };
    this.runs.set(state.id, run);
    this.emit({
      type: "thread.started",
      thread: {
        id: childThreadId,
        parentThreadId: parent.threadId,
        parentItemId: state.id,
        agentType,
        ...(description ? { title: description } : {}),
      },
    });
    this.emit({ type: "item.started", ...parent, item });
    this.emit({ type: "turn.started", ...run.child });
  }

  /** The subagent tool call ended. */
  finish(callId: string, outcome: SubagentOutcome, summary?: string): void {
    const run = this.runs.get(callId);
    if (run) this.finishRun(run, outcome, summary);
  }

  /** The turn ended: finish the runs still going and forget them all. */
  endTurn(ok: boolean): void {
    for (const run of this.runs.values()) {
      if (!run.done) this.finishRun(run, ok ? "completed" : "interrupted");
    }
    this.runs.clear();
    this.childSessions.clear();
  }

  private link(run: SubagentRun, session: string): void {
    if (run.childSession === session) return;
    run.childSession = session;
    this.childSessions.set(session, run);
  }

  private finishRun(run: SubagentRun, outcome: SubagentOutcome, summary?: string): void {
    if (run.done) return;
    run.done = true;
    this.closeOpen(run.child.threadId, outcome === "completed");
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
      item: { ...run.item, status, ...(summary ? { summary } : {}) },
    });
  }
}

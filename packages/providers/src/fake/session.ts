import type {
  AgentEvent,
  AutonomyLevel,
  Item,
  RuntimeResponse,
  SessionOptions,
  TodoStatus,
  UserInput,
} from "@codeden/contracts";
import { type ProviderSession, ProviderSessionError, type SessionConfigChange } from "../adapter";
import { AsyncQueue } from "../async-queue";
import type { FakeProviderOptions } from "./adapter";
import { fakeMcpInput, fakeMcpResult } from "./mcp-result";

class Interrupted extends Error {}

type Todo = { text: string; status: TodoStatus };

interface TurnState {
  threadId: string;
  turnId: string;
  abort: AbortController;
}

/** A scripted, deterministic session. Ids are counters scoped to the session. */
export class FakeSession implements ProviderSession {
  readonly events: AsyncQueue<AgentEvent> = new AsyncQueue<AgentEvent>();
  private readonly rootThreadId: string;
  private readonly token: string;
  private counter = 0;
  private turn: TurnState | undefined;
  private readonly pending = new Map<string, (response: RuntimeResponse) => void>();

  constructor(
    private readonly opts: SessionOptions,
    private readonly fake: FakeProviderOptions,
  ) {
    this.autonomy = opts.autonomy;
    // A fork gets a conversation of its own at once, like the real providers.
    this.token =
      opts.resumeToken ??
      (opts.forkFrom ? `fake-fork-${opts.sessionId}` : `fake-${opts.sessionId}`);
    this.rootThreadId = `${opts.sessionId}:thread-root`;
    this.events.push({ type: "thread.started", thread: { id: this.rootThreadId } });
    this.events.push({ type: "session.updated", resumeToken: this.token, model: "fake-1" });
  }

  resumeToken(): string | undefined {
    return this.token;
  }

  /** Changes recorded by `configure` (tests read them through `lastConfig`). */
  lastConfig: SessionConfigChange = {};

  async configure(change: SessionConfigChange): Promise<void> {
    this.lastConfig = { ...this.lastConfig, ...change };
    if (change.model !== undefined) {
      this.events.push({ type: "session.updated", model: change.model ?? "fake-1" });
    }
  }

  /** Current autonomy. Full skips the scripted command approval, as it would for real. */
  autonomy: AutonomyLevel;

  async setAutonomy(level: AutonomyLevel): Promise<void> {
    this.autonomy = level;
  }

  async send(input: UserInput): Promise<void> {
    if (this.events.isClosed) throw new ProviderSessionError("closed", "Session is closed");
    if (this.turn) throw new ProviderSessionError("turn_running", "A turn is already running");
    const turn: TurnState = {
      threadId: this.rootThreadId,
      turnId: this.nextId("turn"),
      abort: new AbortController(),
    };
    this.turn = turn;
    void this.runTurn(turn, input).finally(() => {
      if (this.turn === turn) this.turn = undefined;
    });
  }

  async steer(input: UserInput): Promise<void> {
    const turn = this.turn;
    if (!turn) throw new ProviderSessionError("no_turn", "No turn is running");
    const item: Item = {
      id: this.nextId("item"),
      kind: "user_message",
      status: "completed",
      input,
    };
    this.emit({ type: "item.completed", threadId: turn.threadId, turnId: turn.turnId, item });
  }

  async interrupt(): Promise<void> {
    this.turn?.abort.abort();
  }

  async respond(requestId: string, response: RuntimeResponse): Promise<void> {
    const resolve = this.pending.get(requestId);
    if (!resolve) throw new ProviderSessionError("unknown_request", `Unknown request ${requestId}`);
    this.pending.delete(requestId);
    resolve(response);
  }

  async close(): Promise<void> {
    this.turn?.abort.abort();
    // Let an aborted turn emit its final event before the stream ends.
    await new Promise((r) => setImmediate(r));
    this.events.close();
  }

  // ------------------------------------------------------------------ script

  private async runTurn(turn: TurnState, input: UserInput): Promise<void> {
    const { threadId, turnId } = turn;
    const prompt = input.text;
    try {
      this.emit({ type: "turn.started", threadId, turnId });
      await this.step(turn);
      const userItem: Item = {
        id: this.nextId("item"),
        kind: "user_message",
        status: "completed",
        input,
      };
      this.emit({ type: "item.completed", threadId, turnId, item: userItem });

      if (prompt.includes("[fail]")) {
        await this.step(turn);
        this.emit({
          type: "turn.failed",
          threadId,
          turnId,
          error: { code: "fake_failure", message: "Scripted failure", retryable: true },
        });
        return;
      }
      // Classified failures: `[fail:transient]` (an overloaded API) and `[fail:usage]` (a usage
      // limit that resets a second later).
      if (prompt.includes("[fail:transient]") || prompt.includes("[fail:usage]")) {
        await this.step(turn);
        const usage = prompt.includes("[fail:usage]");
        this.emit({
          type: "turn.failed",
          threadId,
          turnId,
          error: usage
            ? {
                code: "usage_limit",
                message: "Scripted usage limit",
                retryable: true,
                kind: "usage_limit",
                retryAt: new Date(Date.now() + 1000).toISOString(),
              }
            : {
                code: "overloaded",
                message: "Scripted overload",
                retryable: true,
                kind: "transient",
              },
        });
        return;
      }

      await this.streamAssistant(turn, threadId, this.replyFor(prompt));
      await this.todoList(turn);
      if (prompt.includes("[mcp]")) await this.mcpToolCall(turn);
      // The read_only level never runs the scripted (writing) command, so nothing asks either.
      const readOnly = this.autonomy === "read_only";
      const asks =
        !readOnly &&
        (this.fake.approval || prompt.includes("[approval]")) &&
        this.autonomy !== "full";
      const approved = asks ? await this.approval(turn) : true;
      if (approved && !readOnly) await this.commandToolCall(turn);
      if (this.fake.subagent || prompt.includes("[subagent]")) await this.subagent(turn);
      if (this.fake.followups ?? true) {
        await this.step(turn);
        const item: Item = {
          id: this.nextId("item"),
          kind: "followups",
          status: "completed",
          source: "agent",
          suggestions: [
            { label: "Add tests", prompt: "Add tests for the change you just made." },
            { label: "Open a PR", prompt: "Open a pull request with a summary of the change." },
          ],
        };
        this.emit({ type: "item.completed", threadId, turnId, item });
      }
      this.emit({
        type: "usage.updated",
        threadId,
        turnId,
        usage: { inputTokens: prompt.length, outputTokens: 42, costUsd: 0 },
      });
      this.emit({ type: "turn.completed", threadId, turnId, stopReason: "end_turn" });
    } catch (error) {
      if (error instanceof Interrupted) {
        this.emit({ type: "turn.interrupted", threadId, turnId, reason: "user" });
        return;
      }
      const message = error instanceof Error ? error.message : String(error);
      this.emit({ type: "turn.failed", threadId, turnId, error: { message } });
    }
  }

  private async streamAssistant(turn: TurnState, threadId: string, text: string): Promise<void> {
    const { turnId } = turn;
    const id = this.nextId("item");
    const started: Item = { id, kind: "assistant_message", status: "in_progress", text: "" };
    this.emit({ type: "item.started", threadId, turnId, item: started });
    const words = text.split(/(?<= )/);
    for (const word of words) {
      await this.step(turn);
      this.emit({
        type: "item.delta",
        threadId,
        turnId,
        itemId: id,
        delta: { type: "text", text: word },
      });
    }
    const done: Item = { id, kind: "assistant_message", status: "completed", text };
    this.emit({ type: "item.completed", threadId, turnId, item: done });
  }

  private async todoList(turn: TurnState): Promise<void> {
    const { threadId, turnId } = turn;
    const id = this.nextId("item");
    const todos = (status: "in_progress" | "completed"): Todo[] => [
      { text: "Read the request", status: "completed" },
      { text: "Run the checks", status },
    ];
    await this.step(turn);
    this.emit({
      type: "item.started",
      threadId,
      turnId,
      item: { id, kind: "todo_list", status: "in_progress", todos: todos("in_progress") },
    });
    this.pendingTodo = { id, todos };
  }

  private pendingTodo:
    | { id: string; todos: (s: "in_progress" | "completed") => Todo[] }
    | undefined;

  private async approval(turn: TurnState): Promise<boolean> {
    const { threadId, turnId } = turn;
    const id = this.nextId("item");
    const requestId = this.nextId("request");
    const base = {
      id,
      kind: "approval_request" as const,
      requestId,
      action: "command" as const,
      title: "Run `echo hello` outside the sandbox",
      reason: "Scripted approval from the Fake provider",
      command: "echo hello",
      options: ["allow_once", "allow_session", "deny"] as (
        | "allow_once"
        | "allow_session"
        | "deny"
      )[],
    };
    await this.step(turn);
    this.emit({ type: "item.started", threadId, turnId, item: { ...base, status: "in_progress" } });
    const response = await this.waitForResponse(turn, requestId);
    const decision = response.kind === "approval" ? response.decision : "deny";
    const allowed = decision !== "deny";
    this.emit({
      type: "item.completed",
      threadId,
      turnId,
      item: {
        ...base,
        status: allowed ? "completed" : "declined",
        decision,
        decidedBy: response.kind === "approval" ? (response.decidedBy ?? "user") : "user",
      },
    });
    if (!allowed) {
      this.emit({
        type: "item.completed",
        threadId,
        turnId,
        item: {
          id: this.nextId("item"),
          kind: "notice",
          status: "completed",
          level: "info",
          message: "Command skipped: approval denied.",
        },
      });
    }
    return allowed;
  }

  /** An MCP tool call with a long, one-line JSON result (`[mcp]` in the prompt). */
  private async mcpToolCall(turn: TurnState): Promise<void> {
    const { threadId, turnId } = turn;
    const base = {
      id: this.nextId("item"),
      kind: "tool_call" as const,
      toolKind: "mcp" as const,
      toolName: "mcp__codeden__triage_issue",
      server: "codeden",
      tool: "triage_issue",
      title: "codeden: triage_issue",
      input: fakeMcpInput,
    };
    await this.step(turn);
    this.emit({ type: "item.started", threadId, turnId, item: { ...base, status: "in_progress" } });
    await this.step(turn);
    this.emit({
      type: "item.completed",
      threadId,
      turnId,
      item: {
        ...base,
        status: "completed",
        output: { text: fakeMcpResult(), truncated: false },
        durationMs: 12,
      },
    });
  }

  private async commandToolCall(turn: TurnState): Promise<void> {
    const { threadId, turnId } = turn;
    const id = this.nextId("item");
    const base = {
      id,
      kind: "tool_call" as const,
      toolKind: "command" as const,
      toolName: "shell",
      title: "Run echo hello",
      command: "echo hello",
      cwd: this.opts.cwd,
    };
    await this.step(turn);
    this.emit({ type: "item.started", threadId, turnId, item: { ...base, status: "in_progress" } });
    await this.step(turn);
    this.emit({
      type: "item.delta",
      threadId,
      turnId,
      itemId: id,
      delta: { type: "tool_output", text: "hello\n", stream: "stdout" },
    });
    this.emit({
      type: "item.completed",
      threadId,
      turnId,
      item: {
        ...base,
        status: "completed",
        exitCode: 0,
        output: { text: "hello\n", truncated: false },
        durationMs: 5,
      },
    });
    const todo = this.pendingTodo;
    if (todo) {
      this.pendingTodo = undefined;
      this.emit({
        type: "item.completed",
        threadId,
        turnId,
        item: {
          id: todo.id,
          kind: "todo_list",
          status: "completed",
          todos: todo.todos("completed"),
        },
      });
    }
  }

  private async subagent(turn: TurnState): Promise<void> {
    const { threadId, turnId } = turn;
    const itemId = this.nextId("item");
    const childThreadId = `${this.opts.sessionId}:thread-${this.nextId("sub")}`;
    const base = {
      id: itemId,
      kind: "subagent" as const,
      childThreadId,
      agentType: "reviewer",
      description: "Review the change",
    };
    await this.step(turn);
    this.emit({
      type: "thread.started",
      thread: {
        id: childThreadId,
        parentThreadId: threadId,
        parentItemId: itemId,
        agentType: "reviewer",
      },
    });
    this.emit({ type: "item.started", threadId, turnId, item: { ...base, status: "in_progress" } });
    const child: TurnState = {
      threadId: childThreadId,
      turnId: this.nextId("turn"),
      abort: turn.abort,
    };
    this.emit({ type: "turn.started", threadId: childThreadId, turnId: child.turnId });
    await this.streamAssistant(child, childThreadId, "Reviewed: no issues found.");
    this.emit({
      type: "turn.completed",
      threadId: childThreadId,
      turnId: child.turnId,
      stopReason: "end_turn",
    });
    this.emit({
      type: "item.completed",
      threadId,
      turnId,
      item: {
        ...base,
        status: "completed",
        summary: "No issues found.",
        stats: { totalTokens: 48_213, toolUses: 23, durationMs: 72_000 },
      },
    });
  }

  // ------------------------------------------------------------------ helpers

  private waitForResponse(turn: TurnState, requestId: string): Promise<RuntimeResponse> {
    return new Promise((resolve, reject) => {
      const onAbort = () => {
        this.pending.delete(requestId);
        reject(new Interrupted());
      };
      if (turn.abort.signal.aborted) return onAbort();
      turn.abort.signal.addEventListener("abort", onAbort, { once: true });
      this.pending.set(requestId, (response) => {
        turn.abort.signal.removeEventListener("abort", onAbort);
        resolve(response);
      });
    });
  }

  /** Wait `delayMs` (or yield), then throw if the turn was interrupted. */
  private async step(turn: TurnState): Promise<void> {
    const delay = this.fake.delayMs ?? 0;
    await new Promise((r) => (delay > 0 ? setTimeout(r, delay) : setImmediate(r)));
    if (turn.abort.signal.aborted) throw new Interrupted();
  }

  private replyFor(prompt: string): string {
    return this.fake.reply ? this.fake.reply(prompt) : `Echo: ${prompt}`;
  }

  private emit(event: AgentEvent): void {
    this.events.push(event);
  }

  private nextId(kind: string): string {
    this.counter += 1;
    return `${kind}-${this.counter}`;
  }
}

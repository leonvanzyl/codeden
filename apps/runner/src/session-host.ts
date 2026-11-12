import type {
  AgentEvent,
  RunnerCommandOf,
  RunnerEvent,
  RunnerSessionInfo,
} from "@codeden/contracts";
import type { ProviderRegistry, ProviderSession } from "@codeden/providers";
import { DeltaBatcher } from "./delta-batcher";
import { CommandError } from "./errors";
import { createCheckpoint, nextCheckpointIndex } from "./git/checkpoints";
import { isWorkTree } from "./git/exec";

export { CommandError };

interface Hosted {
  providerId: string;
  session: ProviderSession;
  state: RunnerSessionInfo["state"];
  rootThreadId: string | undefined;
  cwd: string;
  checkpoints: boolean;
  /** Serializes checkpoint writes for this session. */
  checkpointChain: Promise<void>;
  /** Emits the session's agent events, streamed deltas batched. */
  events: DeltaBatcher;
  /** Why the session is closing, reported with its exit event. */
  closeReason?: "stopped" | "runner_exit";
  /** A running turn was interrupted by a drain: report it as a runner restart. */
  drainInterrupted: boolean;
  /** A root turn was running when the runner started closing the session. */
  turnCutOff: boolean;
}

export interface SessionHostOptions {
  log?: (message: string) => void;
}

/**
 * Owns live provider sessions on this runner and pumps their normalized events into the
 * journal (via `emit`), streamed deltas batched (`DeltaBatcher`). Sessions outlive server
 * connections. Any number run concurrently.
 * When the cwd is a git work tree, the host writes turn checkpoints (§9): a baseline when
 * the session starts and one after every root-thread turn ends.
 */
export class SessionHost {
  private readonly sessions = new Map<string, Hosted>();

  constructor(
    private readonly registry: ProviderRegistry,
    private readonly emit: (event: RunnerEvent) => void,
    private readonly opts: SessionHostOptions = {},
  ) {}

  list(): RunnerSessionInfo[] {
    return [...this.sessions.entries()].map(([sessionId, h]) => ({
      sessionId,
      providerId: h.providerId,
      state: h.state,
      resumeToken: h.session.resumeToken() ?? null,
    }));
  }

  /** Working directories of the hosted sessions, by session id. */
  cwds(): Map<string, string> {
    return new Map([...this.sessions.entries()].map(([id, h]) => [id, h.cwd]));
  }

  /** Number of sessions with a running turn. */
  get running(): number {
    return [...this.sessions.values()].filter((h) => h.state === "running").length;
  }

  async start(cmd: RunnerCommandOf<"session.start">): Promise<{ resumeToken: string | null }> {
    if (this.sessions.has(cmd.sessionId)) {
      throw new CommandError("session_exists", `Session ${cmd.sessionId} is already running`);
    }
    const adapter = this.registry.get(cmd.providerId);
    if (!adapter) {
      const available = this.registry.list().map((a) => a.id);
      throw new CommandError(
        "unknown_provider",
        `Provider ${cmd.providerId} is not available on this runner` +
          (available.length > 0 ? ` (available: ${available.join(", ")})` : ""),
      );
    }
    this.emit({ kind: "session.process", sessionId: cmd.sessionId, state: "starting" });
    let session: ProviderSession;
    try {
      session = await adapter.openSession(cmd.options);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.emit({
        kind: "session.process",
        sessionId: cmd.sessionId,
        state: "crashed",
        error: { code: "open_failed", message },
      });
      throw new CommandError("open_failed", `Could not open the session: ${message}`);
    }
    const checkpoints = cmd.checkpoints !== false && (await isWorkTree(cmd.options.cwd));
    const hosted: Hosted = {
      providerId: cmd.providerId,
      session,
      state: "idle",
      rootThreadId: undefined,
      cwd: cmd.options.cwd,
      checkpoints,
      checkpointChain: Promise.resolve(),
      events: new DeltaBatcher((event) =>
        this.emit({ kind: "agent", sessionId: cmd.sessionId, event }),
      ),
      drainInterrupted: false,
      turnCutOff: false,
    };
    this.sessions.set(cmd.sessionId, hosted);
    if (checkpoints) this.checkpoint(cmd.sessionId, hosted, undefined, true);
    this.emit({ kind: "session.process", sessionId: cmd.sessionId, state: "ready" });
    void this.pump(cmd.sessionId, hosted);
    if (cmd.input) {
      // The baseline must capture the tree before the first turn touches it.
      await hosted.checkpointChain;
      await session.send(cmd.input);
    }
    return { resumeToken: session.resumeToken() ?? null };
  }

  async send(cmd: RunnerCommandOf<"session.send">): Promise<void> {
    const hosted = this.get(cmd.sessionId);
    await hosted.checkpointChain;
    await hosted.session.send(cmd.input);
  }

  async steer(cmd: RunnerCommandOf<"session.steer">): Promise<void> {
    const { session } = this.get(cmd.sessionId);
    if (!session.steer) throw new CommandError("unsupported", "This provider cannot steer turns");
    await session.steer(cmd.input);
  }

  async interrupt(sessionId: string): Promise<void> {
    await this.get(sessionId).session.interrupt();
  }

  /**
   * Model/effort for the next turn, the autonomy level and plan mode, when the provider can
   * change them live. Checks every requested setting before applying any.
   */
  async configure(cmd: RunnerCommandOf<"session.configure">): Promise<void> {
    const { session } = this.get(cmd.sessionId);
    const change: { model?: string | null; effort?: typeof cmd.effort } = {};
    if (cmd.model !== undefined) change.model = cmd.model;
    if (cmd.effort !== undefined) change.effort = cmd.effort;
    const modelOrEffort = Object.keys(change).length > 0;
    if (modelOrEffort && !session.configure) {
      throw new CommandError("unsupported", "This provider cannot change model or effort live");
    }
    if (cmd.autonomy !== undefined && !session.setAutonomy) {
      throw new CommandError("unsupported", "This provider cannot change autonomy live");
    }
    if (cmd.planMode !== undefined && !session.setPlanMode) {
      throw new CommandError("unsupported", "This provider has no plan mode");
    }
    if (modelOrEffort) await session.configure?.(change);
    if (cmd.autonomy !== undefined) await session.setAutonomy?.(cmd.autonomy);
    if (cmd.planMode !== undefined) await session.setPlanMode?.(cmd.planMode);
  }

  async respond(cmd: RunnerCommandOf<"session.respond">): Promise<void> {
    await this.get(cmd.sessionId).session.respond(cmd.requestId, cmd.response);
  }

  async stop(sessionId: string, reason: "stopped" | "runner_exit" = "stopped"): Promise<void> {
    const hosted = this.get(sessionId);
    if (hosted.state === "running" && reason === "runner_exit") hosted.turnCutOff = true;
    hosted.closeReason ??= reason;
    hosted.state = "closing";
    await hosted.session.close();
    hosted.events.flush();
    await hosted.checkpointChain;
  }

  async closeAll(): Promise<void> {
    await Promise.all(
      [...this.sessions.keys()].map((id) => this.stop(id, "runner_exit").catch(() => undefined)),
    );
  }

  /**
   * Let running turns finish (up to `timeoutMs`), interrupt whatever is still running,
   * and wait for pending checkpoints. Sessions stay open (resumable) until `closeAll`.
   */
  async drain(timeoutMs: number): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (this.running > 0 && Date.now() < deadline) await sleep(100);
    const stuck = [...this.sessions.values()].filter((h) => h.state === "running");
    for (const h of stuck) h.drainInterrupted = true;
    await Promise.all(stuck.map((h) => h.session.interrupt().catch(() => undefined)));
    const settle = Date.now() + 5_000;
    while (this.running > 0 && Date.now() < settle) await sleep(50);
    await Promise.all([...this.sessions.values()].map((h) => h.checkpointChain));
  }

  /**
   * Wait until every pending checkpoint of a session has been written, including any queued
   * while waiting (tests, drain, `checkpoint.list` with `settled`). A session this runner
   * doesn't host has none pending.
   */
  async settled(sessionId: string): Promise<void> {
    for (;;) {
      const chain = this.sessions.get(sessionId)?.checkpointChain;
      if (!chain) return;
      await chain;
      if (this.sessions.get(sessionId)?.checkpointChain === chain) return;
    }
  }

  private get(sessionId: string): Hosted {
    const hosted = this.sessions.get(sessionId);
    if (!hosted) throw new CommandError("unknown_session", `Session ${sessionId} is not running`);
    return hosted;
  }

  /**
   * Queue a checkpoint. The baseline (index 0) is only written when the session has none
   * yet, so a resumed session continues its numbering.
   */
  private checkpoint(sessionId: string, hosted: Hosted, turnId?: string, baseline = false): void {
    hosted.checkpointChain = hosted.checkpointChain.then(async () => {
      try {
        const index = await nextCheckpointIndex(hosted.cwd, sessionId);
        if (baseline && index > 0) return;
        const cp = await createCheckpoint(hosted.cwd, sessionId, index, turnId);
        hosted.events.flush();
        this.emit({
          kind: "checkpoint.created",
          sessionId,
          index: cp.index,
          ref: cp.ref,
          commit: cp.commit,
          ...(turnId ? { turnId } : {}),
        });
      } catch (error) {
        this.opts.log?.(`checkpoint failed for ${sessionId}: ${(error as Error).message}`);
      }
    });
  }

  private async pump(sessionId: string, hosted: Hosted): Promise<void> {
    try {
      for await (const raw of hosted.session.events) {
        const event = this.rewrite(hosted, raw);
        // Track first: a turn's end queues its checkpoint before the server hears the turn
        // ended, so anything it asks after that (`settled`) waits for that checkpoint.
        this.track(sessionId, hosted, event);
        hosted.events.push(event);
      }
      hosted.events.flush();
      await hosted.checkpointChain;
      this.emit({
        kind: "session.process",
        sessionId,
        state: "exited",
        exitCode: 0,
        reason: hosted.closeReason ?? "ended",
        ...(hosted.closeReason === "runner_exit"
          ? { interruptedTurn: hosted.turnCutOff || hosted.drainInterrupted }
          : {}),
      });
    } catch (error) {
      hosted.events.flush();
      const message = error instanceof Error ? error.message : String(error);
      this.emit({
        kind: "session.process",
        sessionId,
        state: "crashed",
        error: { code: "provider_crashed", message },
      });
    } finally {
      this.sessions.delete(sessionId);
    }
  }

  /** A drain-interrupted root turn is reported as cut off by a runner restart. */
  private rewrite(hosted: Hosted, event: AgentEvent): AgentEvent {
    if (
      hosted.drainInterrupted &&
      event.type === "turn.interrupted" &&
      event.threadId === hosted.rootThreadId
    ) {
      return { ...event, reason: "runner_restart" };
    }
    return event;
  }

  private track(sessionId: string, hosted: Hosted, event: AgentEvent): void {
    if (event.type === "thread.started" && !event.thread.parentThreadId) {
      hosted.rootThreadId = event.thread.id;
    }
    const onRoot = "threadId" in event && event.threadId === hosted.rootThreadId;
    if (!onRoot) return;
    if (event.type === "turn.started" && hosted.state !== "closing") hosted.state = "running";
    if (
      event.type === "turn.completed" ||
      event.type === "turn.failed" ||
      event.type === "turn.interrupted"
    ) {
      if (hosted.state !== "closing") hosted.state = "idle";
      if (hosted.checkpoints) this.checkpoint(sessionId, hosted, event.turnId);
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

import type {
  AgentEvent,
  AutonomyLevel,
  ModelInfo,
  ProviderCapabilities,
  ProviderInfo,
  ProviderStatus,
  ReasoningEffort,
  RuntimeResponse,
  SessionOptions,
  UserInput,
} from "@codeden/contracts";
import type { UtilityModel } from "./utility";

/**
 * A provider adapter (§7.1), loaded by the runner. One instance per provider; it opens any
 * number of sessions. Adapters translate provider-native protocols into `AgentEvent`s and
 * never leak provider-specific shapes.
 */
export interface ProviderAdapter {
  /** `claude`, `codex`, `fake`, ... */
  readonly id: string;
  readonly displayName: string;
  /** Installed? Version? Logged in? (§14). Must not throw; report problems as issues. */
  detect(): Promise<ProviderStatus>;
  /** Honest capability flags (Principle 5). */
  capabilities(): ProviderCapabilities;
  /** Models the provider offers (the last known list; see `refreshModels`). */
  models(): ModelInfo[];
  /**
   * Ask the provider for its current model list, without a session or a turn, and keep it for
   * `models()`. Optional. Must not throw: on failure `models()` keeps its last good list, or
   * an honest fallback.
   */
  refreshModels?(opts?: RefreshModelsOptions): Promise<void>;
  /**
   * Call `listener` whenever `models()` changes (discovery, a session reporting its models).
   * Optional. Returns the unsubscribe function.
   */
  onModelsChanged?(listener: () => void): () => void;
  openSession(opts: SessionOptions): Promise<ProviderSession>;
  /**
   * Copy the conversation behind `resumeToken` into a new one and return the copy's resume
   * token; the original is never written to. Present exactly when `capabilities().fork`.
   * `cwd` is an existing folder of the project (the copy is resumed from its own worktree).
   */
  forkConversation?(resumeToken: string, opts: ForkConversationOptions): Promise<string>;
  /** One-shot, tool-less model calls for side jobs (§7.4), when the provider supports them. */
  utilityModel?(): UtilityModel;
}

/** Options for `ProviderAdapter.forkConversation`. */
export interface ForkConversationOptions {
  /** An existing folder of the project, for providers that run a process to fork. */
  cwd: string;
  /**
   * Copy only through the turn that reported this fork point (`forkPoint` on a root turn's
   * end event); later turns are left out. When the conversation no longer holds that point
   * (it was replaced or deleted), throws a `ProviderSessionError` with code
   * `FORK_POINT_MISSING`, never falling back to a whole copy. Only adapters that report fork
   * points get one.
   */
  upTo?: string;
}

/** `ProviderSessionError` code: the conversation doesn't hold the fork point it was asked for. */
export const FORK_POINT_MISSING = "fork_point_missing";

/** Options for `ProviderAdapter.refreshModels`. */
export interface RefreshModelsOptions {
  /**
   * Skip the refresh when the provider confirmed its list less than this long ago and its
   * executable has not changed since. Without it, the provider is always asked.
   */
  maxAgeMs?: number;
}

/** A live provider session. */
export interface ProviderSession {
  /** Normalized event stream. Ends after `close()` or when the provider process exits. */
  readonly events: AsyncIterable<AgentEvent>;
  /** Start a turn. Rejects if a turn is already running. */
  send(input: UserInput): Promise<void>;
  /** Inject input into the running turn. Present only when `capabilities().steer`. */
  steer?(input: UserInput): Promise<void>;
  /** Stop the running turn; emits `turn.interrupted`. No-op when idle. */
  interrupt(): Promise<void>;
  /** Answer an `approval_request` or `user_question` by its `requestId`. */
  respond(requestId: string, response: RuntimeResponse): Promise<void>;
  /**
   * Change model and/or effort for the next turn (`null` = provider default). Optional:
   * without it, CodeDen applies the change by reopening the session through its resume token.
   */
  configure?(change: SessionConfigChange): Promise<void>;
  /**
   * Change the autonomy level (§11.2). With `capabilities().liveAutonomy` it applies from the
   * next tool call, even inside a running turn; otherwise from the next turn. Approvals
   * already waiting stay waiting. Optional: without it, the level applies on the next resume.
   */
  setAutonomy?(level: AutonomyLevel): Promise<void>;
  /**
   * Turn plan mode on or off. Present only when `capabilities().planMode`. On: the agent plans
   * without editing and asks to implement through a `plan` approval. Off: the session returns
   * to its autonomy level. A session that leaves plan mode on its own (the plan was approved)
   * reports it with `session.updated { planMode: false }`.
   */
  setPlanMode?(on: boolean): Promise<void>;
  /** Close the session and end `events`. Idempotent. */
  close(): Promise<void>;
  /** Provider session/thread id for resume, once known. */
  resumeToken(): string | undefined;
}

/** A mid-session model/effort change (`session.configure`). Absent keys stay unchanged. */
export interface SessionConfigChange {
  model?: string | null;
  effort?: ReasoningEffort | null;
}

/**
 * Session options ready to open (`SessionOptions.forkFrom`): with `forkFrom` and no
 * `resumeToken`, the conversation is copied first (`forkConversation`) and the session resumes
 * the copy. A `resumeToken` wins. A provider that can't fork refuses, rather than quietly
 * opening a conversation without the history.
 */
export async function withFork(
  adapter: ProviderAdapter,
  opts: SessionOptions,
): Promise<SessionOptions> {
  if (!opts.forkFrom || opts.resumeToken) return opts;
  if (!adapter.capabilities().fork || !adapter.forkConversation) {
    throw new ProviderSessionError(
      "unsupported",
      `${adapter.displayName} cannot fork a conversation`,
    );
  }
  const resumeToken = await adapter.forkConversation(opts.forkFrom, { cwd: opts.cwd });
  return { ...opts, resumeToken };
}

/** Static description of an adapter, as sent in the runner handshake. */
export function providerInfo(adapter: ProviderAdapter): ProviderInfo {
  return {
    id: adapter.id,
    displayName: adapter.displayName,
    capabilities: adapter.capabilities(),
    models: adapter.models(),
  };
}

/** Error thrown by sessions for invalid calls (unknown request id, turn already running). */
export class ProviderSessionError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "ProviderSessionError";
  }
}

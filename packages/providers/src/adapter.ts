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
  forkConversation?(resumeToken: string, opts: { cwd: string }): Promise<string>;
  /** One-shot, tool-less model calls for side jobs (§7.4), when the provider supports them. */
  utilityModel?(): UtilityModel;
}

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

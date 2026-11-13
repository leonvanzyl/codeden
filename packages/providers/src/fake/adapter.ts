import type {
  ModelInfo,
  ProviderCapabilities,
  ProviderStatus,
  SessionOptions,
} from "@codeden/contracts";
import {
  type ForkConversationOptions,
  type ProviderAdapter,
  type ProviderSession,
  withFork,
} from "../adapter";
import { FakeSession } from "./session";

/** Options for the scripted Fake provider. */
export interface FakeProviderOptions {
  /** Delay between emitted events in ms (0 = yield only). Default 0. */
  delayMs?: number;
  /** Always raise an approval request before the tool call. Also triggered by `[approval]` in the prompt. */
  approval?: boolean;
  /** Always run a subagent child thread. Also triggered by `[subagent]` in the prompt. */
  subagent?: boolean;
  /** Emit a followups item at the end of each turn. Default true. */
  followups?: boolean;
  /** Assistant reply for a prompt. Default: `Echo: <prompt>`. */
  reply?: (prompt: string) => string;
}

const capabilities: ProviderCapabilities = {
  resume: true,
  steer: true,
  interrupt: true,
  approvals: true,
  userQuestions: false,
  subagents: true,
  rollback: false,
  fork: true,
  images: false,
  planMode: true,
  reasoningEffort: false,
  mcp: false,
  skills: false,
  liveAutonomy: true,
  readOnly: true,
};

/**
 * Deterministic scripted provider for demos and tests (§7.2). Every turn streams:
 * user message, assistant message (word deltas), a todo list, a command tool call,
 * optionally an approval request (waits for `respond`) and a subagent child thread,
 * followups, usage, then `turn.completed`. Prompts containing `[fail]` fail the turn;
 * `[mcp]` adds an MCP tool call with a long JSON result before the command. In plan mode a
 * turn first proposes a plan and waits for its approval (`./plan`).
 */
export class FakeProvider implements ProviderAdapter {
  readonly id = "fake";
  readonly displayName = "Fake (scripted)";

  constructor(private readonly options: FakeProviderOptions = {}) {}

  async detect(): Promise<ProviderStatus> {
    return {
      providerId: this.id,
      installed: true,
      version: "1.0.0",
      executablePath: null,
      loggedIn: true,
      authMethod: "none",
      account: null,
      loginExpiresAt: null,
      supported: true,
      issues: [],
      checkedAt: new Date().toISOString(),
    };
  }

  capabilities(): ProviderCapabilities {
    return { ...capabilities };
  }

  models(): ModelInfo[] {
    return [{ id: "fake-1", label: "Fake 1", efforts: [], isDefault: true }];
  }

  async openSession(opts: SessionOptions): Promise<ProviderSession> {
    return new FakeSession(await withFork(this, opts), this.options);
  }

  /**
   * A fork gets a conversation of its own, named after the one it copies and, with `upTo`,
   * the turn it ends with (`<token>:fork-<n>@<turn>`).
   */
  async forkConversation(resumeToken: string, opts?: ForkConversationOptions): Promise<string> {
    this.forks += 1;
    return `${resumeToken}:fork-${this.forks}${opts?.upTo ? `@${opts.upTo}` : ""}`;
  }

  private forks = 0;
}

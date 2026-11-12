import type {
  ModelInfo,
  ProviderCapabilities,
  ProviderStatus,
  ReasoningEffort,
  SessionOptions,
} from "@codeden/contracts";
import {
  type ForkConversationOptions,
  type ProviderAdapter,
  type ProviderSession,
  type RefreshModelsOptions,
  withFork,
} from "../adapter";
import { executableFingerprint, ModelFreshness } from "../freshness";
import { ModelCatalog } from "../models";
import type { ResolvedCommand } from "../util/exec";
import { quickLocate } from "../util/locate";
import type { UtilityModel } from "../utility";
import { detectClaude } from "./detect";
import { forkClaudeConversation } from "./fork";
import { listClaudeModels, toModelInfos } from "./models";
import { ClaudeUtilityModel } from "./one-shot";
import { type ClaudeSdkModule, claudeSdkReady, loadClaudeSdk } from "./sdk";
import { ClaudeSession } from "./session";

export const CLAUDE_PROVIDER_ID = "claude";

const capabilities: ProviderCapabilities = {
  resume: true,
  steer: true,
  interrupt: true,
  approvals: true,
  userQuestions: true,
  subagents: true,
  rollback: false,
  // The SDK copies a conversation into a new session file (`forkConversation`).
  fork: true,
  images: true,
  planMode: true,
  reasoningEffort: true,
  mcp: true,
  skills: true,
  // CodeDen's policy gates every tool call, so a change applies from the next one.
  liveAutonomy: true,
  readOnly: true,
};

const EFFORTS: ReasoningEffort[] = ["low", "medium", "high", "xhigh", "max"];

/** Fallback model list (CLI aliases) until discovery or a session reports the real one. */
const FALLBACK_MODELS: ModelInfo[] = [
  {
    id: "default",
    label: "Default",
    description: "Claude Code's default model",
    efforts: EFFORTS,
    isDefault: true,
  },
  { id: "opus", label: "Opus", efforts: EFFORTS },
  { id: "sonnet", label: "Sonnet", efforts: EFFORTS },
  { id: "haiku", label: "Haiku", efforts: [] },
];

export interface ClaudeAdapterOptions {
  /** Override executable resolution (tests, custom installs). */
  executable?: ResolvedCommand;
  /** Max time for model discovery, CLI start-up included. */
  modelListTimeoutMs?: number;
  /**
   * Load the SDK (tests stub it). By default sessions use `loadClaudeSdk()`, and discovery
   * uses it only when the SDK is ready without an install (`claudeSdkReady()`).
   */
  loadSdk?: () => Promise<Pick<ClaudeSdkModule, "query" | "forkSession" | "getSessionMessages">>;
}

/** Claude Code through the Claude Agent SDK and the user's installed `claude` (§7.2). */
export class ClaudeAdapter implements ProviderAdapter {
  readonly id = CLAUDE_PROVIDER_ID;
  readonly displayName = "Claude Code";
  private readonly catalog = new ModelCatalog(FALLBACK_MODELS);
  private readonly freshness = new ModelFreshness();
  private refreshing: Promise<void> | undefined;

  constructor(private readonly options: ClaudeAdapterOptions = {}) {}

  /**
   * The `claude` to launch, looked up every time (a few `stat` calls): the runner outlives
   * updates and reinstalls, so a path found earlier may be gone or point at another install
   * by now. PATH first, then the installer's own folders; copies the last `--version` check
   * found broken are skipped until they change.
   */
  private executable(): ResolvedCommand | undefined {
    return this.options.executable ?? quickLocate("claude");
  }

  /** Finds a working copy (validating each one), so a broken shim never wins. */
  detect(): Promise<ProviderStatus> {
    return detectClaude(this.options.executable ? { executable: this.options.executable } : {});
  }

  capabilities(): ProviderCapabilities {
    return { ...capabilities };
  }

  models(): ModelInfo[] {
    return this.catalog.list();
  }

  onModelsChanged(listener: () => void): () => void {
    return this.catalog.subscribe(listener);
  }

  /**
   * Load Claude Code's model list without a turn (`listClaudeModels`: the CLI starts and
   * answers `initialize`; no message is sent). The list depends on the installed CLI and on
   * the account (new models appear without a CLI update), so it can go stale while the runner
   * runs. Concurrent calls share one discovery; a failed discovery keeps the last list.
   * Skipped when Claude Code is not installed, when the SDK would have to be installed first,
   * or (with `maxAgeMs`) when the list is recent and `claude` has not changed. Never throws.
   */
  refreshModels(opts: RefreshModelsOptions = {}): Promise<void> {
    if (
      opts.maxAgeMs !== undefined &&
      this.freshness.isFresh(executableFingerprint(this.executable()), opts.maxAgeMs)
    ) {
      return this.refreshing ?? Promise.resolve();
    }
    this.refreshing ??= this.discoverModels().finally(() => {
      this.refreshing = undefined;
    });
    return this.refreshing;
  }

  async openSession(opts: SessionOptions): Promise<ProviderSession> {
    const executable = this.executable();
    if (!executable) throw new Error("Claude Code is not installed (no `claude` on PATH)");
    const { query } = await (this.options.loadSdk ?? loadClaudeSdk)();
    return new ClaudeSession(await withFork(this, opts), {
      executable,
      query,
      // Every session start reports the list of the `claude` it runs: the cheapest refresh.
      onModels: (models) => {
        if (!models.length) return;
        this.freshness.confirm(executableFingerprint(executable));
        this.catalog.set(toModelInfos(models));
      },
    });
  }

  /**
   * Copy a conversation (see `forkClaudeConversation`): at once, with fresh message ids, the
   * original untouched; with `upTo`, only through the turn that ended with that message. The
   * copy is found from any worktree of the project.
   */
  async forkConversation(resumeToken: string, opts?: ForkConversationOptions): Promise<string> {
    const sdk = await (this.options.loadSdk ?? loadClaudeSdk)();
    return forkClaudeConversation(sdk, resumeToken, opts?.upTo);
  }

  utilityModel(): UtilityModel {
    return new ClaudeUtilityModel(() => this.executable());
  }

  private async discoverModels(): Promise<void> {
    const exe = this.executable();
    if (!exe) return;
    const load = this.options.loadSdk ?? (claudeSdkReady() ? loadClaudeSdk : undefined);
    if (!load) return;
    try {
      const { query } = await load();
      const models = await listClaudeModels(query, exe, {
        timeoutMs: this.options.modelListTimeoutMs,
      });
      if (models.length) {
        this.freshness.confirm(executableFingerprint(exe));
        this.catalog.set(models);
      }
    } catch {
      // Keep the last list (the aliases, or what discovery or a session reported before).
    }
  }
}

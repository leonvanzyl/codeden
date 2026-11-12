import type {
  ModelInfo,
  ProviderCapabilities,
  ProviderStatus,
  SessionOptions,
} from "@codeden/contracts";
import {
  type ProviderAdapter,
  type ProviderSession,
  type RefreshModelsOptions,
  withFork,
} from "../adapter";
import { executableFingerprint, ModelFreshness } from "../freshness";
import { ModelCatalog } from "../models";
import type { ResolvedCommand } from "../util/exec";
import { quickLocate } from "../util/locate";
import { DEFAULT_MODEL_ID } from "../util/model";
import type { UtilityModel } from "../utility";
import { detectCodex } from "./detect";
import { forkCodexThread } from "./fork";
import { listCodexModels, visibleCodexModels } from "./models";
import { CodexUtilityModel } from "./one-shot";
import { CodexSession } from "./session";

export const CODEX_PROVIDER_ID = "codex";

/**
 * Honest flags: subagents (collab agents) are experimental in app-server and not surfaced as
 * child threads yet; rollback exists in the protocol but is not wired up. Fork is
 * `thread/fork` (`forkConversation`).
 */
const capabilities: ProviderCapabilities = {
  resume: true,
  steer: true,
  interrupt: true,
  approvals: true,
  userQuestions: true,
  subagents: false,
  rollback: false,
  fork: true,
  images: true,
  planMode: false,
  reasoningEffort: true,
  mcp: true,
  skills: true,
  // Approval and sandbox policy are per turn (`turn/start` overrides): changes wait for it.
  liveAutonomy: false,
  readOnly: true,
};

const CONFIGURED_MODEL = "The model configured in ~/.codex/config.toml";

/**
 * Until Codex has listed its models, one entry that leaves the choice to the user's Codex
 * config. `note` says why the real list is missing when discovery failed.
 */
function fallbackModels(note?: string): ModelInfo[] {
  return [
    {
      id: DEFAULT_MODEL_ID,
      label: "Default",
      description: note ? `${CONFIGURED_MODEL}. ${note}` : CONFIGURED_MODEL,
      efforts: ["minimal", "low", "medium", "high", "xhigh"],
      isDefault: true,
    },
  ];
}

export interface CodexAdapterOptions {
  executable?: ResolvedCommand;
  /** Max time for model discovery, app-server start-up included. */
  modelListTimeoutMs?: number;
}

/** Codex through `codex app-server` JSON-RPC (§7.2). */
export class CodexAdapter implements ProviderAdapter {
  readonly id = CODEX_PROVIDER_ID;
  readonly displayName = "Codex";
  private readonly catalog = new ModelCatalog(fallbackModels());
  /** True once Codex reported a real model list (discovery or a session). */
  private listed = false;
  private readonly freshness = new ModelFreshness();
  private refreshing: Promise<void> | undefined;

  constructor(private readonly options: CodexAdapterOptions = {}) {}

  /**
   * The `codex` to launch, looked up every time (a few `stat` calls): the runner outlives
   * updates and reinstalls, so a path found earlier may be gone or point at another install
   * by now. PATH first, then the installer's own folders; copies the last `--version` check
   * found broken are skipped until they change.
   */
  private executable(): ResolvedCommand | undefined {
    return this.options.executable ?? quickLocate("codex");
  }

  /** Finds a working copy (validating each one), so a broken shim never wins. */
  detect(): Promise<ProviderStatus> {
    return detectCodex(this.options.executable ? { executable: this.options.executable } : {});
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
   * Load Codex's model list through a short-lived `codex app-server` (`model/list`; no thread,
   * no turn). Concurrent calls share one discovery. With `maxAgeMs`, skipped while the list is
   * recent and `codex` has not changed. Never throws.
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
    if (!executable) throw new Error("Codex is not installed (no `codex` on PATH)");
    const session = new CodexSession(await withFork(this, opts), {
      executable,
      onModels: (models) => {
        const visible = visibleCodexModels(models);
        if (visible.length) this.setModels(visible, executable);
      },
      modelEfforts: (model) => this.catalog.list().find((m) => m.id === model)?.efforts,
    });
    try {
      await session.start();
    } catch (error) {
      await session.close();
      throw error;
    }
    return session;
  }

  /** Copy a thread with `thread/fork` (see `forkCodexThread`); returns the new thread's id. */
  async forkConversation(resumeToken: string, opts: { cwd: string }): Promise<string> {
    const executable = this.executable();
    if (!executable) throw new Error("Codex is not installed (no `codex` on PATH)");
    return forkCodexThread(executable, resumeToken, opts);
  }

  utilityModel(): UtilityModel {
    return new CodexUtilityModel(() => this.executable());
  }

  private async discoverModels(): Promise<void> {
    // Not installed: `detect()` reports that; the fallback stays.
    const exe = this.executable();
    if (!exe) return;
    try {
      const models = await listCodexModels(exe, { timeoutMs: this.options.modelListTimeoutMs });
      if (models.length) this.setModels(models, exe);
      else this.discoveryFailed("Codex listed no models.");
    } catch (error) {
      const reason = (error instanceof Error ? error.message : String(error)).slice(0, 200);
      this.discoveryFailed(`Codex's model list could not be loaded: ${reason}`);
    }
  }

  private setModels(models: ModelInfo[], from: ResolvedCommand): void {
    this.listed = true;
    this.freshness.confirm(executableFingerprint(from));
    this.catalog.set(models);
  }

  /** Keep the last real list; without one, say why only the configured default is offered. */
  private discoveryFailed(note: string): void {
    if (!this.listed) this.catalog.set(fallbackModels(note));
  }
}

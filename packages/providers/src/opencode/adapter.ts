import type {
  ModelInfo,
  ProviderCapabilities,
  ProviderStatus,
  SessionOptions,
} from "@codeden/contracts";
import type { ProviderAdapter, ProviderSession, RefreshModelsOptions } from "../adapter";
import { executableFingerprint, ModelFreshness } from "../freshness";
import { ModelCatalog } from "../models";
import type { ResolvedCommand } from "../util/exec";
import type { UtilityModel } from "../utility";
import { detectOpenCode } from "./detect";
import { locateOpenCode } from "./locate";
import { fallbackOpenCodeModels, modelEfforts } from "./models";
import { OpenCodeUtilityModel } from "./one-shot";
import { guardPluginDir } from "./plugin";
import { type OpenCodeProbe, probeOpenCode } from "./probe";
import { OpenCodeSession } from "./session";

export const OPENCODE_PROVIDER_ID = "opencode";

/**
 * Honest flags (Principle 5). Steering is OpenCode's `delivery: "steer"`; approvals and the
 * read-only level go through OpenCode's permission requests, decided by CodeDen's policy for
 * every call (so autonomy changes apply live); subagents are child sessions. Not wired up yet:
 * rollback (OpenCode's revert), fork, plan mode (OpenCode's `plan` agent) and skills.
 */
const capabilities: ProviderCapabilities = {
  resume: true,
  steer: true,
  interrupt: true,
  approvals: true,
  userQuestions: true,
  subagents: true,
  rollback: false,
  fork: false,
  images: true,
  planMode: false,
  reasoningEffort: true,
  mcp: true,
  skills: false,
  liveAutonomy: true,
  readOnly: true,
};

export interface OpenCodeAdapterOptions {
  executable?: ResolvedCommand;
  /** Max time for a probe (model discovery, detection), server start-up included. */
  probeTimeoutMs?: number;
  /** Skip the env-guard plugin (tests with a fake server). */
  noGuardPlugin?: boolean;
}

/** OpenCode through a private `opencode serve` per session, over its v2 HTTP API (§7.2). */
export class OpenCodeAdapter implements ProviderAdapter {
  readonly id = OPENCODE_PROVIDER_ID;
  readonly displayName = "OpenCode";
  private readonly catalog = new ModelCatalog(fallbackOpenCodeModels());
  private listed = false;
  private readonly freshness = new ModelFreshness();
  private probing: Promise<OpenCodeProbe> | undefined;

  constructor(private readonly options: OpenCodeAdapterOptions = {}) {}

  /** `opencode`, looked up every time: the runner outlives updates and reinstalls. */
  private executable(): ResolvedCommand | undefined {
    return this.options.executable ?? locateOpenCode();
  }

  /**
   * Finds a working copy (validating each one, so a broken shim never wins), then probes it
   * for providers; the probe also refreshes the models.
   */
  detect(): Promise<ProviderStatus> {
    return detectOpenCode({
      ...(this.options.executable ? { executable: this.options.executable } : {}),
      probe: (exe) => this.probe(exe),
    });
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
   * Load the model list from a short-lived private server (`GET /api/model`; no session, no
   * model call). Shares a probe already running (detection). With `maxAgeMs`, skipped while
   * the list is recent and `opencode` has not changed. Never throws.
   */
  async refreshModels(opts: RefreshModelsOptions = {}): Promise<void> {
    const exe = this.executable();
    if (!exe) return;
    if (
      opts.maxAgeMs !== undefined &&
      !this.probing &&
      this.freshness.isFresh(executableFingerprint(exe), opts.maxAgeMs)
    ) {
      return;
    }
    await this.probe(exe).catch(() => undefined);
  }

  async openSession(opts: SessionOptions): Promise<ProviderSession> {
    const executable = this.executable();
    if (!executable) throw new Error("OpenCode is not installed (no `opencode` on PATH)");
    const efforts = (model: string | undefined) => {
      const list = this.catalog.list();
      return modelEfforts(list, model ?? list.find((m) => m.isDefault)?.id);
    };
    const session = new OpenCodeSession(opts, {
      executable,
      ...(this.options.noGuardPlugin ? {} : { pluginDir: guardPluginDir() }),
      modelEfforts: efforts,
      contextWindow: (model) => {
        const list = this.catalog.list();
        const id = model ?? list.find((m) => m.isDefault)?.id;
        return list.find((m) => m.id === id)?.contextWindow;
      },
    });
    try {
      await session.start();
    } catch (error) {
      await session.close();
      throw error;
    }
    return session;
  }

  utilityModel(): UtilityModel {
    return new OpenCodeUtilityModel(() => this.executable());
  }

  /** One probe at a time; its models replace the catalog. Rejects on failure. */
  private probe(exe: ResolvedCommand): Promise<OpenCodeProbe> {
    this.probing ??= probeOpenCode(exe, { timeoutMs: this.options.probeTimeoutMs })
      .then(
        (result) => {
          if (result.models.length) this.setModels(result.models, exe);
          else this.discoveryFailed("OpenCode listed no models.");
          return result;
        },
        (error) => {
          const reason = (error instanceof Error ? error.message : String(error)).slice(0, 200);
          this.discoveryFailed(`OpenCode's model list could not be loaded: ${reason}`);
          throw error;
        },
      )
      .finally(() => {
        this.probing = undefined;
      });
    return this.probing;
  }

  private setModels(models: ModelInfo[], from: ResolvedCommand): void {
    this.listed = true;
    this.freshness.confirm(executableFingerprint(from));
    this.catalog.set(models);
  }

  /** Keep the last real list; without one, say why only the configured default is offered. */
  private discoveryFailed(note: string): void {
    if (!this.listed) this.catalog.set(fallbackOpenCodeModels(note));
  }
}

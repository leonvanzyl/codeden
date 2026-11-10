import type { ProviderInfo } from "@codeden/contracts";
import { type ProviderAdapter, providerInfo, type RefreshModelsOptions } from "./adapter";
import { ClaudeAdapter } from "./claude/adapter";
import { CodexAdapter } from "./codex/adapter";
import { OpenCodeAdapter } from "./opencode/adapter";

/** The set of adapters a runner has loaded, keyed by id. */
export class ProviderRegistry {
  private readonly adapters = new Map<string, ProviderAdapter>();
  private readonly listeners = new Set<() => void>();

  constructor(adapters: ProviderAdapter[] = []) {
    for (const adapter of adapters) this.register(adapter);
  }

  register(adapter: ProviderAdapter): void {
    if (this.adapters.has(adapter.id)) {
      throw new Error(`Provider "${adapter.id}" is already registered`);
    }
    this.adapters.set(adapter.id, adapter);
    adapter.onModelsChanged?.(() => this.notify());
  }

  get(id: string): ProviderAdapter | undefined {
    return this.adapters.get(id);
  }

  list(): ProviderAdapter[] {
    return [...this.adapters.values()];
  }

  info(): ProviderInfo[] {
    return this.list().map(providerInfo);
  }

  /**
   * Refresh the model lists of all adapters (or those in `ids`) that support it. Never throws;
   * changes reach `onChange` listeners. `opts.maxAgeMs` skips adapters whose list is recent.
   */
  async refreshModels(ids?: readonly string[], opts?: RefreshModelsOptions): Promise<void> {
    const adapters = ids ? this.list().filter((a) => ids.includes(a.id)) : this.list();
    await Promise.all(adapters.map((a) => a.refreshModels?.(opts).catch(() => undefined)));
  }

  /** Call `listener` whenever `info()` changes (a provider's models). Returns unsubscribe. */
  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private notify(): void {
    for (const listener of this.listeners) {
      try {
        listener();
      } catch {
        // One failing listener must not stop the others.
      }
    }
  }
}

/** Fresh instances of the built-in real providers (Claude Code, Codex, OpenCode). */
export function builtinProviders(): ProviderAdapter[] {
  return [new ClaudeAdapter(), new CodexAdapter(), new OpenCodeAdapter()];
}

let defaultRegistry: ProviderRegistry | undefined;

/** Process-wide registry of the built-in providers, created on first use. */
export function defaultProviderRegistry(): ProviderRegistry {
  defaultRegistry ??= new ProviderRegistry(builtinProviders());
  return defaultRegistry;
}

/** A built-in provider by id (`claude`, `codex`, `opencode`). */
export function getProvider(id: string): ProviderAdapter | undefined {
  return defaultProviderRegistry().get(id);
}

/** All built-in providers. Check `detect()` for which are installed and logged in. */
export function listProviders(): ProviderAdapter[] {
  return defaultProviderRegistry().list();
}

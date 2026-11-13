import type {
  ProviderInfo,
  RefreshModelsResponse,
  RunnerCommandName,
  RunnerCommandOf,
  RunnerCommandResult,
} from "@codeden/contracts";
import type { RunnerClient } from "../runner/client";
import { ServiceError } from "./errors";

/**
 * What services need from a runner. Wraps `RunnerClient`'s public API so services can be
 * tested with a fake and so changes to the client stay in one place.
 */
export interface RunnerPort {
  isConnected(): boolean;
  runnerId(): string | null;
  providers(): ProviderInfo[];
  /** Agent-facing MCP proxy URL on the runner (§4.4), once configured. */
  mcpProxyUrl(): string | null;
  /** Resolve true once connected, false after `timeoutMs`. */
  waitForConnection(timeoutMs: number): Promise<boolean>;
  request<N extends RunnerCommandName>(
    command: RunnerCommandOf<N>,
    timeoutMs?: number,
  ): Promise<RunnerCommandResult<N>>;
}

/** Error code carried by a failed runner command (`RunnerCommandError.code`), if any. */
export function runnerErrorCode(error: unknown): string | undefined {
  if (error && typeof error === "object" && "code" in error) {
    const code = (error as { code: unknown }).code;
    return typeof code === "string" ? code : undefined;
  }
  return undefined;
}

/** Map a runner failure to an HTTP-friendly service error. */
export function toServiceError(error: unknown): ServiceError {
  if (error instanceof ServiceError) return error;
  const code = runnerErrorCode(error) ?? "runner_error";
  const message = error instanceof Error ? error.message : String(error);
  if (code === "runner_unavailable") return new ServiceError(503, code, message);
  if (
    code === "unknown_session" ||
    code === "unsupported" ||
    code === "no_turn" ||
    code === "turn_running"
  ) {
    return new ServiceError(409, code, message);
  }
  return new ServiceError(502, code, message);
}

/**
 * Ask a connected runner to re-detect its providers, which also refreshes their model lists
 * (they come back as a runner status update). Fire and forget; failures are only logged.
 */
export function redetectProviders(runner: RunnerPort, log?: (message: string) => void): void {
  if (!runner.isConnected()) return;
  runner.request({ name: "provider.detect" }, 60_000).catch((error: unknown) => {
    log?.(`runner: provider re-detect failed: ${error instanceof Error ? error.message : error}`);
  });
}

/** Model discovery starts a provider CLI (up to 30 s); detection runs first. */
const REFRESH_MODELS_TIMEOUT_MS = 90_000;

/**
 * "Refresh models": re-detect one provider and wait until it has listed its models again.
 * Resolves with every provider's list after the refresh (the runner also broadcasts it, so
 * other clients update as well).
 */
export async function refreshProviderModels(
  runner: RunnerPort,
  providerId: string,
): Promise<RefreshModelsResponse> {
  if (!runner.isConnected()) {
    throw new ServiceError(503, "runner_unavailable", "The runner is not connected");
  }
  if (!runner.providers().some((p) => p.id === providerId)) {
    throw new ServiceError(404, "unknown_provider", `No provider "${providerId}" is loaded`);
  }
  try {
    const result = await runner.request(
      { name: "provider.detect", providerId, waitForModels: true },
      REFRESH_MODELS_TIMEOUT_MS,
    );
    // An older runner answers without the lists; its `providers` update has arrived by now.
    return { providers: result.providers ?? runner.providers() };
  } catch (error) {
    throw toServiceError(error);
  }
}

/** `RunnerPort` over the server's (possibly absent) `RunnerClient`. */
export function runnerPort(get: () => RunnerClient | undefined): RunnerPort {
  return {
    isConnected: () => get()?.status.state === "connected",
    runnerId: () => get()?.status.runnerId ?? null,
    providers: () => get()?.status.providers ?? [],
    mcpProxyUrl: () => get()?.mcpProxyUrl ?? null,
    waitForConnection: async (timeoutMs) => {
      const client = get();
      if (!client) return false;
      if (client.status.state === "connected") return true;
      let timer: NodeJS.Timeout | undefined;
      const timeout = new Promise<false>((resolve) => {
        timer = setTimeout(() => resolve(false), timeoutMs);
      });
      const result = await Promise.race([client.waitForConnection().then(() => true), timeout]);
      clearTimeout(timer);
      return result;
    },
    request: (command, timeoutMs) => {
      const client = get();
      if (!client) {
        return Promise.reject(
          new ServiceError(503, "runner_unavailable", "No runner is configured"),
        );
      }
      return client.request(command, timeoutMs);
    },
  };
}

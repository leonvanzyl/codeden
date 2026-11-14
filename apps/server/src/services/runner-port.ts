import type {
  ProviderInfo,
  RefreshModelsResponse,
  RunnerBackendId,
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
  /**
   * Names the runner in errors ("Runner rn-1 (docker)"); absent for the home runner, whose
   * errors keep saying "the runner".
   */
  describe?(): string;
  /**
   * Set on every runner but the home runner (`docs/remote-runners.md` §8, §10): where it runs,
   * from its `welcome` (empty until it connected). Such a runner is untrusted and may not share
   * the server's disk, so its sessions' files are read through `fs.*`, never `node:fs`. Absent
   * for the home runner, whose sessions' folders are on the server's own disk.
   */
  remote?(): RunnerPlacement;
}

/** Where a runner other than the home runner runs, as it reported in `welcome`. */
export interface RunnerPlacement {
  /** `process.platform` on the runner's machine, for its path rules. */
  platform?: string;
  /** Its backend; one that isn't `local` gets cloned workspaces at paths it chooses (§9.1). */
  backend?: RunnerBackendId;
}

/**
 * True when the runner may not share the server's disk (any runner but the home runner). No
 * runner at all (services built without one, in tests) is the home runner's case.
 */
export function isRemoteRunner(runner: RunnerPort | undefined): boolean {
  return typeof runner?.remote === "function";
}

/** True when sessions on this runner work in a clone at a path it chooses (§9.1). */
export function clonesWorkspaces(runner: RunnerPort): boolean {
  const backend = runner.remote?.().backend;
  return backend !== undefined && backend !== "local";
}

/**
 * Which runner serves what (`docs/remote-runners.md` §8): the home runner for global work
 * (provider detection, utility jobs, the orchestrator and PMs) and each session's own runner,
 * the one in `sessions.runnerId`.
 */
export interface RunnerRouter {
  home(): RunnerPort;
  forSession(sessionId: string): RunnerPort;
  /** The runner with this journal id; the home runner when no other runner has it. */
  forRunnerId(runnerId: string): RunnerPort;
}

/** Service deps that reach runners: the home runner, and a router when there are several. */
export interface RunnerDeps {
  runner: RunnerPort;
  /** Routes sessions to their own runner; without it every session uses `runner`. */
  runners?: RunnerRouter;
}

/** A router for a single runner: every session uses it (tests, and a server with one runner). */
export function singleRunner(port: RunnerPort): RunnerRouter {
  return { home: () => port, forSession: () => port, forRunnerId: () => port };
}

/** The runner that hosts this session. */
export function runnerForSession(deps: RunnerDeps, sessionId: string): RunnerPort {
  return deps.runners ? deps.runners.forSession(sessionId) : deps.runner;
}

/** The error for a runner that is not connected, naming it when it isn't the home runner. */
export function runnerUnavailable(runner: RunnerPort): ServiceError {
  const name = runner.describe?.();
  return new ServiceError(
    503,
    "runner_unavailable",
    name ? `${name} is not connected` : "The runner is not connected",
  );
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
  // An answer that doesn't fit its question (a form's number field): the card shows why.
  if (code === "invalid_answer") return new ServiceError(400, code, message);
  if (
    code === "unknown_session" ||
    code === "unsupported" ||
    code === "no_turn" ||
    code === "turn_running" ||
    code === "dialog_open" ||
    code === "no_dialog"
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

/**
 * `RunnerPort` over a (possibly absent) `RunnerClient`. `describe` names a runner other than
 * the home runner in errors.
 */
export function runnerPort(
  get: () => RunnerClient | undefined,
  describe?: () => string,
  remote?: () => RunnerPlacement,
): RunnerPort {
  return {
    ...(describe ? { describe } : {}),
    ...(remote ? { remote } : {}),
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
          new ServiceError(
            503,
            "runner_unavailable",
            describe ? `${describe()} is not available` : "No runner is configured",
          ),
        );
      }
      return client.request(command, timeoutMs);
    },
  };
}

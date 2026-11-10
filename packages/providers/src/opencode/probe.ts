import { tmpdir } from "node:os";
import type { ModelInfo } from "@codeden/contracts";
import type { ResolvedCommand } from "../util/exec";
import { openCodeModelList } from "./models";
import type { OcCredential, OcModel, OcProvider } from "./protocol";
import { OpenCodeServer } from "./server";

/** How long a probe may take, server start-up included. */
export const OPENCODE_PROBE_TIMEOUT_MS = 20_000;

/** What a short-lived OpenCode server reports: version, providers, credentials and models. */
export interface OpenCodeProbe {
  version: string | null;
  /** Providers OpenCode can use (credentials, environment variables, config, free tier). */
  providers: OcProvider[];
  /** Integrations with a saved, active credential (`opencode auth login`). */
  connected: string[];
  models: ModelInfo[];
}

/**
 * Start a private `opencode serve` in the temp directory, read its providers, credentials and
 * models, and stop it. No session is created and no model is called, so nothing is billed.
 * Rejects on failure or after `timeoutMs`; the server is stopped either way.
 */
export async function probeOpenCode(
  exe: ResolvedCommand,
  opts: { timeoutMs?: number } = {},
): Promise<OpenCodeProbe> {
  const timeoutMs = opts.timeoutMs ?? OPENCODE_PROBE_TIMEOUT_MS;
  const abort = new AbortController();
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`OpenCode did not answer within ${timeoutMs}ms`)),
      timeoutMs,
    );
  });
  try {
    return await Promise.race([run(exe, abort.signal, timeoutMs), timeout]);
  } finally {
    clearTimeout(timer);
    abort.abort();
  }
}

async function run(
  exe: ResolvedCommand,
  signal: AbortSignal,
  timeoutMs: number,
): Promise<OpenCodeProbe> {
  const server = await OpenCodeServer.start(exe, {
    cwd: tmpdir(),
    signal,
    startTimeoutMs: timeoutMs,
    requestTimeoutMs: timeoutMs,
  });
  try {
    const c = server.client;
    const [info, providers, credentials, models, fallback] = await Promise.all([
      c.get<{ version?: string }>("/api/info", signal).catch(() => undefined),
      c.get<{ data: OcProvider[] }>("/api/provider", signal),
      c.get<{ data: OcCredential[] }>("/api/credential", signal).catch(() => ({ data: [] })),
      c.get<{ data: OcModel[] }>("/api/model", signal),
      c.get<{ data: OcModel | null }>("/api/model/default", signal).catch(() => ({ data: null })),
    ]);
    const connected = [
      ...new Set(
        (credentials.data ?? []).filter((x) => x.active !== false).map((x) => x.integrationID),
      ),
    ];
    return {
      version: typeof info?.version === "string" ? info.version : null,
      providers: providers.data ?? [],
      connected,
      models: openCodeModelList(models.data ?? [], providers.data ?? [], fallback.data),
    };
  } finally {
    await server.close();
  }
}

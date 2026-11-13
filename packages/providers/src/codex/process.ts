import { CODEDEN_VERSION } from "@codeden/contracts";
import { agentEnv } from "../util/agent-env";
import { type ResolvedCommand, spawnResolved } from "../util/exec";
import type { InitializeParams, InitializeResponse } from "./protocol";
import { CodexRpc, type CodexRpcHandlers } from "./rpc";

/** Notifications CodeDen never uses; opting out keeps the stdio stream small. */
const OPT_OUT = [
  "rawResponseItem/completed",
  "rawResponse/completed",
  "remoteControl/status/changed",
  "fuzzyFileSearch/sessionUpdated",
  "fuzzyFileSearch/sessionCompleted",
];

/**
 * Spawn `codex app-server` (stdio) and complete the `initialize` handshake. Aborting `signal`
 * stops the process at any point, including during the handshake.
 */
export async function startAppServer(
  exe: ResolvedCommand,
  handlers: CodexRpcHandlers,
  opts: { env?: Record<string, string>; cwd?: string; signal?: AbortSignal } = {},
): Promise<{ rpc: CodexRpc; info: InitializeResponse }> {
  const child = spawnResolved(exe, ["app-server"], {
    stdio: ["pipe", "pipe", "pipe"],
    env: agentEnv(opts.env),
    ...(opts.cwd ? { cwd: opts.cwd } : {}),
  });
  const rpc = new CodexRpc(child, handlers);
  if (opts.signal) {
    if (opts.signal.aborted) void rpc.close();
    else opts.signal.addEventListener("abort", () => void rpc.close(), { once: true });
  }
  const params: InitializeParams = {
    clientInfo: { name: "codeden", title: "CodeDen", version: CODEDEN_VERSION },
    capabilities: {
      experimentalApi: false,
      requestAttestation: false,
      optOutNotificationMethods: OPT_OUT,
    },
  };
  try {
    const info = await rpc.request<InitializeResponse>("initialize", params);
    rpc.notify("initialized");
    return { rpc, info };
  } catch (error) {
    rpc.close();
    throw error;
  }
}

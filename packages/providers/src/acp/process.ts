import { CODEDEN_VERSION } from "@codeden/contracts";
import { type ResolvedCommand, spawnResolved } from "../util/exec";
import { ACP_PROTOCOL_VERSION, type AcpInitializeResult } from "./protocol";
import { AcpRpc, AcpRpcError, type AcpRpcHandlers } from "./rpc";

export interface StartAgentOptions {
  /** Arguments that start the agent's ACP server, e.g. `["acp"]`. */
  args: readonly string[];
  /** Shown in errors: "Cursor". */
  label: string;
  /** Authentication method to run after `initialize` when the agent offers it. */
  authMethod?: string;
  /** Extra `clientCapabilities` fields (vendor flags). */
  clientCapabilities?: Record<string, unknown>;
  cwd?: string;
  /** Extra env vars for the agent (merged over the runner's environment). */
  env?: Record<string, string>;
  timeoutMs?: number;
}

/** The client capabilities CodeDen advertises: the agent reads and writes files itself. */
export function clientCapabilities(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { fs: { readTextFile: false, writeTextFile: false }, terminal: false, ...extra };
}

/**
 * Spawn an ACP agent on stdio and complete the handshake: `initialize` (protocol version 1),
 * then `authenticate` with `authMethod` when the agent lists it, which reuses the login the
 * user already has (never credentials CodeDen holds). Rejects when the agent exits, answers an
 * error, or doesn't answer within `timeoutMs`; the process is stopped then.
 */
export async function startAgent(
  exe: ResolvedCommand,
  handlers: AcpRpcHandlers,
  opts: StartAgentOptions,
): Promise<{ rpc: AcpRpc; info: AcpInitializeResult }> {
  const child = spawnResolved(exe, opts.args, {
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, ...opts.env },
    ...(opts.cwd ? { cwd: opts.cwd } : {}),
  });
  const rpc = new AcpRpc(child, handlers, opts.label);
  const timeoutMs = opts.timeoutMs ?? 30_000;
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () =>
        reject(new AcpRpcError(-32000, `${opts.label} did not answer within ${timeoutMs / 1000}s`)),
      timeoutMs,
    );
    timer.unref?.();
  });
  try {
    const info = await Promise.race([
      rpc.request<AcpInitializeResult>("initialize", {
        protocolVersion: ACP_PROTOCOL_VERSION,
        clientCapabilities: clientCapabilities(opts.clientCapabilities),
        clientInfo: { name: "codeden", title: "CodeDen", version: CODEDEN_VERSION },
      }),
      timeout,
    ]);
    if (
      typeof info?.protocolVersion === "number" &&
      info.protocolVersion !== ACP_PROTOCOL_VERSION
    ) {
      throw new AcpRpcError(
        -32000,
        `${opts.label} speaks ACP version ${info.protocolVersion}; CodeDen speaks version ${ACP_PROTOCOL_VERSION}`,
      );
    }
    const methods = Array.isArray(info?.authMethods) ? info.authMethods : [];
    if (opts.authMethod && methods.some((m) => m?.id === opts.authMethod)) {
      await Promise.race([rpc.request("authenticate", { methodId: opts.authMethod }), timeout]);
    }
    return { rpc, info: info ?? {} };
  } catch (error) {
    void rpc.close();
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

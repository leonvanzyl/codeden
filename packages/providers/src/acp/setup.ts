import { findOption, modeIds, optionId } from "./config";
import type { AcpMcpServer, AcpSessionSetup } from "./protocol";
import { type AcpRpc, AcpRpcError } from "./rpc";

/** An opened ACP session: its id, what the agent reported, and whether it was resumed. */
export interface OpenedSession {
  sessionId: string;
  setup: AcpSessionSetup;
  resumed: boolean;
  /** Why the old session could not be resumed (a new one was opened instead). */
  notice?: string;
}

/**
 * `session/load` the session `resumeId` when the agent can load sessions; else, or when that
 * fails, `session/new` in `cwd`. The agent replays a loaded session's history as updates
 * before it answers; the caller drops them.
 */
export async function openOrLoad(
  rpc: AcpRpc,
  opts: {
    cwd: string;
    mcpServers: AcpMcpServer[];
    resumeId?: string;
    canLoad: boolean;
    label: string;
  },
): Promise<OpenedSession> {
  const base = { cwd: opts.cwd, mcpServers: opts.mcpServers };
  let notice: string | undefined;
  if (opts.resumeId) {
    try {
      if (!opts.canLoad) throw new Error("the agent can't load sessions");
      const setup = await rpc.request<AcpSessionSetup>("session/load", {
        ...base,
        sessionId: opts.resumeId,
      });
      return { sessionId: opts.resumeId, setup: setup ?? {}, resumed: true };
    } catch (error) {
      const why = error instanceof Error ? error.message : String(error);
      notice = `Could not resume ${opts.label} session ${opts.resumeId} (${why}); started a new one.`;
    }
  }
  const setup = (await rpc.request<AcpSessionSetup>("session/new", base)) ?? {};
  if (typeof setup.sessionId !== "string" || !setup.sessionId) {
    throw new AcpRpcError(-32000, `${opts.label} returned no session id`);
  }
  return { sessionId: setup.sessionId, setup, resumed: false, ...(notice ? { notice } : {}) };
}

/** The mode a session reports: its modes, else its `mode` config option. */
export function currentMode(setup: AcpSessionSetup): string | undefined {
  const value = setup.modes?.currentModeId ?? findOption(setup.configOptions, "mode")?.currentValue;
  return typeof value === "string" && value ? value : undefined;
}

/**
 * Switch a session's mode through its `mode` config option, else `session/set_mode`. A mode the
 * agent doesn't list is skipped. Returns whether the mode was set.
 */
export async function setMode(
  rpc: AcpRpc,
  sessionId: string,
  setup: AcpSessionSetup,
  mode: string,
): Promise<boolean> {
  const available = modeIds(setup);
  if (available.length && !available.includes(mode)) return false;
  const option = findOption(setup.configOptions, "mode");
  const id = option ? optionId(option) : undefined;
  if (id) {
    await rpc.request("session/set_config_option", { sessionId, configId: id, value: mode });
  } else {
    await rpc.request("session/set_mode", { sessionId, modeId: mode });
  }
  return true;
}

/** Switch a session's model through its `model` config option, else `session/set_model`. */
export async function setModel(
  rpc: AcpRpc,
  sessionId: string,
  setup: AcpSessionSetup,
  model: string,
): Promise<void> {
  const option = findOption(setup.configOptions, "model");
  const id = option ? optionId(option) : undefined;
  if (id) {
    await rpc.request("session/set_config_option", { sessionId, configId: id, value: model });
  } else {
    await rpc.request("session/set_model", { sessionId, modelId: model });
  }
}

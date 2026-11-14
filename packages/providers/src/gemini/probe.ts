import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { startAgent } from "../acp/process";
import type { AcpInitializeResult } from "../acp/protocol";
import { AcpRpcError, METHOD_NOT_FOUND } from "../acp/rpc";
import type { ResolvedCommand } from "../util/exec";

/** The arguments that start Gemini CLI's ACP server. */
export const GEMINI_ACP_ARGS = ["--acp"] as const;

/** What a short-lived `gemini --acp` showed. */
export interface GeminiProbe {
  /** The CLI answered `initialize` with ACP version 1. */
  acp: boolean;
  /** What it reported in `initialize` (its capabilities). */
  info?: AcpInitializeResult;
  /** Why the ACP server didn't start, when it didn't. */
  error?: string;
}

/** A folder of CodeDen's own to run the probe in, so it never touches a project. */
function scratchDir(): string {
  const dir = path.join(tmpdir(), "codeden-gemini-probe");
  try {
    mkdirSync(dir, { recursive: true });
  } catch {
    // The probe still runs, in the runner's own folder.
  }
  return dir;
}

/**
 * Start `gemini --acp` once and check it answers `initialize` with ACP version 1. Only the
 * handshake runs: no `authenticate` (it would rewrite the user's Gemini settings), no session
 * (that would save a session file and start the user's MCP servers and hooks), no model call.
 * Never throws.
 */
export async function probeGemini(
  exe: ResolvedCommand,
  opts: { timeoutMs?: number } = {},
): Promise<GeminiProbe> {
  let stderr = "";
  try {
    const started = await startAgent(
      exe,
      {
        onNotification: () => {},
        onRequest: async () => {
          throw new AcpRpcError(METHOD_NOT_FOUND, "not supported");
        },
        onExit: (_code, tail) => {
          stderr = tail;
        },
      },
      {
        args: GEMINI_ACP_ARGS,
        label: "Gemini CLI",
        cwd: scratchDir(),
        timeoutMs: opts.timeoutMs ?? 20_000,
      },
    );
    await started.rpc.close();
    return { acp: true, info: started.info };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      acp: false,
      error: [message, stderr.trim().split(/\r?\n/).slice(-3).join(" ")]
        .filter(Boolean)
        .join(": ")
        .slice(0, 400),
    };
  }
}

import type { AcpModel } from "../acp/config";
import { startAgent } from "../acp/process";
import { AcpRpcError, METHOD_NOT_FOUND } from "../acp/rpc";
import { type ResolvedCommand, runCommand } from "../util/exec";
import { parseCursorStatus } from "./detect";
import { modelsFromListing, parseModelList } from "./models";

/** Cursor's request that lists the account's models without opening a session. */
export const LIST_MODELS = "cursor/list_available_models";

/** What a short-lived `agent acp` showed. */
export interface CursorProbe {
  /** The CLI answered `initialize`: it has the `acp` command. */
  acp: boolean;
  models: AcpModel[];
  current?: string;
  /** Why the ACP server didn't start, when it didn't. */
  error?: string;
}

/**
 * Start `agent acp` once, check that it answers `initialize`, and ask for the model list
 * (Cursor's `cursor/list_available_models`; signed-in CLIs only, after `cursor_login`, which
 * reuses the existing login). No session is opened and no model is called. When the ACP list
 * is empty, the CLI's own `--list-models` output is read instead. Never throws.
 */
export async function probeCursor(
  exe: ResolvedCommand,
  opts: { signedIn?: boolean; timeoutMs?: number },
): Promise<CursorProbe> {
  const timeoutMs = opts.timeoutMs ?? 20_000;
  const signedIn = opts.signedIn ?? (await isSignedIn(exe, timeoutMs));
  let stderr = "";
  let started: Awaited<ReturnType<typeof startAgent>> | undefined;
  const result: CursorProbe = { acp: false, models: [] };
  try {
    started = await startAgent(
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
        args: ["acp"],
        label: "Cursor",
        ...(signedIn ? { authMethod: "cursor_login" } : {}),
        timeoutMs,
      },
    );
    result.acp = true;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    result.error = [message, stderr.trim().split(/\r?\n/).slice(-3).join(" ")]
      .filter(Boolean)
      .join(": ")
      .slice(0, 400);
  }
  if (started && signedIn) {
    try {
      const listing = await withTimeout(started.rpc.request<unknown>(LIST_MODELS, {}), timeoutMs);
      Object.assign(result, modelsFromListing(listing));
    } catch {
      // Older CLIs don't answer it; the CLI's own list below may.
    }
  }
  await started?.rpc.close();
  if (!result.models.length && signedIn) {
    const run = await runCommand(exe, ["--list-models"], { timeoutMs });
    if (run.code === 0) Object.assign(result, parseModelList(run.stdout));
  }
  return result;
}

/** `agent status` says the CLI is signed in (an API key in the environment counts). */
async function isSignedIn(exe: ResolvedCommand, timeoutMs: number): Promise<boolean> {
  const run = await runCommand(exe, ["status"], { timeoutMs });
  const output = [run.stdout, run.stderr].join("\n");
  return parseCursorStatus(output, run.code, process.env).loggedIn === true;
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("timed out")), ms);
      timer.unref?.();
    }),
  ]).finally(() => clearTimeout(timer));
}

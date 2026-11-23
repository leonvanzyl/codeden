import type { AcpModel } from "../acp/config";
import { startAgent } from "../acp/process";
import type { AcpInitializeResult } from "../acp/protocol";
import { AcpRpcError, METHOD_NOT_FOUND } from "../acp/rpc";
import { type ResolvedCommand, runCommand } from "../util/exec";
import { cursorLoginRequired, readCursorLogin } from "./detect";
import { CURSOR_CLIENT_CAPABILITIES } from "./extensions";
import { parseModelList } from "./models";

/** What a short-lived `agent acp` showed. */
export interface CursorProbe {
  /** The CLI answered `initialize`: it has the `acp` command. */
  acp: boolean;
  models: AcpModel[];
  current?: string;
  /** Why the ACP server didn't start, when it didn't. */
  error?: string;
  /** What the CLI reported in `initialize` (its capabilities). */
  info?: AcpInitializeResult;
  /**
   * `agent status` said signed in, but listing models asked for a login: the stored login
   * can't be used, and an ACP `authenticate` would open the browser.
   */
  loginRequired?: boolean;
}

/**
 * Start `agent acp` once and check that it answers `initialize` (which also reports its
 * capabilities), then read the account's models with the CLI's own `--list-models` when
 * `agent status` says it is signed in. No session is opened and no model is called.
 *
 * A probe runs in the background (start-up, re-checks, the factory's availability checks), so
 * it never sends ACP `authenticate`: with `cursor_login`, the CLI opens its browser login
 * whenever its own credential check fails, even while `agent status` says signed in, and a
 * probe that then times out kills the CLI before the login can finish, so the next probe opens
 * it again. A login only starts from the user's own action (Sign in, or a session they start).
 * Never throws.
 */
export async function probeCursor(
  exe: ResolvedCommand,
  opts: { signedIn?: boolean; timeoutMs?: number },
): Promise<CursorProbe> {
  const timeoutMs = opts.timeoutMs ?? 20_000;
  const signedIn = opts.signedIn ?? (await readCursorLogin(exe, timeoutMs)).loggedIn === true;
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
        // No `authMethod`: see above.
        // As sessions do, so `initialize` reports whether subagents run as child sessions.
        clientCapabilities: CURSOR_CLIENT_CAPABILITIES,
        timeoutMs,
      },
    );
    result.acp = true;
    result.info = started.info;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    result.error = [message, stderr.trim().split(/\r?\n/).slice(-3).join(" ")]
      .filter(Boolean)
      .join(": ")
      .slice(0, 400);
  }
  await started?.rpc.close();
  if (signedIn) {
    const run = await runCommand(exe, ["--list-models"], { timeoutMs });
    if (run.code === 0) Object.assign(result, parseModelList(run.stdout));
    else if (cursorLoginRequired(run.code, `${run.stdout}\n${run.stderr}`)) {
      result.loginRequired = true;
    }
  }
  return result;
}

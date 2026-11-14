import { FORK_POINT_MISSING, ProviderSessionError } from "../adapter";
import type { ResolvedCommand } from "../util/exec";
import { archiveThread, unarchiveThread } from "./history";
import { startAppServer } from "./process";
import type { ThreadForkParams, ThreadForkResponse, ThreadTurnsListResponse } from "./protocol/v2";
import { type CodexRpc, CodexRpcError } from "./rpc";

/** Turns listed per `thread/turns/list` page, and the most pages read to find a turn. */
const TURNS_PAGE = 100;
const MAX_PAGES = 50;

/**
 * How the app-server answers for a thread or turn it doesn't have. Codex 0.160 says
 * `no rollout found for thread id <id>` for a deleted thread and `turn not found: <id>` for a
 * missing `lastTurnId`. Other refusals (a turn still in progress, a malformed id) don't match.
 */
const MISSING = /\bno rollout found\b|\b(thread|turn|rollout) not found\b/i;

/**
 * Copy a Codex thread with `thread/fork` through a short-lived `codex app-server` and return
 * the new thread's id. The original thread is untouched; the session that resumes the copy
 * sets its own cwd, policy and instructions (`thread/resume` overrides). The process is closed
 * before returning, so it no longer holds the new thread when that session resumes it.
 *
 * With `upTo` (a turn id), the copy ends with that turn (`lastTurnId`). A thread that no
 * longer holds the turn, or no longer exists, throws `FORK_POINT_MISSING`: when the turn list
 * (`thread/turns/list`) shows it before anything is copied, or else when `thread/fork` answers
 * so. A short-lived app-server usually can't list a thread it hasn't loaded (Codex 0.160 says
 * `thread not loaded`), so `thread/fork`'s answer is what decides then. Any other failure, and
 * every failure of a whole copy, stays a plain error.
 */
export async function forkCodexThread(
  exe: ResolvedCommand,
  threadId: string,
  opts: { cwd: string; upTo?: string },
): Promise<string> {
  const { rpc } = await startAppServer(
    exe,
    {
      onNotification: () => {},
      // No turn runs here, so nothing should ask; decline anything that does.
      onRequest: async () => ({ decision: "decline" }),
      onExit: () => {},
    },
    { cwd: opts.cwd },
  );
  // CodeDen keeps idle threads archived (`./history`), and Codex forks no archived thread.
  const unarchived = await unarchiveThread(rpc, threadId);
  try {
    if (opts.upTo && (await holdsTurn(rpc, threadId, opts.upTo)) === false) {
      throw new ProviderSessionError(
        FORK_POINT_MISSING,
        "The thread no longer holds that turn (it was replaced or deleted), so it can't be forked there",
      );
    }
    const params: ThreadForkParams = {
      threadId,
      cwd: opts.cwd,
      excludeTurns: true,
      ...(opts.upTo ? { lastTurnId: opts.upTo } : {}),
    };
    const res = await rpc.request<ThreadForkResponse>("thread/fork", params);
    // The copy stays out of the Codex apps' recents too, until a session resumes it.
    await archiveThread(rpc, res.thread.id);
    return res.thread.id;
  } catch (error) {
    if (error instanceof ProviderSessionError) throw error;
    const message = (error as Error).message;
    if (opts.upTo && error instanceof CodexRpcError && MISSING.test(message)) {
      throw new ProviderSessionError(
        FORK_POINT_MISSING,
        `The thread no longer holds that turn (${message}), so it can't be forked there`,
      );
    }
    throw new Error(`Could not fork Codex thread ${threadId}: ${message}`);
  } finally {
    if (unarchived) await archiveThread(rpc, threadId);
    await rpc.close();
  }
}

/**
 * Whether the thread still holds `turnId`, from its turn list. Undefined when the list can't be
 * read (a thread this app-server hasn't loaded, or an app-server without the method):
 * `thread/fork` then decides.
 */
async function holdsTurn(
  rpc: CodexRpc,
  threadId: string,
  turnId: string,
): Promise<boolean | undefined> {
  let cursor: string | null = null;
  try {
    for (let page = 0; page < MAX_PAGES; page++) {
      const res: ThreadTurnsListResponse = await rpc.request<ThreadTurnsListResponse>(
        "thread/turns/list",
        { threadId, limit: TURNS_PAGE, itemsView: "notLoaded", ...(cursor ? { cursor } : {}) },
      );
      if (res.data.some((t) => t.id === turnId)) return true;
      cursor = res.nextCursor;
      if (!cursor) return false;
    }
    return undefined;
  } catch {
    return undefined;
  }
}

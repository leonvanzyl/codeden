import { FORK_POINT_MISSING, ProviderSessionError } from "../adapter";
import type { ResolvedCommand } from "../util/exec";
import { startAppServer } from "./process";
import type { ThreadForkParams, ThreadForkResponse, ThreadTurnsListResponse } from "./protocol/v2";
import type { CodexRpc } from "./rpc";

/** Turns listed per `thread/turns/list` page, and the most pages read to find a turn. */
const TURNS_PAGE = 100;
const MAX_PAGES = 50;

/**
 * Copy a Codex thread with `thread/fork` through a short-lived `codex app-server` and return
 * the new thread's id. The original thread is untouched; the session that resumes the copy
 * sets its own cwd, policy and instructions (`thread/resume` overrides). The process is closed
 * before returning, so it no longer holds the new thread when that session resumes it. With
 * `upTo` (a turn id), the copy ends with that turn (`lastTurnId`), once the thread's turns
 * (`thread/turns/list`) show it still holds that turn: one it doesn't throws
 * `FORK_POINT_MISSING` before anything is copied.
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
    return res.thread.id;
  } catch (error) {
    if (error instanceof ProviderSessionError) throw error;
    throw new Error(`Could not fork Codex thread ${threadId}: ${(error as Error).message}`);
  } finally {
    await rpc.close();
  }
}

/**
 * Whether the thread still holds `turnId`, from its turn list. Undefined when the list can't be
 * read (an app-server without the method, say): `thread/fork` then decides on its own.
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

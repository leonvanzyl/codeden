import type { ResolvedCommand } from "../util/exec";
import { startAppServer } from "./process";
import type { ThreadForkParams, ThreadForkResponse } from "./protocol/v2";

/**
 * Copy a Codex thread with `thread/fork` through a short-lived `codex app-server` and return
 * the new thread's id. The original thread is untouched; the session that resumes the copy
 * sets its own cwd, policy and instructions (`thread/resume` overrides). The process is closed
 * before returning, so it no longer holds the new thread when that session resumes it. With
 * `upTo` (a turn id), the copy ends with that turn (`lastTurnId`); Codex refuses a turn the
 * thread doesn't hold.
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
    const params: ThreadForkParams = {
      threadId,
      cwd: opts.cwd,
      excludeTurns: true,
      ...(opts.upTo ? { lastTurnId: opts.upTo } : {}),
    };
    const res = await rpc.request<ThreadForkResponse>("thread/fork", params);
    return res.thread.id;
  } catch (error) {
    throw new Error(`Could not fork Codex thread ${threadId}: ${(error as Error).message}`);
  } finally {
    await rpc.close();
  }
}

import type { ResolvedCommand } from "../util/exec";
import { startAppServer } from "./process";
import type { ThreadForkResponse } from "./protocol/v2";

/**
 * Copy a Codex thread with `thread/fork` through a short-lived `codex app-server` and return
 * the new thread's id. The original thread is untouched; the session that resumes the copy
 * sets its own cwd, policy and instructions (`thread/resume` overrides). The process is closed
 * before returning, so it no longer holds the new thread when that session resumes it.
 */
export async function forkCodexThread(
  exe: ResolvedCommand,
  threadId: string,
  opts: { cwd: string },
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
    const res = await rpc.request<ThreadForkResponse>("thread/fork", {
      threadId,
      cwd: opts.cwd,
      excludeTurns: true,
    });
    return res.thread.id;
  } catch (error) {
    throw new Error(`Could not fork Codex thread ${threadId}: ${(error as Error).message}`);
  } finally {
    await rpc.close();
  }
}

import { ProviderSessionError } from "../adapter";
import { isThreadNotFound, unarchiveThread } from "./history";
import type {
  ThreadResumeParams,
  ThreadResumeResponse,
  ThreadStartParams,
  ThreadStartResponse,
  TurnStartParams,
  TurnStartResponse,
} from "./protocol/v2";
import type { CodexRpc } from "./rpc";

/** Settings a session's thread opens with, on `thread/start` and `thread/resume` alike. */
export type ThreadSettings = Omit<ThreadStartParams & ThreadResumeParams, "threadId">;

/**
 * Open a session's thread on `rpc`: resume `resumeId` when there is one, else start a new thread.
 * CodeDen archives its threads while they are idle (`./history`), so a thread is unarchived
 * before it is resumed. A resume that fails for another reason starts a new thread and reports
 * why through `onResumeFailed`, except a thread another process still writes to, which throws
 * `resume_conflict` after a few tries.
 */
export async function openCodexThread(
  rpc: CodexRpc,
  resumeId: string | undefined,
  settings: ThreadSettings,
  onResumeFailed: (message: string) => void,
): Promise<ThreadStartResponse | ThreadResumeResponse> {
  if (resumeId) {
    await unarchiveThread(rpc, resumeId);
    // A thread has a single writer: while a previous app-server is still shutting down,
    // resume fails with "already has an active writer". Retry briefly, then give up loudly.
    for (let attempt = 0; ; attempt += 1) {
      try {
        return await rpc.request<ThreadResumeResponse>("thread/resume", {
          threadId: resumeId,
          excludeTurns: true,
          ...settings,
        });
      } catch (error) {
        const message = (error as Error).message;
        if (/active writer/i.test(message)) {
          if (attempt < 5) {
            await new Promise((r) => setTimeout(r, 500 * (attempt + 1)));
            continue;
          }
          await rpc.close();
          throw new ProviderSessionError(
            "resume_conflict",
            `Codex thread ${resumeId} is still open in another process`,
          );
        }
        onResumeFailed(`Could not resume Codex thread ${resumeId}; started a new one. ${message}`);
        break;
      }
    }
  }
  return rpc.request<ThreadStartResponse>("thread/start", settings);
}

/**
 * `turn/start` on `rpc`. When Codex no longer has the thread loaded ("thread not found": an
 * archive that answered after CodeDen stopped waiting still unloaded it), `reopen` opens the
 * thread again (unarchive + resume) and the turn is tried once more, on the thread id `reopen`
 * returns (a new thread when the resume failed).
 */
export async function startTurn(
  rpc: CodexRpc,
  params: TurnStartParams,
  reopen: () => Promise<string>,
): Promise<TurnStartResponse> {
  try {
    return await rpc.request<TurnStartResponse>("turn/start", params);
  } catch (error) {
    if (!isThreadNotFound(error) || rpc.isClosed) throw error;
    const threadId = await reopen();
    return rpc.request<TurnStartResponse>("turn/start", { ...params, threadId });
  }
}

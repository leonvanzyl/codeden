import { tmpdir } from "node:os";
import {
  PROVIDER_HISTORY_PREVIEW_MAX,
  type ProviderHistoryEntry,
  type ProviderHistoryHideResult,
} from "@codeden/contracts";
import type { ResolvedCommand } from "../util/exec";
import { startAppServer } from "./process";
import type { ThreadListResponse } from "./protocol/v2";
import type { CodexRpc } from "./rpc";

/**
 * Keeping CodeDen's threads out of the Codex apps' history. The Codex apps list the threads in
 * the user's Codex home as the user's recents (`thread/list` without `archived`), and every
 * thread `codex app-server` starts for CodeDen is one of them. Archived threads aren't listed but
 * stay on disk. Codex 0.160 won't resume or fork an archived thread until it is unarchived, and
 * archiving unloads a thread from the app-server. So CodeDen archives its threads whenever it is
 * done with them for now (a turn ended, the session closed) and unarchives one just before it
 * resumes or forks it. Ephemeral threads (`ephemeral: true`) are never listed, but a later
 * app-server can't resume them, so only one-shot calls use them.
 */

/** How long archiving may take before CodeDen moves on (it never blocks a session for long). */
export const ARCHIVE_TIMEOUT_MS = 5_000;

/** Codex's answer for a thread that has no rollout to archive (archived already, or deleted). */
const NO_ROLLOUT = /\bno rollout found\b|\bthread not found\b/i;

/** Threads listed per `thread/list` page, and the most pages read. */
const LIST_PAGE = 200;
const MAX_PAGES = 100;

/**
 * Unarchive `threadId` before resuming or forking it. True when it was archived. Never throws:
 * a thread that isn't archived ("no archived rollout found"), or a Codex without the method,
 * leaves the decision to the resume or fork that follows.
 */
export async function unarchiveThread(rpc: CodexRpc, threadId: string): Promise<boolean> {
  try {
    await rpc.request("thread/unarchive", { threadId });
    return true;
  } catch {
    return false;
  }
}

/**
 * Archive `threadId` so the Codex apps stop listing it. True when Codex archived it. Never
 * throws, and gives up after `timeoutMs`: a thread left listed is only clutter.
 */
export async function archiveThread(
  rpc: CodexRpc,
  threadId: string,
  timeoutMs = ARCHIVE_TIMEOUT_MS,
): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<boolean>((resolve) => {
    timer = setTimeout(() => resolve(false), timeoutMs);
  });
  try {
    return await Promise.race([
      rpc.request("thread/archive", { threadId }).then(
        () => true,
        () => false,
      ),
      timeout,
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/** A short-lived app-server for history work: no thread runs, so nothing should ask. */
async function historyServer(
  exe: ResolvedCommand,
  opts: { env?: Record<string, string>; cwd?: string } = {},
): Promise<CodexRpc> {
  const { rpc } = await startAppServer(
    exe,
    {
      onNotification: () => {},
      onRequest: async () => ({ decision: "decline" }),
      onExit: () => {},
    },
    { cwd: opts.cwd ?? tmpdir(), ...(opts.env ? { env: opts.env } : {}) },
  );
  return rpc;
}

/**
 * Archive one thread through a short-lived app-server: for a thread whose own app-server died
 * mid-turn, so the crash doesn't leave it listed. True when archived; never throws.
 */
export async function archiveThreadOnce(
  exe: ResolvedCommand,
  threadId: string,
  opts: { env?: Record<string, string>; cwd?: string } = {},
): Promise<boolean> {
  let rpc: CodexRpc | undefined;
  try {
    rpc = await historyServer(exe, opts);
    return await archiveThread(rpc, threadId);
  } catch {
    return false;
  } finally {
    await rpc?.close();
  }
}

/**
 * Which of `threadIds` the Codex apps list as the user's recents: `thread/list` with Codex's
 * default filter (interactive, not archived), kept to the given ids. Newest first.
 */
export async function listCodexHistory(
  exe: ResolvedCommand,
  threadIds: string[],
): Promise<ProviderHistoryEntry[]> {
  const wanted = new Set(threadIds);
  if (wanted.size === 0) return [];
  const rpc = await historyServer(exe);
  try {
    const found: ProviderHistoryEntry[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < MAX_PAGES; page++) {
      const res: ThreadListResponse = await rpc.request<ThreadListResponse>("thread/list", {
        limit: LIST_PAGE,
        ...(cursor ? { cursor } : {}),
      });
      for (const t of res.data) {
        if (!wanted.has(t.id)) continue;
        found.push({
          resumeToken: t.id,
          preview: (t.name || t.preview || "").trim().slice(0, PROVIDER_HISTORY_PREVIEW_MAX),
          updatedAt: Number.isFinite(t.updatedAt)
            ? new Date(t.updatedAt * 1000).toISOString()
            : null,
        });
      }
      cursor = res.nextCursor;
      if (!cursor) break;
    }
    return found;
  } finally {
    await rpc.close();
  }
}

/** Archive each of `threadIds` (and nothing else), one after the other. */
export async function hideCodexHistory(
  exe: ResolvedCommand,
  threadIds: string[],
): Promise<ProviderHistoryHideResult> {
  const result: ProviderHistoryHideResult = { hidden: [], missing: [], failed: [] };
  const ids = [...new Set(threadIds)];
  if (ids.length === 0) return result;
  const rpc = await historyServer(exe);
  try {
    for (const threadId of ids) {
      try {
        await rpc.request("thread/archive", { threadId });
        result.hidden.push(threadId);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (NO_ROLLOUT.test(message)) result.missing.push(threadId);
        else result.failed.push({ resumeToken: threadId, message: message.slice(0, 300) });
      }
    }
    return result;
  } finally {
    await rpc.close();
  }
}

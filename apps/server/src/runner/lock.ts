import { RunnerLock } from "@codeden/contracts";
import { readJsonFile } from "../json-file";

/** True when a process with this pid exists (EPERM still means it exists). */
export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** Read the runner lock file; `undefined` when missing, invalid, or its process is gone. */
export function readLiveRunnerLock(file: string): RunnerLock | undefined {
  const parsed = RunnerLock.safeParse(readJsonFile(file));
  if (!parsed.success) return undefined;
  return isProcessAlive(parsed.data.pid) ? parsed.data : undefined;
}

/**
 * Stronger liveness check: the runner answers `/health` with the lock's token. A pid that
 * exists but doesn't answer is a stale lock (crash plus pid reuse) or a hung runner.
 */
export async function probeRunnerLock(
  lock: RunnerLock,
  timeoutMs = 3_000,
  /** Cancels the probe early (it then counts as not answering). */
  signal?: AbortSignal,
): Promise<boolean> {
  const timeout = AbortSignal.timeout(timeoutMs);
  try {
    const res = await fetch(`http://127.0.0.1:${lock.port}/health`, {
      headers: { authorization: `Bearer ${lock.token}` },
      signal: signal ? AbortSignal.any([timeout, signal]) : timeout,
    });
    return res.ok;
  } catch {
    return false;
  }
}

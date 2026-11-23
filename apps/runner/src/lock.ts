import { readFileSync, rmSync } from "node:fs";
import { RunnerLock } from "@codeden/contracts";
import type { ProcessRow } from "./process/inside";
import { processTable } from "./process/table";
import { isAlive, killTree, waitForExit } from "./process/tree";

/** Lock files owned by runners in this process (several embedded runners in tests). */
const activeLocks = new Set<string>();

export function readLock(lockFile: string): RunnerLock | undefined {
  try {
    const parsed = RunnerLock.safeParse(JSON.parse(readFileSync(lockFile, "utf8")));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Liveness check beyond "the pid exists": the runner answers `/health` with its token.
 * Guards against pid reuse after a crash left a stale lock file.
 */
export async function probeRunner(lock: RunnerLock, timeoutMs = 3_000): Promise<boolean> {
  if (!isAlive(lock.pid)) return false;
  try {
    const res = await fetch(`http://127.0.0.1:${lock.port}/health`, {
      headers: { authorization: `Bearer ${lock.token}` },
      signal: AbortSignal.timeout(timeoutMs),
    });
    return res.ok;
  } catch {
    return false;
  }
}

/** How much earlier than a lock's `startedAt` its runner may be reported to start (Linux rounds to seconds). */
const START_SLACK_MS = 2_000;

/** True when `line` passes `home` as a whole argument (quoted or not), never as part of a longer path. */
function passesHome(line: string, home: string): boolean {
  for (let at = line.indexOf(home); at !== -1; at = line.indexOf(home, at + 1)) {
    const before = line[at - 1] ?? " ";
    const after = line[at + home.length] ?? " ";
    if (/[\s"'=]/.test(before) && /[\s"']/.test(after)) return true;
  }
  return false;
}

/**
 * True when `row` is the runner that wrote `lock` for `home`: it runs with `home` as an argument
 * and started before the lock was written. A process started later only reused the pid of a
 * runner that crashed, and must never be stopped in its place.
 */
export function isLockOwner(row: ProcessRow | undefined, lock: RunnerLock, home: string): boolean {
  if (row?.pid !== lock.pid || row.startedAt === null || row.commandLine === null) return false;
  const written = Date.parse(lock.startedAt);
  return row.startedAt <= written + START_SLACK_MS && passesHome(row.commandLine, home);
}

/**
 * Throw when another live runner owns this home; claim the lock for this process. A runner that
 * holds the lock but doesn't answer (hung or stuck busy, #588) is stopped with its process tree
 * first, so two runners never host the same sessions and worktrees.
 */
export async function assertSingleInstance(
  lockFile: string,
  home: string,
  log: (message: string) => void = () => {},
): Promise<void> {
  if (activeLocks.has(lockFile)) throw new Error("Another runner is already running for this home");
  const lock = readLock(lockFile);
  if (lock && lock.pid !== process.pid && isAlive(lock.pid)) {
    // Longer than the server's probe: a runner that is only slow keeps its sessions.
    if (await probeRunner(lock, 10_000)) {
      throw new Error(`Another runner (pid ${lock.pid}) is already running for this home`);
    }
    const rows = await processTable().catch(() => [] as ProcessRow[]);
    if (
      isLockOwner(
        rows.find((r) => r.pid === lock.pid),
        lock,
        home,
      )
    ) {
      log(`runner pid ${lock.pid} holds the lock but does not answer; stopping it`);
      await killTree(lock.pid, 5_000);
      await waitForExit(lock.pid, 5_000);
    }
  }
  activeLocks.add(lockFile);
}

/** Remove the lock file if it still belongs to this process. */
export function removeOwnLock(lockFile: string): void {
  activeLocks.delete(lockFile);
  const current = readLock(lockFile);
  if (current?.pid === process.pid) rmSync(lockFile, { force: true });
}

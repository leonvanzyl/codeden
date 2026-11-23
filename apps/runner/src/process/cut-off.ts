import type { ProcessRow } from "./inside";
import { treeIn } from "./tree";

export interface CutOffOptions {
  /** The process table just before the session stopped. */
  before: readonly ProcessRow[];
  /** The process table once it has stopped. */
  after: readonly ProcessRow[];
  runnerPid: number;
  /**
   * Processes the runner tracks itself (its terminals and checks), as listed before the stop:
   * a branch under one of them isn't the stopped session's, since it may work in another folder.
   */
  tracked?: ReadonlySet<number>;
}

/**
 * Windows: the processes a session's stop cut off from the runner's process tree, by pid: what
 * its agent left running. Windows doesn't report another process's working directory, and
 * CodeDen never reads one from the process's memory (#608), so the process tree tells instead,
 * from process ids, parent ids and start times alone. A process counts when, just before the
 * stop, it descended from the runner, and now it still runs (the same pid with the same start
 * time) but no longer does, because the process at the top of its branch, one the runner
 * started itself (the agent's CLI), has exited. Parent ids are checked against start times
 * (`treeIn`): a process keeps the pid of a parent that exited, and pids are reused.
 *
 * Not counted:
 * - a branch under a process the runner tracks (`tracked`);
 * - a branch whose top still runs: a dev server another session's shell left when it exited
 *   during the stop is still under that session's agent;
 * - a process that had already left the tree before the stop (its parent exited earlier, as
 *   with a server started in the background from a shell that then exited). That one is found
 *   only by its executable or command line, so detection on Windows is weaker than on Linux and
 *   macOS, which report working directories.
 *
 * Another top that exits during the same stop (a second session stopping, a crash) can't be
 * told apart from the stopped session's agent, so the caller doesn't use this when stops overlap.
 */
export function cutOffByStop(opts: CutOffOptions): Set<number> {
  const { before, after, runnerPid } = opts;
  const descended = (rows: readonly ProcessRow[]) =>
    new Set(treeIn(rows, runnerPid, { checkStarts: true }));
  const was = descended(before);
  const is = descended(after);
  const parentBefore = new Map(before.map((r) => [r.pid, r.ppid]));
  const startBefore = new Map(before.map((r) => [r.pid, r.startedAt]));
  const startAfter = new Map(after.map((r) => [r.pid, r.startedAt]));
  /** The same process is in both tables: the same pid with the same, known, start time. */
  const stillRuns = (pid: number) => {
    const started = startBefore.get(pid);
    return started !== undefined && started !== null && startAfter.get(pid) === started;
  };
  /** The runner's child at the top of `pid`'s branch before the stop. */
  const top = (pid: number): number => {
    const visited = new Set<number>();
    let current = pid;
    for (;;) {
      const parent = parentBefore.get(current);
      if (parent === undefined || parent === runnerPid || visited.has(parent)) return current;
      visited.add(current);
      current = parent;
    }
  };
  const out = new Set<number>();
  for (const pid of was) {
    if (!stillRuns(pid) || is.has(pid)) continue;
    const head = top(pid);
    if (stillRuns(head) || opts.tracked?.has(head)) continue;
    out.add(pid);
  }
  return out;
}

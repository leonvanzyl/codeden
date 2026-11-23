import { execFile } from "node:child_process";

const isWindows = process.platform === "win32";

function exec(file: string, args: string[], timeoutMs = 15_000): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      file,
      args,
      { windowsHide: true, timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024 },
      (error, stdout) => (error ? reject(error) : resolve(stdout)),
    );
  });
}

/** True when a process with this pid exists (EPERM still means it exists). */
export function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** Resolves true once `pid` is gone, false if it is still alive after `timeoutMs`. */
export async function waitForExit(
  pid: number,
  timeoutMs: number,
  alive: (pid: number) => boolean = isAlive,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!alive(pid)) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  return !alive(pid);
}

/**
 * Kill a process and everything it started.
 * - Windows: `taskkill /T /F /PID <pid>` (walks the parent-pid tree).
 * - POSIX: signal the process group (children are spawned as group leaders), then the pid.
 *   `SIGTERM` first; `SIGKILL` after `graceMs` if anything is still alive.
 */
export async function killTree(pid: number, graceMs = 2_000): Promise<void> {
  if (!isAlive(pid)) return;
  if (isWindows) {
    await exec("taskkill", ["/T", "/F", "/PID", String(pid)]).catch(() => undefined);
    return;
  }
  const descendants = await listDescendants(pid).catch(() => [] as number[]);
  signalPosix(pid, descendants, "SIGTERM");
  const deadline = Date.now() + graceMs;
  while (Date.now() < deadline) {
    if (![pid, ...descendants].some(isAlive)) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  signalPosix(pid, descendants, "SIGKILL");
}

/**
 * When a process CodeDen spawned was alive: from `startedAt` (taken just before it was
 * spawned) until `endedAt`, once its exit has been seen. It tells what that process started
 * from what an earlier process with the same pid did (`treeIn`).
 */
export interface ProcessLife {
  startedAt: number;
  endedAt?: number;
}

/**
 * Kill a process CodeDen spawned and everything it started, also when it has already exited.
 * - Windows: the children of an exited process keep its pid as their parent id, so they are
 *   still found, and pids are reused, so they are told apart from an earlier process's by start
 *   time (`treeIn` with `life`). The process, if it still runs, is ended first, then each one
 *   found on its own: never `taskkill /T`, which follows parent ids without that check.
 * - POSIX: such children are adopted by init, so the process must have been spawned as a
 *   process-group leader (`detached`): its tree is killed, then its group, which outlives the
 *   leader. (A descendant that started a session of its own after its parent exited can't be
 *   found there.)
 */
export async function killTreeAndOrphans(
  pid: number,
  life: ProcessLife,
  opts: { graceMs?: number; ops?: TreeOps } = {},
): Promise<void> {
  const ops = opts.ops ?? systemTreeOps;
  const graceMs = opts.graceMs ?? 2_000;
  if (ops.platform === "win32") {
    // Not seen exiting, so the pid is still its own: end it before it starts anything else.
    // From then on, nothing it started can have started later.
    if (life.endedAt === undefined && ops.isAlive(pid)) ops.killProcess(pid);
    const ended = { ...life, endedAt: life.endedAt ?? ops.now() };
    const rows = await ops.table().catch(() => [] as ProcessEntry[]);
    for (const child of treeIn(rows, pid, { checkStarts: true, root: ended })) {
      ops.killProcess(child);
    }
    return;
  }
  const rows = await ops.table().catch(() => [] as ProcessEntry[]);
  const descendants = treeIn(rows, pid, { checkStarts: false });
  await ops.killTree(pid, graceMs);
  await Promise.all(descendants.map((child) => ops.killTree(child, graceMs)));
  ops.killGroup(pid);
}

/** What `killTreeAndOrphans` does to processes; tests pass fakes. */
export interface TreeOps {
  platform: NodeJS.Platform;
  /** The system's process table. */
  table: () => Promise<ProcessEntry[]>;
  isAlive: (pid: number) => boolean;
  now: () => number;
  /** POSIX: `killTree`. */
  killTree: (pid: number, graceMs: number) => Promise<void>;
  /** End this one process (Windows). */
  killProcess: (pid: number) => void;
  /** `SIGKILL` the process group led by `pid`, if it still exists. */
  killGroup: (pid: number) => void;
}

const systemTreeOps: TreeOps = {
  platform: process.platform,
  table: () => processRows(),
  isAlive,
  now: () => Date.now(),
  killTree: (pid, graceMs) => killTree(pid, graceMs),
  killProcess,
  killGroup: (pid) => {
    try {
      process.kill(-pid, "SIGKILL");
    } catch {
      // the group is gone
    }
  },
};

/** End one process, and nothing it started (on Windows, `TerminateProcess`). */
export function killProcess(pid: number): void {
  try {
    process.kill(pid, "SIGKILL");
  } catch {
    // already gone
  }
}

function signalPosix(pid: number, descendants: number[], signal: NodeJS.Signals): void {
  for (const target of [-pid, pid, ...descendants]) {
    try {
      process.kill(target, signal);
    } catch {
      // gone, or not a group leader
    }
  }
}

/** A process in the table: its parent, and when it started (ms since the epoch) where known. */
export interface ProcessEntry {
  pid: number;
  ppid: number;
  startedAt: number | null;
}

/**
 * Parse `pid ppid [startedAt]` lines (Windows adds the start time in ms since the epoch; `ps`
 * prints only the two ids).
 */
export function parseProcessRows(output: string): ProcessEntry[] {
  return output.split(/\r?\n/).flatMap((line) => {
    const match = /^\s*(\d+)\s+(\d+)(?:\s+(\d+))?\s*$/.exec(line);
    if (!match) return [];
    const startedAt = match[3] === undefined ? null : Number(match[3]);
    return [{ pid: Number(match[1]), ppid: Number(match[2]), startedAt }];
  });
}

/** Parse `pid ppid` lines into a parent -> children map. */
export function parseProcessTable(output: string): Map<number, number[]> {
  const children = new Map<number, number[]>();
  for (const { pid, ppid } of parseProcessRows(output)) {
    if (pid === ppid) continue;
    children.set(ppid, [...(children.get(ppid) ?? []), pid]);
  }
  return children;
}

/** Every process with its parent (and, on Windows, its start time). */
async function processRows(): Promise<ProcessEntry[]> {
  const output = isWindows
    ? await exec("powershell.exe", [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        'Get-CimInstance Win32_Process -Property ProcessId,ParentProcessId,CreationDate | ForEach-Object { "$($_.ProcessId) $($_.ParentProcessId) $(if ($_.CreationDate) { ([DateTimeOffset]$_.CreationDate).ToUnixTimeMilliseconds() })" }',
      ])
    : await exec("ps", ["-A", "-o", "pid=,ppid="]);
  return parseProcessRows(output);
}

/**
 * The start time the system reports for a process may be up to a clock tick earlier than the
 * spawn time taken in Node just before it (never later than its parent's exit, which Node sees
 * after the fact).
 */
const CLOCK_SLACK_MS = 1_000;

/**
 * The descendants of `rootPid` in `rows` (children, grandchildren, ...), breadth first.
 *
 * With `checkStarts` (Windows), parent ids are checked against start times. A process there
 * keeps the pid of a parent that exited, and pids are reused, so the processes naming a pid as
 * their parent may have been started by an earlier process that had it. A child counts only
 * when it started after its parent: for the root, during `root` (its life), or without it after
 * the root's own start in the table; below that, after its parent's start. One whose start time
 * is unknown doesn't count. Elsewhere orphans get a new parent, so parent ids are taken as is.
 */
export function treeIn(
  rows: readonly ProcessEntry[],
  rootPid: number,
  opts: { checkStarts: boolean; root?: ProcessLife },
): number[] {
  const children = new Map<number, ProcessEntry[]>();
  for (const row of rows) {
    if (row.pid === row.ppid) continue;
    children.set(row.ppid, [...(children.get(row.ppid) ?? []), row]);
  }
  /** For each process found: the earliest and latest start a child of it may have. */
  const window = new Map<number, { from: number; until: number }>();
  if (opts.checkStarts) {
    const life = opts.root;
    const from = life
      ? life.startedAt - CLOCK_SLACK_MS
      : rows.find((r) => r.pid === rootPid)?.startedAt;
    if (from === undefined || from === null) return [];
    window.set(rootPid, { from, until: life?.endedAt ?? Infinity });
  }
  const out: number[] = [];
  const seen = new Set<number>([rootPid]);
  const queue = [rootPid];
  while (queue.length > 0) {
    const pid = queue.shift() as number;
    const bounds = window.get(pid);
    for (const child of children.get(pid) ?? []) {
      if (seen.has(child.pid)) continue;
      if (opts.checkStarts) {
        const started = child.startedAt;
        if (!bounds || started === null || started < bounds.from || started > bounds.until)
          continue;
        window.set(child.pid, { from: started, until: Infinity });
      }
      seen.add(child.pid);
      out.push(child.pid);
      queue.push(child.pid);
    }
  }
  return out;
}

/**
 * All descendants of `rootPid` (children, grandchildren, ...), breadth first. On Windows they
 * are checked against start times (`treeIn`): pass `life` for a process that may have exited.
 */
export async function listDescendants(rootPid: number, life?: ProcessLife): Promise<number[]> {
  return treeIn(await processRows(), rootPid, { checkStarts: isWindows, root: life });
}

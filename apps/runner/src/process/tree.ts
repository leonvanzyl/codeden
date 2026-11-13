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
 * Kill a process and everything it started, also when it has already exited. Its
 * descendants are listed first and killed as trees of their own: on Windows the children of
 * an exited process keep its pid as their parent id, so they are still found. On POSIX, where
 * such children are adopted by init, the process must have been spawned as a process-group
 * leader (`detached`): its group is signalled, which outlives the leader. (A descendant that
 * started a session of its own after its parent exited can't be found there.)
 */
export async function killTreeAndOrphans(
  pid: number,
  graceMs = 2_000,
  ops: TreeOps = systemTreeOps,
): Promise<void> {
  const descendants = await ops.listDescendants(pid).catch(() => [] as number[]);
  await ops.killTree(pid, graceMs);
  await Promise.all(descendants.map((child) => ops.killTree(child, graceMs)));
  if (ops.platform !== "win32") ops.killGroup(pid);
}

/** What `killTreeAndOrphans` does to processes; tests pass fakes. */
export interface TreeOps {
  platform: NodeJS.Platform;
  listDescendants: (pid: number) => Promise<number[]>;
  killTree: (pid: number, graceMs: number) => Promise<void>;
  /** `SIGKILL` the process group led by `pid`, if it still exists. */
  killGroup: (pid: number) => void;
}

const systemTreeOps: TreeOps = {
  platform: process.platform,
  listDescendants: (pid) => listDescendants(pid),
  killTree: (pid, graceMs) => killTree(pid, graceMs),
  killGroup: (pid) => {
    try {
      process.kill(-pid, "SIGKILL");
    } catch {
      // the group is gone
    }
  },
};

function signalPosix(pid: number, descendants: number[], signal: NodeJS.Signals): void {
  for (const target of [-pid, pid, ...descendants]) {
    try {
      process.kill(target, signal);
    } catch {
      // gone, or not a group leader
    }
  }
}

/** Parse `pid ppid` lines into a parent -> children map. */
export function parseProcessTable(output: string): Map<number, number[]> {
  const children = new Map<number, number[]>();
  for (const line of output.split(/\r?\n/)) {
    const match = /^\s*(\d+)\s+(\d+)\s*$/.exec(line);
    if (!match) continue;
    const pid = Number(match[1]);
    const ppid = Number(match[2]);
    if (pid === ppid) continue;
    const list = children.get(ppid) ?? [];
    list.push(pid);
    children.set(ppid, list);
  }
  return children;
}

async function processTable(): Promise<Map<number, number[]>> {
  const output = isWindows
    ? await exec("powershell.exe", [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        'Get-CimInstance Win32_Process | ForEach-Object { "$($_.ProcessId) $($_.ParentProcessId)" }',
      ])
    : await exec("ps", ["-A", "-o", "pid=,ppid="]);
  return parseProcessTable(output);
}

/** All descendants of `rootPid` (children, grandchildren, ...), breadth first. */
export async function listDescendants(rootPid: number): Promise<number[]> {
  const table = await processTable();
  const out: number[] = [];
  const seen = new Set<number>([rootPid]);
  const queue = [rootPid];
  while (queue.length > 0) {
    const pid = queue.shift() as number;
    for (const child of table.get(pid) ?? []) {
      if (seen.has(child)) continue;
      seen.add(child);
      out.push(child);
      queue.push(child);
    }
  }
  return out;
}

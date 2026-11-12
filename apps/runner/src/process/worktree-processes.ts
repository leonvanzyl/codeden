import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  endableForRemoval,
  type ProcessRow,
  processesToEnd,
  runsInside,
  startedByAgents,
  withDescendants,
} from "./inside";
import { processTable } from "./table";
import { killTree } from "./tree";

export interface EndProcessesOptions {
  /** The CodeDen home: its `server.json` names the server process, which is never ended. */
  home: string;
  /**
   * The folder is about to be deleted. On Windows, where a process using a folder keeps it from
   * being moved, also end what agents of an earlier runner (or anyone else) left running there,
   * except what a person started from an editor, terminal or file manager
   * (`endableForRemoval`). Linux and macOS delete a folder while processes use it, so there, as
   * without it, only what this runner's agents started is ended (`startedByAgents`), and a
   * person's own shells and dev servers keep running wherever they were started from.
   */
  removing?: boolean;
  /**
   * For a folder moved away at this time (ms since the epoch): only processes known to have
   * started at or before it may be ended, with their whole tree, so a process with anything
   * started since (or at an unknown time) running under it is never chosen either. Nothing in
   * a worktree recreated at the same path is touched, even when an old launcher started it.
   */
  startedBefore?: number;
  /** Also allowed: processes seen as the runner's descendants earlier (`runnerDescendants`). */
  seen?: ReadonlySet<number>;
  /** Processes never ended, with everything they started (the user's terminals). */
  spare?: readonly number[];
  log?: (message: string) => void;
  /** Reads the process table (tests). */
  table?: () => Promise<ProcessRow[]>;
  /** Ends a process tree (tests). */
  kill?: (pid: number) => Promise<void>;
}

/** When this runner process started (ms since the epoch). */
const RUNNER_STARTED_AT = Date.now() - process.uptime() * 1000;

/** The server's pid from `<home>/server.json`, when it is there. */
function serverPid(home: string): number | undefined {
  try {
    const lock = JSON.parse(readFileSync(join(home, "server.json"), "utf8")) as { pid?: unknown };
    return typeof lock.pid === "number" ? lock.pid : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The runner's descendants right now, by pid. Taken before a session stops, so what its agent
 * started still counts as the agent's once the agent has exited (where a process that lost its
 * parent is adopted by another, as on Linux and macOS).
 */
export async function runnerDescendants(
  table: () => Promise<ProcessRow[]> = processTable,
): Promise<Set<number>> {
  const rows = await table().catch(() => [] as ProcessRow[]);
  const all = withDescendants([process.pid], rows);
  all.delete(process.pid);
  return all;
}

/** A process as a message names it: `node.exe (1234)`. */
function describe(row: ProcessRow): string {
  const program = row.exe ?? row.commandLine?.trim().split(/\s+/)[0]?.replace(/"/g, "") ?? "?";
  return `${program.split(/[\\/]/).pop() || program} (${row.pid})`;
}

/**
 * End the processes still running from or in `dir` that the runner doesn't track itself: a dev
 * server an agent started through its shell outlives the agent, and on Windows a process
 * holding a file (or its working directory) in a folder keeps the folder from being moved.
 *
 * A process counts when its executable or its working directory is inside `dir`, or its
 * command line names something inside it, matched as whole paths; and it was started by
 * CodeDen's agents or terminals (`startedByAgents`), or, when `removing` on Windows, by anyone
 * but a person in an editor, terminal or file manager (`endableForRemoval`). CodeDen itself is
 * never ended: not the runner, not the server, and not their ancestors (the CLI, the desktop
 * app). Each is ended with its whole tree, so nothing with one of those, or a person's app,
 * running under it is chosen (`processesToEnd`). `dir` may name several folders (one moved
 * away, by both its paths). Returns the pids it ended; never throws.
 */
export async function endProcessesInside(
  dir: string | readonly string[],
  opts: EndProcessesOptions,
): Promise<number[]> {
  const dirs = typeof dir === "string" ? [dir] : dir;
  let rows: ProcessRow[];
  try {
    rows = await (opts.table ?? processTable)();
  } catch (error) {
    opts.log?.(`could not list processes in ${dirs.join(", ")}: ${(error as Error).message}`);
    return [];
  }
  const server = serverPid(opts.home);
  const windows = process.platform === "win32";
  const protect = [process.pid, ...(server !== undefined ? [server] : [])];
  const spare = new Set(opts.spare ? withDescendants(opts.spare, rows) : []);
  // A folder moved away at `startedBefore`: what started since, or at an unknown time, is kept
  // like a spared terminal, so neither it nor a process it runs under (whose tree kill would
  // end it) is chosen.
  const { startedBefore } = opts;
  if (startedBefore !== undefined) {
    for (const r of rows) if (!((r.startedAt ?? Infinity) <= startedBefore)) spare.add(r.pid);
  }
  // Only Windows refuses to move a folder something runs in (see `removing`).
  const removing = opts.removing === true && windows;
  const victims = new Set<number>();
  for (const folder of dirs) {
    const allowed = removing
      ? endableForRemoval({ rows, runnerPid: process.pid, protect, dir: folder, windows })
      : startedByAgents(rows, process.pid, RUNNER_STARTED_AT, windows);
    for (const pid of opts.seen ?? []) allowed.add(pid);
    const chosen = processesToEnd({ dir: folder, rows, windows, protect, allowed, spare });
    for (const pid of chosen) victims.add(pid);
  }
  if (victims.size === 0) return [];
  const ended = [...victims];
  const kill = opts.kill ?? ((pid: number) => killTree(pid, 500));
  await Promise.all(ended.map((pid) => kill(pid).catch(() => undefined)));
  const names = ended.map((pid) => {
    const row = rows.find((r) => r.pid === pid);
    return `${pid} (${row?.exe ?? row?.commandLine?.slice(0, 80) ?? "?"})`;
  });
  opts.log?.(`ended ${ended.length} process(es) in ${dirs.join(", ")}: ${names.join(", ")}`);
  return ended;
}

/**
 * What still runs from or in `dir` (other than this runner), named for a message, such as
 * `["Code.exe (5100)"]`: the processes that may be holding it. Empty when none or unknown.
 */
export async function processesStillInside(
  dir: string,
  table: () => Promise<ProcessRow[]> = processTable,
): Promise<string[]> {
  const rows = await table().catch(() => [] as ProcessRow[]);
  const windows = process.platform === "win32";
  return rows.filter((r) => r.pid !== process.pid && runsInside(dir, r, windows)).map(describe);
}

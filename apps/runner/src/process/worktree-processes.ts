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
   * The folder is about to be deleted: also end what agents of an earlier runner (or anyone
   * else) left running there, except what a person started from an editor, terminal or file
   * manager (`endableForRemoval`). Without it, only what this runner's agents started.
   */
  removing?: boolean;
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
 * CodeDen's agents or terminals (`startedByAgents`), or, when `removing`, by anyone but a person
 * in an editor, terminal or file manager (`endableForRemoval`). CodeDen itself is never ended:
 * not the runner, not the server, and not their ancestors (the CLI, the desktop app). Returns
 * the pids it ended; never throws.
 */
export async function endProcessesInside(
  dir: string,
  opts: EndProcessesOptions,
): Promise<number[]> {
  let rows: ProcessRow[];
  try {
    rows = await (opts.table ?? processTable)();
  } catch (error) {
    opts.log?.(`could not list processes in ${dir}: ${(error as Error).message}`);
    return [];
  }
  const server = serverPid(opts.home);
  const windows = process.platform === "win32";
  const protect = [process.pid, ...(server !== undefined ? [server] : [])];
  const allowed = opts.removing
    ? endableForRemoval({ rows, runnerPid: process.pid, protect, dir, windows })
    : startedByAgents(rows, process.pid, RUNNER_STARTED_AT);
  for (const pid of opts.seen ?? []) allowed.add(pid);
  const victims = processesToEnd({
    dir,
    rows,
    windows,
    protect,
    allowed,
    spare: opts.spare ? withDescendants(opts.spare, rows) : undefined,
  });
  if (victims.length === 0) return [];
  const kill = opts.kill ?? ((pid: number) => killTree(pid, 500));
  await Promise.all(victims.map((pid) => kill(pid).catch(() => undefined)));
  const names = victims.map((pid) => {
    const row = rows.find((r) => r.pid === pid);
    return `${pid} (${row?.exe ?? row?.commandLine?.slice(0, 80) ?? "?"})`;
  });
  opts.log?.(`ended ${victims.length} process(es) in ${dir}: ${names.join(", ")}`);
  return victims;
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

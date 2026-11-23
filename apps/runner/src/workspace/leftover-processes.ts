import type { RunnerCommandOf, RunnerCommandResult } from "@codeden/contracts";
import { CommandError } from "../errors";
import { cutOffByStop } from "../process/cut-off";
import type { ProcessRow } from "../process/inside";
import type { ProcessSupervisor } from "../process/supervisor";
import { processTable } from "../process/table";
import {
  type EndProcessesOptions,
  endProcessesInside,
  processesStillInside,
  runnerDescendants,
} from "../process/worktree-processes";
import type { TerminalHost } from "../pty/terminal-host";
import { isInside } from "../util/paths";
import { assertRemovable, removeWorkspace } from "./removal";
import { isManagedWorktreePath } from "./trash";

export interface LeftoverContext {
  home: string;
  supervisor: Pick<ProcessSupervisor, "list">;
  /** Working directories of the hosted sessions, by session id. */
  cwds: () => Map<string, string>;
  log?: (message: string) => void;
  /** Reads the process table and ends process trees (tests). */
  processes?: Pick<EndProcessesOptions, "table" | "kill">;
}

/**
 * A session stopping on Windows, from just before it stops until the process table has been read
 * again. Every stop opens one; `overlapped` is set when another stop was open at any time
 * meanwhile, since what that one's agent left would also be cut off from the runner's tree.
 */
interface StopSpan {
  overlapped: boolean;
}

const openStops = new Set<StopSpan>();

function openStop(): StopSpan {
  const span = { overlapped: openStops.size > 0 };
  for (const other of openStops) other.overlapped = true;
  openStops.add(span);
  return span;
}

/**
 * Stop a session, then end what its agent left running in its worktree (a dev server started
 * through the agent's shell outlives the agent). Only for a session in its own CodeDen worktree
 * (`<home>/wt/<project>/<session>`), never the repository root or a folder another hosted
 * session works in. The user's terminals there keep running.
 *
 * Windows doesn't report working directories, so there what the stop cuts off from the
 * runner's process tree counts as running in the worktree (`cutOffByStop`), unless another stop
 * overlapped this one: then only executables and command lines tell.
 */
export async function stopWithLeftovers(
  ctx: LeftoverContext,
  sessionId: string,
  stop: () => Promise<void>,
): Promise<void> {
  const cwds = ctx.cwds();
  const cwd = cwds.get(sessionId);
  const own =
    cwd !== undefined &&
    isManagedWorktreePath(ctx.home, cwd) &&
    ![...cwds].some(
      ([id, other]) => id !== sessionId && (isInside(cwd, other) || isInside(other, cwd)),
    );
  const windows = process.platform === "win32";
  const table = ctx.processes?.table ?? processTable;
  // Every stop on Windows opens a span, also one that ends nothing, so overlaps are known.
  const span = windows ? openStop() : undefined;
  try {
    // Where an orphan is adopted by another process (Linux, macOS), remember what the agent
    // started while it still runs. On Windows an orphan keeps its parent's pid: the table from
    // before the stop shows which branches the stop cuts off from the runner.
    const seen = own && !windows ? await runnerDescendants(table) : undefined;
    const tracked = new Set(ctx.supervisor.list().map((p) => p.pid));
    const before = own && span ? await table().catch(() => undefined) : undefined;
    await stop();
    if (!own || cwd === undefined) return;
    const cutOff = (after: readonly ProcessRow[]): ReadonlySet<number> => {
      // The table has been read again: a stop from now on can't cut off anything it shows.
      if (span) openStops.delete(span);
      if (!before || !span || span.overlapped) return new Set();
      return cutOffByStop({ before, after, runnerPid: process.pid, tracked });
    };
    await endProcessesInside(cwd, {
      home: ctx.home,
      seen,
      spare: ctx.supervisor.list().map((p) => p.pid),
      log: ctx.log,
      ...ctx.processes,
      ...(before ? { inside: cutOff } : {}),
    });
  } finally {
    if (span) openStops.delete(span);
  }
}

export interface RemoveContext {
  home: string;
  supervisor: Pick<ProcessSupervisor, "killUnder">;
  terminals: Pick<TerminalHost, "closeUnder">;
  log?: (message: string) => void;
  /** Reads the process table and ends process trees (tests). */
  processes?: Pick<EndProcessesOptions, "table" | "kill">;
}

/**
 * `workspace.remove` as the runner runs it. Refuses first, so a kept worktree's terminals and
 * processes keep running. Then closes its terminals and ends what agents left running in it (on
 * Windows, where that keeps the folder from being moved, also what an agent started before the
 * runner restarted: `removing`), and deletes it.
 * When something still holds the folder, the error names what runs there.
 */
export async function removeWithLeftovers(
  cmd: RunnerCommandOf<"workspace.remove">,
  ctx: RemoveContext,
): Promise<RunnerCommandResult<"workspace.remove">> {
  const info = await assertRemovable(cmd, ctx.home);
  await ctx.terminals.closeUnder(cmd.path);
  await ctx.supervisor.killUnder(cmd.path);
  if (info.state !== "missing") {
    const removing = { home: ctx.home, log: ctx.log, removing: true, ...ctx.processes };
    await endProcessesInside(cmd.path, removing);
  }
  try {
    return await removeWorkspace(cmd, ctx.home, ctx.log);
  } catch (error) {
    if (!(error instanceof CommandError) || error.code !== "worktree_in_use") throw error;
    const holders = await processesStillInside(cmd.path, ctx.processes?.table);
    if (holders.length === 0) throw error;
    const named = holders.slice(0, 5).join(", ") + (holders.length > 5 ? ", ..." : "");
    throw new CommandError(error.code, `${error.message} Still running there: ${named}.`);
  }
}

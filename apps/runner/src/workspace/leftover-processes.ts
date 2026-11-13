import type { RunnerCommandOf, RunnerCommandResult } from "@codeden/contracts";
import { CommandError } from "../errors";
import type { ProcessSupervisor } from "../process/supervisor";
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
  supervisor: ProcessSupervisor;
  /** Working directories of the hosted sessions, by session id. */
  cwds: () => Map<string, string>;
  log?: (message: string) => void;
}

/**
 * Stop a session, then end what its agent left running in its worktree (a dev server started
 * through the agent's shell outlives the agent). Only for a session in its own CodeDen worktree
 * (`<home>/wt/<project>/<session>`), never the repository root or a folder another hosted
 * session works in. The user's terminals there keep running.
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
  // Where an orphan is adopted by another process (Linux, macOS), remember what the agent
  // started while it still runs; on Windows its orphans are recognised afterwards.
  const seen = own && process.platform !== "win32" ? await runnerDescendants() : undefined;
  await stop();
  if (!own || cwd === undefined) return;
  await endProcessesInside(cwd, {
    home: ctx.home,
    seen,
    spare: ctx.supervisor.list().map((p) => p.pid),
    log: ctx.log,
  });
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

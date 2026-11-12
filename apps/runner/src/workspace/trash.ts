import { mkdir, readdir, rename } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { CommandError } from "../errors";
import { type EndProcessesOptions, endProcessesInside } from "../process/worktree-processes";
import { deleteFailed, deleteTree, errorCode, retry } from "./delete-tree";

/**
 * True for a session folder CodeDen created and owns: exactly `<home>/wt/<project>/<session>`.
 * Only these may be deleted once they are no longer git worktrees.
 */
export function isManagedWorktreePath(home: string, path: string): boolean {
  const rel = relative(resolve(home, "wt"), resolve(path));
  if (!rel || isAbsolute(rel)) return false;
  const parts = rel.split(/[\\/]+/);
  return (
    parts.length === 2 && !parts.includes("..") && !parts.includes(".") && parts[0] !== ".trash"
  );
}

/** Where removed worktrees wait to be deleted. `.trash` can never be a project slug. */
export function trashDir(home: string): string {
  return join(resolve(home), "wt", ".trash");
}

/** The earliest time a trash entry's stamp may name (older ones are not CodeDen's). */
const EARLIEST_STAMP = Date.UTC(2025, 0, 1);

/**
 * Where a trash entry came from and when it was moved there. Its name is
 * `<project>-<session>-<stamp>` (`moveToTrash`): the session folder is letters and digits
 * (`sessionShort`, never a dash) and the stamp starts with the time of the move in 8 base-36
 * digits. Null for a name that doesn't read that way or names a folder CodeDen doesn't own.
 */
export function trashOrigin(
  home: string,
  name: string,
): { path: string; trashedAt: number } | null {
  const match = /^(.+)-([a-z0-9]{4,8})-([a-z0-9]{8,})$/.exec(name);
  if (!match) return null;
  const [, project = "", session = "", stamp = ""] = match;
  const trashedAt = Number.parseInt(stamp.slice(0, 8), 36);
  if (!(trashedAt >= EARLIEST_STAMP && trashedAt <= Date.now() + 24 * 60 * 60_000)) return null;
  const path = join(resolve(home), "wt", project, session);
  return isManagedWorktreePath(home, path) ? { path, trashedAt } : null;
}

/**
 * Move a session folder into the trash. A rename is all or nothing: while anything in the
 * folder is held open (a process's working directory, an open file), Windows refuses it and
 * the folder stays exactly as it was (`worktree_in_use`). Returns null when the trash is on
 * another volume.
 */
async function moveToTrash(home: string, path: string): Promise<string | null> {
  const trash = trashDir(home);
  await mkdir(trash, { recursive: true });
  const random = Math.random().toString(36).slice(2, 6).padEnd(4, "0");
  const stamp = `${Date.now().toString(36)}${random}`;
  const dest = join(trash, `${basename(dirname(path))}-${basename(path)}-${stamp}`);
  try {
    // Processes just stopped in the folder can take a moment to let go of it.
    await retry(() => rename(path, dest), 8);
    return dest;
  } catch (error) {
    if (errorCode(error) === "EXDEV") return null;
    throw deleteFailed(path, error);
  }
}

export interface TrashOptions {
  log?: (message: string) => void;
  /** Reads the process table and ends process trees (tests). */
  processes?: Pick<EndProcessesOptions, "table" | "kill">;
  /** Deletes a trashed folder (tests; default `deleteTree`). */
  remove?: (path: string) => Promise<void>;
}

/**
 * Delete one trashed folder. When something still holds it, end what was left running in the
 * worktree it came from, then try once more: on Windows an executable started from a worktree
 * keeps it from being deleted even after the folder was moved, and the process's paths
 * (executable, working directory, command line) still name the old location. Only processes
 * that started before the move count, so nothing in a worktree recreated at that path since is
 * touched, and the removal rules apply: never CodeDen, nor a person's editor, terminal or file
 * manager, nor anything with one of those running under it.
 */
async function deleteTrashed(home: string, name: string, opts: TrashOptions): Promise<void> {
  const path = join(trashDir(home), name);
  const remove = opts.remove ?? deleteTree;
  try {
    return await remove(path);
  } catch (error) {
    const inUse = error instanceof CommandError && error.code === "worktree_in_use";
    const origin = inUse ? trashOrigin(home, name) : null;
    if (!origin) throw error;
    const ended = await endProcessesInside([origin.path, path], {
      home,
      removing: true,
      startedBefore: origin.trashedAt,
      log: opts.log,
      ...opts.processes,
    });
    if (ended.length === 0) throw error;
  }
  await remove(path);
}

const runs = new Map<string, { again: boolean; done: Promise<void> }>();

/**
 * Delete everything in the trash, one folder at a time, never following a link (the links in
 * a trashed pnpm install still point at the old path, where a new worktree may live by now).
 * Runs in the background after each removal and when the runner starts; a folder something
 * still holds open has what was left running in it ended (`deleteTrashed`), or stays for the
 * next run. Calls during a run share it and add one more pass.
 */
export function emptyTrash(home: string, opts: TrashOptions = {}): Promise<void> {
  const trash = trashDir(home);
  const current = runs.get(trash);
  if (current) {
    current.again = true;
    return current.done;
  }
  const run = { again: true, done: Promise.resolve() };
  run.done = (async () => {
    try {
      while (run.again) {
        run.again = false;
        const entries = await readdir(trash).catch(() => [] as string[]);
        for (const name of entries) {
          await deleteTrashed(home, name, opts).catch((error: unknown) =>
            opts.log?.(`worktree trash: ${error instanceof Error ? error.message : String(error)}`),
          );
        }
      }
    } finally {
      runs.delete(trash);
    }
  })();
  runs.set(trash, run);
  return run.done;
}

/**
 * Delete a worktree folder that has been cleared for removal. A session folder under
 * `<home>/wt` goes to the trash, so the removal is instant and the path is free right away,
 * and is deleted in the background. Anything else is deleted in place.
 */
export async function discardFolder(
  home: string,
  path: string,
  log?: (message: string) => void,
): Promise<void> {
  const trashed = isManagedWorktreePath(home, path) ? await moveToTrash(home, path) : null;
  if (trashed) void emptyTrash(home, { log });
  else await deleteTree(path);
}

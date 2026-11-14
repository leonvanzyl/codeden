import type { Session, SessionFileEntry } from "@codeden/contracts";
import { type DiskStat, WorkspaceFsError } from "@codeden/providers";
import { ServiceError, type ServiceStatus } from "../errors";
import { isRemoteRunner, type RunnerDeps, runnerForSession } from "../runner-port";
import { sessionWorkdir } from "../sessions/workdir";
import { LocalWorkspaceFs } from "./local";
import { RunnerWorkspaceFs } from "./runner";

/**
 * A session's files, wherever they are (`docs/remote-runners.md` §10): on the server's own disk
 * for the home runner, or on another runner's disk through `fs.*` and `transfer.*`. Both
 * implementations run the same guards (`DiskWorkspace` in `@codeden/providers`): paths outside
 * the root, CodeDen's own credential files and their `.invalid-*` copies (never read), agents'
 * allow-list files and `.git` (never written). Failures are `WorkspaceFsError`s with the same
 * codes on both.
 */
export interface WorkspaceFs {
  /** The workspace root (the session's working folder), as its own machine names it. */
  readonly root: string;
  /** True when the files are on another runner's disk, never read with `node:fs`. */
  readonly remote: boolean;
  /** The file tree for the files panel (rules of `DiskWorkspace.list`). */
  list(maxEntries?: number): Promise<{ entries: SessionFileEntry[]; truncated: boolean }>;
  /** What `path` is, by its real path. */
  stat(path: string): Promise<DiskStat>;
  /** Up to `length` bytes (at most 4 MiB) of a file from `offset`. */
  read(
    path: string,
    offset?: number,
    length?: number,
  ): Promise<{ bytes: Buffer; sizeBytes: number; eof: boolean }>;
  /**
   * A whole file of at most `maxBytes` (`too_large` beyond), with its real path relative to the
   * root (for the secret-name checks).
   */
  readFile(path: string, maxBytes: number): Promise<{ bytes: Buffer; realPath: string }>;
  /** Write a whole file, renamed into place; `createDirs` makes missing folders. */
  writeFile(path: string, bytes: Buffer, opts?: { createDirs?: boolean }): Promise<void>;
  /** The absolute path of `relative` on the workspace's own machine (for messages). */
  pathOf(relative: string): string;
}

export interface WorkspaceFsDeps extends RunnerDeps {
  /** CodeDen's data folder on the server, whose credential files are never read. */
  home: string;
}

/**
 * The files of a session's working folder: on the server's disk only for the home runner. Any
 * other runner, whatever it reports about itself, is read through the link, so an untrusted
 * runner can't point the server at its own disk (§8).
 */
export function workspaceFsFor(deps: WorkspaceFsDeps, session: Session): WorkspaceFs {
  const runner = runnerForSession(deps, session.id);
  const root = sessionWorkdir(session);
  return isRemoteRunner(runner)
    ? new RunnerWorkspaceFs(runner, root)
    : new LocalWorkspaceFs(root, deps.home);
}

const STATUS: Record<WorkspaceFsError["code"], ServiceStatus> = {
  path_outside_root: 403,
  root_invalid: 403,
  credential_file: 403,
  agent_permission_file: 403,
  protected_path: 403,
  cwd_missing: 404,
  not_found: 404,
  not_a_file: 400,
  too_large: 413,
  transfer_not_found: 409,
};

/**
 * A workspace failure as an HTTP error; `rename` swaps codes and messages where a route keeps
 * its own (the files panel's `folder_not_found`). Other errors are returned as they are.
 */
export function workspaceHttpError(
  error: unknown,
  rename: Partial<Record<WorkspaceFsError["code"], { code: string; message: string }>> = {},
): unknown {
  if (!(error instanceof WorkspaceFsError)) return error;
  const renamed = rename[error.code];
  return new ServiceError(
    STATUS[error.code],
    renamed?.code ?? error.code,
    renamed?.message ?? error.message,
  );
}

/**
 * The session's files when they are on another runner's disk; undefined for the home runner,
 * whose callers keep reading the server's disk (with its extra folders: temp, artifacts).
 */
export function remoteWorkspaceFs(deps: RunnerDeps, session: Session): WorkspaceFs | undefined {
  const runner = runnerForSession(deps, session.id);
  return isRemoteRunner(runner)
    ? new RunnerWorkspaceFs(runner, sessionWorkdir(session))
    : undefined;
}

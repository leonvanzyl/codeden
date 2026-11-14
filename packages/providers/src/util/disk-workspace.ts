import { randomBytes } from "node:crypto";
import {
  closeSync,
  type Dirent,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import { FS_CHUNK_MAX_BYTES, FS_LIST_MAX_ENTRIES, type SessionFileEntry } from "@codeden/contracts";
import {
  assertWorkspaceReadable,
  assertWorkspaceWritable,
  WorkspaceFsError,
  workspaceRelative,
  workspaceRoot,
  workspaceTarget,
} from "./workspace-guard";

/** Skipped wherever they appear (a worktree has a `.git` file, not a folder). */
const SKIP = new Set([".git", "node_modules"]);

/** `fs.stat` of a workspace path. */
export type DiskStat =
  | { exists: false }
  | {
      exists: true;
      kind: "file" | "dir" | "other";
      sizeBytes: number;
      mtimeMs: number;
      realPath: string;
    };

/**
 * A workspace folder on this machine's disk, behind the shared guards (`./workspace-guard`).
 * The runner answers `fs.*` and `transfer.*` with it, and the server reads a home-runner
 * session's folder with it, so both sides list, read and refuse alike. `home` is CodeDen's data
 * folder on this machine, whose credential files are never read or written.
 */
export class DiskWorkspace {
  readonly realRoot: string;

  constructor(
    readonly root: string,
    private readonly home: string,
  ) {
    this.realRoot = workspaceRoot(root, home);
  }

  /**
   * Files under `start` (default: the root), depth-first, folders first, `.git` and
   * `node_modules` skipped, symlinks listed but not followed, at most `max` entries. Paths are
   * relative to the root, `/`-separated.
   */
  list(
    start?: string,
    max = FS_LIST_MAX_ENTRIES,
  ): { entries: SessionFileEntry[]; truncated: boolean } {
    const from = start ? workspaceTarget(this.root, this.realRoot, start).target : this.root;
    const prefix = start ? workspaceRelative(this.root, from) : "";
    const entries: SessionFileEntry[] = [];
    let truncated = false;
    const walk = (dir: string, prefix: string) => {
      let dirents: Dirent[];
      try {
        dirents = readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      dirents.sort((a, b) =>
        a.isDirectory() === b.isDirectory()
          ? a.name.localeCompare(b.name)
          : a.isDirectory()
            ? -1
            : 1,
      );
      for (const d of dirents) {
        if (entries.length >= max) {
          truncated = true;
          return;
        }
        if (SKIP.has(d.name)) continue;
        const path = prefix ? `${prefix}/${d.name}` : d.name;
        if (d.isDirectory()) {
          entries.push({ path, kind: "dir" });
          walk(join(dir, d.name), path);
        } else {
          let sizeBytes: number | undefined;
          try {
            sizeBytes = statSync(join(dir, d.name)).size;
          } catch {
            sizeBytes = undefined;
          }
          entries.push({ path, kind: "file", ...(sizeBytes === undefined ? {} : { sizeBytes }) });
        }
      }
    };
    walk(from, prefix);
    return { entries, truncated };
  }

  /** What `path` is, by its real path; `exists: false` when it doesn't exist. */
  stat(path: string): DiskStat {
    const { real } = workspaceTarget(this.root, this.realRoot, path);
    if (!existsSync(real)) return { exists: false };
    const info = statSync(real);
    return {
      exists: true,
      kind: info.isFile() ? "file" : info.isDirectory() ? "dir" : "other",
      sizeBytes: info.size,
      mtimeMs: info.mtimeMs,
      realPath: workspaceRelative(this.realRoot, real),
    };
  }

  /** An existing, readable file: its real path and size. */
  readable(path: string): { real: string; sizeBytes: number } {
    const { real } = workspaceTarget(this.root, this.realRoot, path);
    assertWorkspaceReadable(real, this.home);
    if (!existsSync(real)) throw new WorkspaceFsError("not_found", "No such file");
    const info = statSync(real);
    if (!info.isFile()) throw new WorkspaceFsError("not_a_file", "Not a file");
    return { real, sizeBytes: info.size };
  }

  /** Up to `length` bytes of a file from `offset`. */
  read(
    path: string,
    offset = 0,
    length = FS_CHUNK_MAX_BYTES,
  ): { bytes: Buffer; sizeBytes: number; eof: boolean } {
    const { real, sizeBytes } = this.readable(path);
    const count = Math.max(0, Math.min(length, FS_CHUNK_MAX_BYTES, sizeBytes - offset));
    const bytes = Buffer.alloc(count);
    if (count > 0) {
      const fd = openSync(real, "r");
      try {
        readSync(fd, bytes, 0, count, offset);
      } finally {
        closeSync(fd);
      }
    }
    return { bytes, sizeBytes, eof: offset + count >= sizeBytes };
  }

  /** A path that may be written (made folders when `createDirs`): its lexical target. */
  writable(path: string, createDirs = false): string {
    const { target, real } = workspaceTarget(this.root, this.realRoot, path);
    assertWorkspaceWritable(this.realRoot, real, this.home);
    if (existsSync(real) && !statSync(real).isFile()) {
      throw new WorkspaceFsError("not_a_file", "Not a file");
    }
    const parent = dirname(target);
    if (!existsSync(parent)) {
      if (!createDirs) throw new WorkspaceFsError("not_found", "The folder doesn't exist");
      mkdirSync(parent, { recursive: true });
      // A folder made through a link must still be inside the root.
      workspaceTarget(this.root, this.realRoot, path);
    }
    return target;
  }

  /** Write a whole file through a temp file renamed into place. */
  write(path: string, bytes: Buffer, createDirs = false): { sizeBytes: number } {
    const target = this.writable(path, createDirs);
    const temp = tempPathFor(target);
    try {
      writeFileSync(temp, bytes);
      renameSync(temp, target);
    } catch (error) {
      rmSync(temp, { force: true });
      throw error;
    }
    return { sizeBytes: bytes.length };
  }
}

/** A temp file next to `target`, for a write renamed into place. */
export function tempPathFor(target: string): string {
  return join(dirname(target), `.${basename(target)}.codeden-${randomBytes(4).toString("hex")}`);
}

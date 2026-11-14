import { z } from "zod";
import { SessionFileEntry } from "../session-files";

/**
 * Workspace file access over the runner link (`docs/remote-runners.md` §10). A runner in a
 * sandbox keeps the session's files on its own disk, so the server reads and writes them through
 * these commands instead of `node:fs`. Every command names the workspace `root` (the session's
 * cwd as the runner reported it) and a `path` relative to it; the runner resolves the real path
 * (symlinks, junctions) and refuses anything outside the root.
 */

/** Most bytes one `fs.read` returns or one `fs.write` carries, before base64 (4 MiB). */
export const FS_CHUNK_MAX_BYTES = 4 * 1024 * 1024;

/** Bytes per `transfer.read` chunk (1 MiB), so one frame on the link stays small. */
export const TRANSFER_CHUNK_BYTES = 1024 * 1024;

/** Most bytes one `transfer.*` write may total (100 MiB). */
export const TRANSFER_MAX_BYTES = 100 * 1024 * 1024;

/** Most entries one `fs.list` returns; the rest are cut off with `truncated`. */
export const FS_LIST_MAX_ENTRIES = 5000;

/**
 * Error codes of workspace file access, the same from the runner (`fs.*`, `transfer.*`) and
 * from the server's own disk, so callers handle both alike:
 * - `path_outside_root`: the path is absolute, escapes with `..`, has a NUL byte, or resolves
 *   (through a link) outside the root;
 * - `root_invalid`: the root isn't an absolute folder, or holds the runner's own state
 *   (`<home>/runner`: its lock file token and journal);
 * - `cwd_missing`: the root doesn't exist (any runner command whose `cwd` is gone fails so);
 * - `not_found`, `not_a_file`;
 * - `credential_file`: one of CodeDen's own credential files, or the `.invalid-<time>` copy kept
 *   of a damaged one, which are never read;
 * - `agent_permission_file`: an agent's own allow-list (`.cursor/cli.json`,
 *   `.gemini/settings.json`, ...), which is never written (§11.2);
 * - `protected_path`: inside `.git`, which is never written;
 * - `too_large`: more than a command or transfer may carry;
 * - `transfer_not_found`: an unknown, closed or expired transfer.
 */
export const WorkspaceFsErrorCode = z.enum([
  "path_outside_root",
  "root_invalid",
  "cwd_missing",
  "not_found",
  "not_a_file",
  "credential_file",
  "agent_permission_file",
  "protected_path",
  "too_large",
  "transfer_not_found",
]);
export type WorkspaceFsErrorCode = z.infer<typeof WorkspaceFsErrorCode>;

/** An absolute workspace root on the runner's machine, in its own path syntax. */
export const WorkspaceRoot = z.string().min(1).max(4096);

/** A path inside a workspace root: relative, with `/` (or the runner's own) separators. */
export const WorkspacePath = z.string().min(1).max(4096);

/** Base64 of at most `maxBytes` bytes. */
const base64Of = (maxBytes: number) => z.base64().max(Math.ceil(maxBytes / 3) * 4);

/** Base64 of one `fs.read`/`fs.write` chunk. */
export const FsChunkData = base64Of(FS_CHUNK_MAX_BYTES);

/** Id of an open transfer, unique per runner. */
export const TransferId = z.string().min(1).max(100);

/** `fs.*` and `transfer.*` commands, spread into `RunnerCommand`. */
export const WorkspaceFsCommands = [
  /**
   * The files under `path` (default: the root), depth-first, folders first, `.git` and
   * `node_modules` skipped, symlinks listed but not followed, at most `maxEntries` (default and
   * cap `FS_LIST_MAX_ENTRIES`).
   */
  z.object({
    name: z.literal("fs.list"),
    root: WorkspaceRoot,
    path: WorkspacePath.optional(),
    maxEntries: z.int().min(1).max(FS_LIST_MAX_ENTRIES).optional(),
  }),
  /** What `path` is, by its real path. A missing path is `exists: false`, not an error. */
  z.object({ name: z.literal("fs.stat"), root: WorkspaceRoot, path: WorkspacePath }),
  /** Up to `length` bytes (default and cap `FS_CHUNK_MAX_BYTES`) of a file from `offset`. */
  z.object({
    name: z.literal("fs.read"),
    root: WorkspaceRoot,
    path: WorkspacePath,
    offset: z.int().nonnegative().optional(),
    length: z.int().min(1).max(FS_CHUNK_MAX_BYTES).optional(),
  }),
  /**
   * Write a whole file (at most `FS_CHUNK_MAX_BYTES`): into a temp file next to it, then renamed
   * into place, so a reader never sees half of it. `createDirs` makes missing folders.
   */
  z.object({
    name: z.literal("fs.write"),
    root: WorkspaceRoot,
    path: WorkspacePath,
    data: FsChunkData,
    createDirs: z.boolean().optional(),
  }),
  /**
   * Start a chunked transfer of one file, for files larger than one `fs.read`/`fs.write`. A
   * read pins the file's size at open; a write goes to a temp file renamed into place on
   * `transfer.close` with `commit`. The server pulls (or pushes) one chunk per request, so the
   * link never carries more than one chunk of a transfer at a time. A transfer idle for 60 s is
   * closed (and an uncommitted write discarded).
   */
  z.object({
    name: z.literal("transfer.open"),
    root: WorkspaceRoot,
    path: WorkspacePath,
    mode: z.enum(["read", "write"]),
    /** A write: make missing folders. */
    createDirs: z.boolean().optional(),
  }),
  /** The next chunk (at most `TRANSFER_CHUNK_BYTES`) of a read transfer. */
  z.object({ name: z.literal("transfer.read"), transferId: TransferId }),
  /** Append a chunk (at most `TRANSFER_CHUNK_BYTES`) to a write transfer. */
  z.object({
    name: z.literal("transfer.write"),
    transferId: TransferId,
    data: base64Of(TRANSFER_CHUNK_BYTES),
  }),
  /** End a transfer. A write lands only with `commit`; otherwise its temp file is deleted. */
  z.object({
    name: z.literal("transfer.close"),
    transferId: TransferId,
    commit: z.boolean().optional(),
  }),
] as const;

/** `fs.stat` of an existing path. */
export const FsStatFound = z.object({
  exists: z.literal(true),
  kind: z.enum(["file", "dir", "other"]),
  sizeBytes: z.int().nonnegative(),
  mtimeMs: z.number().nonnegative(),
  /** The real path (links resolved), relative to the root's real path, `/`-separated. */
  realPath: z.string(),
});

/** Result schemas of the `fs.*` and `transfer.*` commands, spread into `RunnerCommandResults`. */
export const WorkspaceFsCommandResults = {
  "fs.list": z.object({ entries: z.array(SessionFileEntry), truncated: z.boolean() }),
  "fs.stat": z.discriminatedUnion("exists", [z.object({ exists: z.literal(false) }), FsStatFound]),
  "fs.read": z.object({
    data: FsChunkData,
    /** The whole file's size. */
    sizeBytes: z.int().nonnegative(),
    /** True when this chunk reaches the end of the file. */
    eof: z.boolean(),
  }),
  "fs.write": z.object({ sizeBytes: z.int().nonnegative() }),
  "transfer.open": z.object({
    transferId: TransferId,
    /** A read's file size, pinned at open; 0 for a write. */
    sizeBytes: z.int().nonnegative(),
  }),
  "transfer.read": z.object({ data: base64Of(TRANSFER_CHUNK_BYTES), eof: z.boolean() }),
  "transfer.write": z.object({ sizeBytes: z.int().nonnegative() }),
  "transfer.close": z.object({ committed: z.boolean() }),
};

/**
 * A git credential the server brokers for one git operation (`docs/remote-runners.md` §9.2,
 * option A): a sandbox runner gets it with the command that needs it (`workspace.prepare` with
 * `clone` or `fetch`, `git.push`) and hands it to that one git process. It is never stored
 * (no credential helper, no `.git/config`, no remote URL), logged, journaled or put in an event.
 */
export const GitCredential = z.object({
  username: z.string().min(1).max(200),
  password: z.string().min(1).max(4096),
});
export type GitCredential = z.infer<typeof GitCredential>;

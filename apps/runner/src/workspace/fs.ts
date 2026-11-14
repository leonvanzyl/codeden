import { randomUUID } from "node:crypto";
import { closeSync, fstatSync, openSync, readSync, renameSync, rmSync, writeSync } from "node:fs";
import {
  type RunnerCommand,
  type RunnerCommandOf,
  type RunnerCommandResult,
  TRANSFER_CHUNK_BYTES,
  TRANSFER_MAX_BYTES,
  WORKSPACE_FS_MAX_FRAME_BYTES,
} from "@codeden/contracts";
import { DiskWorkspace, tempPathFor, WorkspaceFsError } from "@codeden/providers";
import { CommandError } from "../errors";

/** A transfer idle this long is closed (an uncommitted write discarded). */
export const TRANSFER_IDLE_MS = 60_000;
/** Most transfers open at once; opening another closes the one idle longest. */
const MAX_TRANSFERS = 16;
/**
 * Room kept in a frame for what wraps a listing's entries: the result message with the longest
 * request id, `truncated` and the brackets (about 150 bytes).
 */
const FRAME_ENVELOPE_BYTES = 512;

type FsCommand = Extract<RunnerCommand, { name: `fs.${string}` | `transfer.${string}` }>;

interface ReadTransfer {
  mode: "read";
  fd: number;
  sizeBytes: number;
  offset: number;
}
interface WriteTransfer {
  mode: "write";
  fd: number;
  workspace: DiskWorkspace;
  path: string;
  temp: string;
  written: number;
}
type Transfer = (ReadTransfer | WriteTransfer) & { timer: NodeJS.Timeout; usedAt: number };

/**
 * `fs.*` and `transfer.*` (`docs/remote-runners.md` §10): workspace files on this runner's disk
 * for a server that doesn't share it. Each command opens the workspace root through the shared
 * guards (`DiskWorkspace`), so paths outside it, CodeDen's credential files in this runner's
 * home, agents' allow-lists and `.git` are refused exactly as on the server's own disk.
 */
export class WorkspaceFsHost {
  private readonly transfers = new Map<string, Transfer>();

  constructor(
    private readonly home: string,
    private readonly idleMs = TRANSFER_IDLE_MS,
    private readonly maxFrameBytes = WORKSPACE_FS_MAX_FRAME_BYTES,
  ) {}

  /** Run one command; guard refusals become `CommandError`s with the same code. */
  execute<C extends FsCommand>(command: C): RunnerCommandResult<C["name"]> {
    try {
      return this.run(command) as RunnerCommandResult<C["name"]>;
    } catch (error) {
      if (error instanceof WorkspaceFsError) throw new CommandError(error.code, error.message);
      if (error instanceof CommandError) throw error;
      throw new CommandError("fs_failed", error instanceof Error ? error.message : String(error));
    }
  }

  /** Close every transfer (runner shutdown). */
  closeAll(): void {
    for (const id of [...this.transfers.keys()]) this.drop(id, false);
  }

  private workspace(root: string): DiskWorkspace {
    return new DiskWorkspace(root, this.home);
  }

  private run(command: FsCommand): RunnerCommandResult<FsCommand["name"]> {
    switch (command.name) {
      case "fs.list":
        return this.fitFrame(this.workspace(command.root).list(command.path, command.maxEntries));
      case "fs.stat":
        return this.workspace(command.root).stat(command.path);
      case "fs.read": {
        const ws = this.workspace(command.root);
        const read = ws.read(command.path, command.offset ?? 0, command.length);
        return { data: read.bytes.toString("base64"), sizeBytes: read.sizeBytes, eof: read.eof };
      }
      case "fs.write": {
        const bytes = Buffer.from(command.data, "base64");
        return this.workspace(command.root).write(command.path, bytes, command.createDirs);
      }
      case "transfer.open":
        return this.open(command);
      case "transfer.read":
        return this.readChunk(command.transferId);
      case "transfer.write":
        return this.writeChunk(command.transferId, Buffer.from(command.data, "base64"));
      case "transfer.close":
        return { committed: this.drop(command.transferId, command.commit === true) };
    }
  }

  /**
   * A listing cut off (`truncated`) where its result message would pass the frame size: 5,000
   * long paths can, while every other result is held within it by its chunk cap.
   */
  private fitFrame(list: RunnerCommandResult<"fs.list">): RunnerCommandResult<"fs.list"> {
    let bytes = FRAME_ENVELOPE_BYTES;
    for (const [i, entry] of list.entries.entries()) {
      bytes += Buffer.byteLength(JSON.stringify(entry)) + 1;
      if (bytes > this.maxFrameBytes) return { entries: list.entries.slice(0, i), truncated: true };
    }
    return list;
  }

  private open(cmd: RunnerCommandOf<"transfer.open">): RunnerCommandResult<"transfer.open"> {
    const ws = this.workspace(cmd.root);
    this.makeRoom();
    const transferId = randomUUID();
    if (cmd.mode === "read") {
      const { real } = ws.readable(cmd.path);
      const fd = openSync(real, "r");
      // The size is pinned at open: the file may grow while it is read.
      const sizeBytes = fstatSync(fd).size;
      this.track(transferId, { mode: "read", fd, sizeBytes, offset: 0 });
      return { transferId, sizeBytes };
    }
    const temp = tempPathFor(ws.writable(cmd.path, cmd.createDirs));
    const fd = openSync(temp, "wx");
    this.track(transferId, { mode: "write", fd, workspace: ws, path: cmd.path, temp, written: 0 });
    return { transferId, sizeBytes: 0 };
  }

  private readChunk(id: string): RunnerCommandResult<"transfer.read"> {
    const t = this.get(id, "read") as ReadTransfer;
    const count = Math.max(0, Math.min(TRANSFER_CHUNK_BYTES, t.sizeBytes - t.offset));
    const bytes = Buffer.alloc(count);
    const got = count > 0 ? readSync(t.fd, bytes, 0, count, t.offset) : 0;
    t.offset += got;
    // A file truncated while it is read ends early rather than looping on empty chunks.
    const eof = t.offset >= t.sizeBytes || got < count;
    return { data: bytes.subarray(0, got).toString("base64"), eof };
  }

  private writeChunk(id: string, bytes: Buffer): RunnerCommandResult<"transfer.write"> {
    const t = this.get(id, "write") as WriteTransfer;
    if (t.written + bytes.length > TRANSFER_MAX_BYTES) {
      this.drop(id, false);
      throw new WorkspaceFsError("too_large", "The file is larger than a transfer may carry");
    }
    writeSync(t.fd, bytes);
    t.written += bytes.length;
    return { sizeBytes: t.written };
  }

  private get(id: string, mode: "read" | "write"): Transfer {
    const t = this.transfers.get(id);
    if (!t || t.mode !== mode) {
      throw new WorkspaceFsError("transfer_not_found", "No such transfer (closed or expired)");
    }
    t.usedAt = Date.now();
    t.timer.refresh();
    return t;
  }

  private track(id: string, t: ReadTransfer | WriteTransfer): void {
    const timer = setTimeout(() => this.drop(id, false), this.idleMs);
    timer.unref();
    this.transfers.set(id, { ...t, timer, usedAt: Date.now() });
  }

  private makeRoom(): void {
    if (this.transfers.size < MAX_TRANSFERS) return;
    const oldest = [...this.transfers.entries()].sort((a, b) => a[1].usedAt - b[1].usedAt)[0];
    if (oldest) this.drop(oldest[0], false);
  }

  /** End a transfer; a write is renamed into place when `commit`. Returns whether it landed. */
  private drop(id: string, commit: boolean): boolean {
    const t = this.transfers.get(id);
    if (!t) {
      if (commit) throw new WorkspaceFsError("transfer_not_found", "No such transfer");
      return false;
    }
    this.transfers.delete(id);
    clearTimeout(t.timer);
    closeSync(t.fd);
    if (t.mode === "read") return false;
    if (!commit) {
      rmSync(t.temp, { force: true });
      return false;
    }
    try {
      // Checked again: the folder may have changed (a link swapped in) since the open.
      renameSync(t.temp, t.workspace.writable(t.path));
      return true;
    } catch (error) {
      rmSync(t.temp, { force: true });
      throw error;
    }
  }
}

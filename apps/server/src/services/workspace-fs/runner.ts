import {
  FS_CHUNK_MAX_BYTES,
  type RunnerCommandName,
  type RunnerCommandOf,
  type RunnerCommandResult,
  TRANSFER_CHUNK_BYTES,
  WorkspaceFsErrorCode,
} from "@codeden/contracts";
import { type DiskStat, lexicalTarget, platformPath, WorkspaceFsError } from "@codeden/providers";
import { type RunnerPort, runnerErrorCode } from "../runner-port";
import type { WorkspaceFs } from "./workspace-fs";

/** How long one `fs.*`/`transfer.*` command may take. */
const FS_TIMEOUT_MS = 30_000;

/**
 * A session's folder on another runner's disk (`docs/remote-runners.md` §10), read and written
 * through `fs.*` and, above one chunk, `transfer.*`. Paths that escape the root by their text
 * are refused here, with the runner's own path rules, before anything is sent; the runner checks
 * the real path and the other guards. Nothing here touches the server's disk.
 */
export class RunnerWorkspaceFs implements WorkspaceFs {
  readonly remote = true;

  constructor(
    private readonly runner: RunnerPort,
    readonly root: string,
  ) {}

  private platform(): string {
    return this.runner.remote?.().platform ?? process.platform;
  }

  /** Refuse a path that escapes the root by its text (NUL, `..`, another absolute path). */
  private checked(path: string): string {
    lexicalTarget(this.root, path, this.platform());
    return path;
  }

  pathOf(relative: string): string {
    return platformPath(this.platform()).join(this.root, relative);
  }

  private async call<N extends RunnerCommandName>(
    command: RunnerCommandOf<N>,
  ): Promise<RunnerCommandResult<N>> {
    try {
      return await this.runner.request(command, FS_TIMEOUT_MS);
    } catch (error) {
      const code = WorkspaceFsErrorCode.safeParse(runnerErrorCode(error));
      if (!code.success) throw error;
      throw new WorkspaceFsError(code.data, (error as Error).message);
    }
  }

  async list(maxEntries?: number) {
    return this.call({
      name: "fs.list",
      root: this.root,
      ...(maxEntries ? { maxEntries } : {}),
    });
  }

  async stat(path: string): Promise<DiskStat> {
    return this.call({ name: "fs.stat", root: this.root, path: this.checked(path) });
  }

  async read(path: string, offset?: number, length?: number) {
    const result = await this.call({
      name: "fs.read",
      root: this.root,
      path: this.checked(path),
      ...(offset ? { offset } : {}),
      ...(length ? { length: Math.min(length, FS_CHUNK_MAX_BYTES) } : {}),
    });
    return {
      bytes: Buffer.from(result.data, "base64"),
      sizeBytes: result.sizeBytes,
      eof: result.eof,
    };
  }

  async readFile(path: string, maxBytes: number) {
    const info = await this.stat(path);
    if (!info.exists) throw new WorkspaceFsError("not_found", "No such file");
    if (info.kind !== "file") throw new WorkspaceFsError("not_a_file", "Not a file");
    if (info.sizeBytes > maxBytes) throw new WorkspaceFsError("too_large", "The file is too large");
    if (info.sizeBytes <= FS_CHUNK_MAX_BYTES) {
      const first = await this.read(path);
      if (first.eof) return { bytes: first.bytes, realPath: info.realPath };
    }
    return { bytes: await this.pull(path, maxBytes), realPath: info.realPath };
  }

  /** Read a whole file chunk by chunk; the runner sends one chunk per request. */
  private async pull(path: string, maxBytes: number): Promise<Buffer> {
    const open = await this.call({
      name: "transfer.open",
      root: this.root,
      path: this.checked(path),
      mode: "read",
    });
    const { transferId } = open;
    try {
      if (open.sizeBytes > maxBytes)
        throw new WorkspaceFsError("too_large", "The file is too large");
      const chunks: Buffer[] = [];
      let total = 0;
      for (;;) {
        const chunk = await this.call({ name: "transfer.read", transferId });
        const bytes = Buffer.from(chunk.data, "base64");
        total += bytes.length;
        if (total > maxBytes) throw new WorkspaceFsError("too_large", "The file is too large");
        chunks.push(bytes);
        if (chunk.eof || bytes.length === 0) break;
      }
      return Buffer.concat(chunks);
    } finally {
      await this.call({ name: "transfer.close", transferId }).catch(() => undefined);
    }
  }

  async writeFile(path: string, bytes: Buffer, opts: { createDirs?: boolean } = {}) {
    const target = this.checked(path);
    const createDirs = opts.createDirs ? { createDirs: true } : {};
    if (bytes.length <= FS_CHUNK_MAX_BYTES) {
      await this.call({
        name: "fs.write",
        root: this.root,
        path: target,
        data: bytes.toString("base64"),
        ...createDirs,
      });
      return;
    }
    const { transferId } = await this.call({
      name: "transfer.open",
      root: this.root,
      path: target,
      mode: "write",
      ...createDirs,
    });
    let committed = false;
    try {
      for (let at = 0; at < bytes.length; at += TRANSFER_CHUNK_BYTES) {
        const data = bytes.subarray(at, at + TRANSFER_CHUNK_BYTES).toString("base64");
        await this.call({ name: "transfer.write", transferId, data });
      }
      await this.call({ name: "transfer.close", transferId, commit: true });
      committed = true;
    } finally {
      if (!committed) {
        await this.call({ name: "transfer.close", transferId }).catch(() => undefined);
      }
    }
  }
}

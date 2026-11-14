import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DiskWorkspace, WorkspaceFsError, workspaceRelative } from "@codeden/providers";
import type { WorkspaceFs } from "./workspace-fs";

/**
 * A home-runner session's folder on the server's own disk (`node:fs`), behind the same guards
 * the runner's `fs.*` use. `home` is CodeDen's data folder, whose credential files are refused.
 */
export class LocalWorkspaceFs implements WorkspaceFs {
  readonly remote = false;

  constructor(
    readonly root: string,
    private readonly home: string,
  ) {}

  private open(): DiskWorkspace {
    return new DiskWorkspace(this.root, this.home);
  }

  async list(maxEntries?: number) {
    return this.open().list(undefined, maxEntries);
  }

  async stat(path: string) {
    return this.open().stat(path);
  }

  async read(path: string, offset?: number, length?: number) {
    return this.open().read(path, offset, length);
  }

  async readFile(path: string, maxBytes: number) {
    const ws = this.open();
    const { real, sizeBytes } = ws.readable(path);
    if (sizeBytes > maxBytes) throw new WorkspaceFsError("too_large", "The file is too large");
    return { bytes: readFileSync(real), realPath: workspaceRelative(ws.realRoot, real) };
  }

  async writeFile(path: string, bytes: Buffer, opts: { createDirs?: boolean } = {}) {
    this.open().write(path, bytes, opts.createDirs);
  }

  pathOf(relative: string): string {
    return join(this.root, relative);
  }
}

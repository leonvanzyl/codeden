import { existsSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { forbidden, notFound } from "./errors";
import { isInside, realPathOf } from "./files/path-guard";
import { assertNotSecret } from "./secret-files";
import { type WorkspaceFs, workspaceHttpError } from "./workspace-fs/workspace-fs";

/**
 * Files an agent names by path that leave CodeDen's hands: shared to the chat (`share_to_chat`),
 * where `attach_evidence` can publish them, or uploaded into a web page (`browser_upload`), which
 * can send them anywhere. One rule for all of them, so they can't drift apart: only a file from
 * the session's own folders, and never a secrets file (`assertNotSecret`, §15).
 */

/** What happens to the file, for messages: "can be shared", "can be uploaded". */
export type OutgoingUse = "shared" | "uploaded";

export interface LocalOutgoingOptions {
  /** The session's working folder: relative paths resolve against it. */
  cwd: string;
  /** The session's own CodeDen artifacts (screenshots, shared files). */
  artifactsDir: string;
  /** CodeDen's data folder, whose credential files are refused. */
  home?: string;
  use: OutgoingUse;
}

/**
 * A file on this machine (a home-runner session): `path` is absolute or relative to `cwd`, and
 * its real path (links, junctions and short names resolved) must be a file inside the working
 * folder, the temp folder or the session's artifacts, and no secrets file. Returns that real
 * path; the caller reads or sends that one, never the path it was given.
 */
export function localOutgoingFile(path: string, opts: LocalOutgoingOptions): string {
  const absolute = resolve(opts.cwd, path);
  const real = existsSync(absolute) && statSync(absolute).isFile() && realPathOf(absolute);
  if (!real) throw notFound(`File not found: ${path}`, "file_not_found");
  const roots = [opts.cwd, tmpdir(), opts.artifactsDir].flatMap((p) => realPathOf(p) ?? []);
  if (!roots.some((root) => isInside(root, real))) {
    throw forbidden(
      `Only files inside your working directory, the temp folder or your own CodeDen artifacts can be ${opts.use}`,
      "path_outside_root",
    );
  }
  assertNotSecret({ realPath: real, paths: [path], names: [] }, opts.home);
  return real;
}

/**
 * A file in a workspace on another runner's disk (`docs/remote-runners.md` §10), checked through
 * the runner: only files inside the workspace (the server's temp folder and artifacts are no
 * place a sandboxed agent can write), and no secrets file by the path given or its real path.
 * Returns the file's absolute real path on that runner's machine.
 */
export async function remoteOutgoingFile(
  files: WorkspaceFs,
  path: string,
  opts: { home?: string; use: OutgoingUse },
): Promise<string> {
  try {
    const info = await files.stat(path);
    if (!info.exists || info.kind !== "file") {
      throw notFound(`File not found: ${path}`, "file_not_found");
    }
    assertNotSecret({ paths: [path, info.realPath], names: [] }, opts.home);
    return files.pathOf(info.realPath);
  } catch (error) {
    throw workspaceHttpError(error, {
      path_outside_root: {
        code: "path_outside_root",
        message: `Only files inside your working directory (${files.root}) can be ${opts.use} from this runner`,
      },
      not_found: { code: "file_not_found", message: `File not found: ${path}` },
    });
  }
}

import type { SessionFileContent, SessionFileList } from "@codeden/contracts";
import { DiskWorkspace } from "@codeden/providers";
import type { WorkspaceFs } from "../workspace-fs/workspace-fs";
import { workspaceHttpError } from "../workspace-fs/workspace-fs";

const MAX_READ_BYTES = 1024 * 1024;

/** The files panel's own error codes, kept from before workspaces could be remote. */
const FILES_ERRORS = {
  cwd_missing: { code: "folder_not_found", message: "The session folder no longer exists" },
  not_found: { code: "file_not_found", message: "No such file" },
};

/**
 * List a session's working directory for the files panel (§12.3), wherever it is (`WorkspaceFs`):
 * depth-first, folders first, `.git` and `node_modules` skipped, capped at 5000 entries.
 * Symlinks are listed but not followed.
 */
export async function listSessionFiles(fs: WorkspaceFs): Promise<SessionFileList> {
  try {
    const { entries, truncated } = await fs.list();
    return { root: fs.root, entries, truncated };
  } catch (error) {
    throw workspaceHttpError(error, FILES_ERRORS);
  }
}

/** The same listing of a project folder on the server's disk (the composer's `@` menu). */
export function listFolderFiles(root: string, home: string): SessionFileList {
  try {
    return { root, ...new DiskWorkspace(root, home).list() };
  } catch (error) {
    throw workspaceHttpError(error, FILES_ERRORS);
  }
}

/** Read one file (first 1 MB) from a session's working directory, inside the path guard. */
export async function readSessionFile(fs: WorkspaceFs, path: string): Promise<SessionFileContent> {
  try {
    const { bytes, sizeBytes } = await fs.read(path, 0, MAX_READ_BYTES);
    const binary = bytes.subarray(0, 8000).includes(0);
    return {
      path: path.replace(/\\/g, "/"),
      content: binary ? "" : bytes.toString("utf8"),
      sizeBytes,
      binary,
      truncated: sizeBytes > MAX_READ_BYTES,
    };
  } catch (error) {
    throw workspaceHttpError(error, FILES_ERRORS);
  }
}

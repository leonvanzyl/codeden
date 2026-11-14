import { posix } from "node:path";
import { MAX_ATTACHMENT_BYTES } from "../artifacts";
import { badRequest, notFound } from "../errors";
import { assertNotSecret } from "../secret-files";
import { type WorkspaceFs, workspaceHttpError } from "./workspace-fs";

/**
 * A file an agent shares (`share_to_chat`) or attaches (`attach_evidence`) by path from a
 * workspace on another runner's disk (`docs/remote-runners.md` §10). Only files inside the
 * workspace: the server's temp folder and artifacts are no place a sandboxed agent can write. A
 * secrets file is refused by every name it goes by (`assertNotSecret`, the real path the runner
 * reports included) before any byte is read, and again by the real path of the read itself.
 */
export async function readOutgoingFile(
  files: WorkspaceFs,
  path: string,
  opts: { name?: string; home?: string; names?: Array<string | undefined> },
): Promise<{ bytes: Buffer; name: string }> {
  try {
    const info = await files.stat(path);
    if (!info.exists || info.kind !== "file") {
      throw notFound(`File not found: ${path}`, "file_not_found");
    }
    const name = opts.name ?? posix.basename(info.realPath);
    const names = [...(opts.names ?? []), name];
    assertNotSecret({ paths: [path, info.realPath], names }, opts.home);
    if (info.sizeBytes > MAX_ATTACHMENT_BYTES) throw badRequest(`${name} is larger than 20 MB`);
    const read = await files.readFile(path, MAX_ATTACHMENT_BYTES);
    assertNotSecret({ paths: [read.realPath], names }, opts.home);
    return { bytes: read.bytes, name };
  } catch (error) {
    throw workspaceHttpError(error, {
      path_outside_root: {
        code: "path_outside_root",
        message: `Only files inside your working directory (${files.root}) can be shared from this runner`,
      },
      not_found: { code: "file_not_found", message: `File not found: ${path}` },
      too_large: { code: "too_large", message: "The file is larger than 20 MB" },
    });
  }
}

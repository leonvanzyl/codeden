import { readFileSync, writeFileSync } from "node:fs";
import { basename, join, relative } from "node:path";
import { badRequest } from "../errors";
import { type WorkspaceFs, workspaceHttpError } from "../workspace-fs/workspace-fs";

/**
 * `generate_image` for an agent whose workspace is on another runner's disk
 * (`docs/remote-runners.md` §10). Engines write files on this machine, so the images are made in
 * a staging folder here and then written into the workspace through the runner, at the same
 * relative path the agent asked for (the runner refuses `.git` and agents' allow-lists).
 * Reference images are read from the workspace into the staging folder first.
 */

/** Copy the agent's reference images from its workspace into `staging`; returns their paths. */
export async function stageReferences(
  files: WorkspaceFs,
  staging: string,
  paths: string[],
  maxBytes: number,
): Promise<string[]> {
  const staged: string[] = [];
  for (const [i, path] of paths.entries()) {
    try {
      const { bytes } = await files.readFile(path, maxBytes);
      const local = join(staging, `reference-${i}-${basename(path.replace(/\\/g, "/"))}`);
      writeFileSync(local, bytes);
      staged.push(local);
    } catch (error) {
      const code = (error as { code?: string }).code;
      if (code === "not_found" || code === "not_a_file") {
        throw badRequest(`Reference image not found: ${path}`, "reference_not_found");
      }
      throw workspaceHttpError(error);
    }
  }
  return staged;
}

/**
 * Write a generated image from `staging` into the workspace at the same relative path. Returns
 * its path on the workspace's machine and the `/`-separated relative path.
 */
export async function deliverImage(
  files: WorkspaceFs,
  staging: string,
  file: string,
): Promise<{ path: string; relativePath: string }> {
  const relativePath = relative(staging, file).split("\\").join("/");
  try {
    await files.writeFile(relativePath, readFileSync(file), { createDirs: true });
  } catch (error) {
    throw workspaceHttpError(error);
  }
  return { path: files.pathOf(relativePath), relativePath };
}

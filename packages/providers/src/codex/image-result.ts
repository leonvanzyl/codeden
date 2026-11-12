import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { imageInfo } from "../image/image-file";

/** Where generated images Codex didn't save itself are written (one file per item). */
export const CODEX_IMAGE_DIR = join(tmpdir(), "codeden-generated-images");

const EXTENSION = { png: ".png", jpeg: ".jpg", webp: ".webp", gif: ".gif" } as const;

/** A generated image written to disk, or why it could not be. */
export type SavedImageResult = { path: string } | { error: string };

/**
 * Write a Codex image generation's base64 `result` to `dir` when Codex reported no
 * `savedPath`, so the transcript can point at a file instead of carrying the bytes. The name
 * follows the item id and the extension the actual bytes, so writing the same item again
 * replaces the file instead of adding another.
 */
export function saveImageResult(
  itemId: string,
  base64: string,
  dir = CODEX_IMAGE_DIR,
): SavedImageResult {
  const bytes = Buffer.from(base64, "base64");
  const meta = imageInfo(bytes);
  if (!meta) return { error: "Codex returned data that is not an image" };
  const name = `${itemId.replace(/[^\w.-]/g, "_").slice(0, 120) || "image"}${EXTENSION[meta.format]}`;
  try {
    mkdirSync(dir, { recursive: true });
    const path = join(dir, name);
    writeFileSync(path, bytes);
    return { path };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { error: `Could not save the generated image: ${message}` };
  }
}

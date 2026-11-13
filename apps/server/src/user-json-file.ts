import { copyFileSync, existsSync, readFileSync } from "node:fs";
import type { z } from "zod";
import { writeJsonFile } from "./json-file";

/** A user file CodeDen could not use and replaced with defaults; the original is kept at `copy`. */
export interface FileReset {
  file: string;
  /** `<file>.invalid-<timestamp>`: the user's original bytes. */
  copy: string;
  /** Why the file could not be used, in one line (the JSON or schema error). */
  reason: string;
}

/**
 * Load a JSON file the user may edit by hand in the data folder (§6). A missing file gives the
 * schema's defaults. A file that is not valid JSON or fails the schema is copied to
 * `<file>.invalid-<timestamp>` before defaults are written over it, so the user's settings are
 * never lost, and the reset is returned so the caller can tell the user.
 */
export function loadUserJsonFile<S extends z.ZodType>(
  file: string,
  schema: S,
  now: () => number = Date.now,
): { value: z.output<S>; reset: FileReset | null } {
  const defaults = () => schema.parse({}) as z.output<S>;
  if (!existsSync(file)) return { value: defaults(), reset: null };
  let reason: string;
  try {
    const parsed = schema.safeParse(JSON.parse(readFileSync(file, "utf8")));
    if (parsed.success) return { value: parsed.data, reset: null };
    const issue = parsed.error.issues[0];
    const where = issue?.path.length ? `${issue.path.join(".")}: ` : "";
    reason = `${where}${issue?.message ?? "invalid values"}`;
  } catch (error) {
    reason = error instanceof Error ? error.message : String(error);
  }
  const copy = `${file}.invalid-${now()}`;
  copyFileSync(file, copy);
  const value = defaults();
  writeJsonFile(file, value);
  return { value, reset: { file, copy, reason } };
}

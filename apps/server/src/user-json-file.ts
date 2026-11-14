import { chmodSync, copyFileSync, existsSync, readFileSync } from "node:fs";
import { INVALID_COPY_SUFFIX } from "@codeden/contracts";
import type { z } from "zod";
import { writeJsonFile } from "./json-file";

/** A user file CodeDen could not use and replaced with defaults; the original is kept at `copy`. */
export interface FileReset {
  file: string;
  /** `<file>.invalid-<timestamp>`: the user's original bytes. */
  copy: string;
  /**
   * Why the file could not be used, in one line. Never quotes the file's contents (some of these
   * files hold password and token hashes): a JSON error gives its line and column, a schema
   * error the field and what was expected.
   */
  reason: string;
}

export interface LoadUserJsonOptions<T> {
  /** Values for a missing or broken file (default: the schema parsed from `{}`). */
  defaults?: () => T;
  /** File mode for the rewritten file and the copy, e.g. `0o600` for files with credentials. */
  mode?: number;
  now?: () => number;
}

/**
 * Load a JSON file in the data folder (§6) that holds the user's choices or data CodeDen must
 * not lose. A missing file gives the defaults. A file that is not valid JSON or fails the schema
 * is copied to `<file>.invalid-<timestamp>` before the defaults are written over it, so whatever
 * CodeDen saves next never overwrites the only copy, and the reset is returned so the caller can
 * tell the user.
 */
export function loadUserJsonFile<S extends z.ZodType>(
  file: string,
  schema: S,
  opts: LoadUserJsonOptions<z.output<S>> = {},
): { value: z.output<S>; reset: FileReset | null } {
  const defaults = opts.defaults ?? (() => schema.parse({}) as z.output<S>);
  if (!existsSync(file)) return { value: defaults(), reset: null };
  let reason: string;
  try {
    const parsed = schema.safeParse(JSON.parse(readFileSync(file, "utf8")));
    if (parsed.success) return { value: parsed.data, reset: null };
    const issue = parsed.error.issues[0];
    const where = issue?.path.length ? `${issue.path.join(".")}: ` : "";
    reason = `${where}${issue?.message ?? "invalid values"}`;
  } catch (error) {
    reason = readProblem(error);
  }
  // The agents' policy guards copies of CodeDen's credential files by this name.
  const copy = `${file}${INVALID_COPY_SUFFIX}${(opts.now ?? Date.now)()}`;
  copyFileSync(file, copy);
  if (opts.mode !== undefined) chmodSync(copy, opts.mode);
  const value = defaults();
  writeJsonFile(file, value, opts.mode);
  return { value, reset: { file, copy, reason } };
}

/** A read or JSON error in words, without the snippet of the file a JSON error may carry. */
function readProblem(error: unknown): string {
  if (error instanceof SyntaxError) {
    const at = /line (\d+) column (\d+)/.exec(error.message);
    return at ? `not valid JSON at line ${at[1]}, column ${at[2]}` : "not valid JSON";
  }
  return (error as NodeJS.ErrnoException | null)?.code ?? "read error";
}

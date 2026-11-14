import { closeSync, constants, fstatSync, openSync, readSync, type Stats, statSync } from "node:fs";
import { parseJsonc } from "../util/jsonc";

/**
 * Helpers for the warning an ACP session gives when its worktree holds the agent's own
 * allow-list (§11.2, `AcpAgentSpec.allowListNotice`). Cursor and Gemini CLI run what those rules
 * list without asking, so CodeDen never sees the call; a rule may have come in with a merged
 * change.
 */

/** The most a settings or policy file is read; real ones are a few kilobytes. */
export const MAX_FILE_BYTES = 1024 * 1024;

/**
 * The text of a small regular file: undefined when nothing is there, null when it can't be read
 * safely. The worktree is the agent's (or a merged change's), so a name may be a symlink to a
 * device (`/dev/zero`, which reports size 0), a FIFO (opening one waits for a writer) or a folder:
 * only a regular file, followed through symlinks, of at most `max` bytes is opened, and at most
 * that much of it is read. Never throws.
 */
export function readSmallFile(file: string, max = MAX_FILE_BYTES): string | null | undefined {
  let stats: Stats;
  try {
    stats = statSync(file);
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT" ? undefined : null;
  }
  if (!stats.isFile() || stats.size > max) return null;
  let fd: number | undefined;
  try {
    // Non-blocking where the OS has it: a FIFO swapped in after the check can't hang the open.
    fd = openSync(file, constants.O_RDONLY | (constants.O_NONBLOCK ?? 0));
    // Checked again on what was opened: the name may have changed since.
    const opened = fstatSync(fd);
    if (!opened.isFile() || opened.size > max) return null;
    const buffer = Buffer.alloc(opened.size);
    const read = readSync(fd, buffer, 0, buffer.length, 0);
    return buffer.subarray(0, read).toString("utf8");
  } catch {
    return null;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/**
 * A settings file in the worktree: missing, or its text (null when it can't be read safely,
 * `readSmallFile`) and what it parses to (undefined when it isn't JSON).
 */
export type SettingsFile = { exists: false } | { exists: true; text: string | null; data: unknown };

/** Read a JSON settings file (comments and trailing commas allowed). Never throws. */
export function readSettingsFile(file: string): SettingsFile {
  const text = readSmallFile(file);
  if (text === undefined) return { exists: false };
  return { exists: true, text, data: text === null ? undefined : parseJsonc(text) };
}

/** What a warning says about a settings file it can't read safely (a device, too large, ...). */
export const UNREADABLE = "CodeDen couldn't read it safely";

/** `value[key]` when `value` is an object. */
export function field(value: unknown, key: string): unknown {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)[key]
    : undefined;
}

/** The non-empty strings of a list setting. */
export function stringList(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((v): v is string => typeof v === "string" && v.trim() !== "")
    : [];
}

const MAX_SHOWN = 6;

/** Rules for a sentence: the first few, then how many more. */
export function listRules(rules: readonly string[]): string {
  const shown = rules.slice(0, MAX_SHOWN).join(", ");
  const more = rules.length - MAX_SHOWN;
  return more > 0 ? `${shown} and ${more} more` : shown;
}

/** The closing advice of every allow-list warning. */
export const CHECK_RULES =
  "Check them before relying on CodeDen's permission levels: they may have come in with a merged change. Remove them to have every call asked again.";

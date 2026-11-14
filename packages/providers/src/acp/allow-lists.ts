import { readFileSync } from "node:fs";
import { parseJsonc } from "../util/jsonc";

/**
 * Helpers for the warning an ACP session gives when its worktree holds the agent's own
 * allow-list (§11.2, `AcpAgentSpec.allowListNotice`). Cursor and Gemini CLI run what those rules
 * list without asking, so CodeDen never sees the call; a rule may have come in with a merged
 * change.
 */

/**
 * A settings file in the worktree: missing, or its text and what it parses to (undefined when it
 * isn't JSON).
 */
export type SettingsFile = { exists: false } | { exists: true; text: string; data: unknown };

/** Read a JSON settings file (comments and trailing commas allowed). Never throws. */
export function readSettingsFile(file: string): SettingsFile {
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    return { exists: false };
  }
  return { exists: true, text, data: parseJsonc(text) };
}

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

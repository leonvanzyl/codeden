import type { ResolvedCommand } from "../util/exec";
import { quickLocate } from "../util/locate";

/**
 * Names the Cursor CLI installs, most specific first: `cursor-agent`, then `agent`. `agent`
 * is a common word, so detection only accepts a copy whose `--version` is Cursor's
 * (`isCursorVersion`).
 */
export const CURSOR_COMMANDS = ["cursor-agent", "agent"] as const;

/** Cursor's CLI versions are dated builds: `2026.10.22-1a2b3c4`. */
export function isCursorVersion(version: string | null | undefined): boolean {
  return !!version && /^20\d{2}\.\d{1,2}\.\d{1,2}(?:[-.][\w.-]+)?$/.test(version.trim());
}

/**
 * The Cursor CLI to launch, without running anything: PATH first, then its installer's
 * folders (§14). Looked up every time, since the runner outlives updates and reinstalls.
 */
export function locateCursor(): ResolvedCommand | undefined {
  for (const name of CURSOR_COMMANDS) {
    const found = quickLocate(name);
    if (found) return found;
  }
  return undefined;
}

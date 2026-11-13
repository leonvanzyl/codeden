import type { BrokenExecutable } from "@codeden/contracts";
import type { ResolvedCommand } from "../util/exec";
import { runsVersion, type Validation } from "../util/locate";

/**
 * Names the Cursor CLI installs, most specific first: `cursor-agent`, then `agent`. `agent`
 * is a common word, so a copy is only used when its `--version` is Cursor's
 * (`isCursorVersion`); nothing else is ever run on it.
 */
export const CURSOR_COMMANDS = ["cursor-agent", "agent"] as const;

/** Why a working `agent` was passed over: it is another program. Never reported as broken. */
export const NOT_CURSOR = "is not the Cursor CLI";

/** Cursor's CLI versions are dated builds: `2026.10.22-1a2b3c4`. */
export function isCursorVersion(version: string | null | undefined): boolean {
  return !!version && /^20\d{2}\.\d{1,2}\.\d{1,2}(?:[-.][\w.-]+)?$/.test(version.trim());
}

/**
 * A `--version` check that accepts only Cursor's CLI, so the look-up moves on past another
 * program called `agent` earlier on PATH to Cursor's own copy.
 */
export function cursorOnly(timeoutMs?: number): (command: ResolvedCommand) => Promise<Validation> {
  return async (command) => {
    const result = await runsVersion(command, timeoutMs);
    return result.ok && !isCursorVersion(result.version)
      ? { ok: false, reason: NOT_CURSOR }
      : result;
  };
}

/** Broken copies worth reporting: other programs called `agent` are not Cursor installs. */
export function cursorBroken(broken: readonly BrokenExecutable[]): BrokenExecutable[] {
  return broken.filter((b) => b.reason !== NOT_CURSOR);
}

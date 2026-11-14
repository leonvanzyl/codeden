import path from "node:path";
import {
  CHECK_RULES,
  field,
  listRules,
  readSettingsFile,
  stringList,
  UNREADABLE,
} from "../acp/allow-lists";

/** Cursor's project settings, relative to the worktree. */
export const CURSOR_PROJECT_CONFIG = ".cursor/cli.json";

/**
 * The warning for Cursor's own allow-list in the worktree (`.cursor/cli.json`,
 * `permissions.allow`), or undefined when it has no rules. Cursor runs what they allow without
 * asking, and it has no option to ignore a project's file, so CodeDen can only say so (§11.2).
 * A file that isn't JSON but mentions `allow` is reported too, and so is one CodeDen can't read
 * safely (a symlink to a device, a huge file), which may hide rules.
 */
export function cursorAllowListNotice(cwd: string): string | undefined {
  const file = readSettingsFile(path.join(cwd, CURSOR_PROJECT_CONFIG));
  if (!file.exists) return undefined;
  let rules: string;
  if (file.text === null) {
    rules = UNREADABLE;
  } else if (file.data === undefined) {
    if (!/allow/i.test(file.text)) return undefined;
    rules = "CodeDen couldn't read its rules";
  } else {
    const allow = stringList(field(field(file.data, "permissions"), "allow"));
    if (!allow.length) return undefined;
    rules = listRules(allow);
  }
  return `This worktree has Cursor's own allow-list, \`${CURSOR_PROJECT_CONFIG}\` (${rules}). Cursor runs what it allows without asking, so CodeDen's approvals never see those calls, at any permission level. ${CHECK_RULES}`;
}

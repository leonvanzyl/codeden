import { basename } from "node:path";
import type { InboxItem } from "@codeden/contracts";
import type { EventStore } from "../events/store";
import type { FileReset } from "../user-json-file";

export interface FileResetNotice {
  /** What was reset, as the subject of "were reset", e.g. "Settings". */
  what: string;
  /** The notice's last sentence: what else the user can do, or what the reset means for them. */
  after: string;
}

/** The files CodeDen keeps a copy of when it has to reset them, and what it tells the user. */
export const FILE_RESET_NOTICES = {
  settings: { what: "Settings", after: "Or set your choices again in Settings." },
  usageSettings: {
    what: "Usage settings",
    after: "Or set your budgets and prices again on the Usage page.",
  },
  imageUsage: {
    what: "Today's image counts",
    after: "Until then the daily image caps count only the images made from now on.",
  },
  remoteAccess: {
    what: "Network access settings",
    after:
      "Until then network access is off and every remote device is signed out; set a password in Settings › Network access to turn it on again.",
  },
} satisfies Record<string, FileResetNotice>;

/** One line for logs and the terminal. Holds paths and the reason only, never file contents. */
export function fileResetMessage(reset: FileReset, notice: FileResetNotice): string {
  return `${notice.what} were reset: ${reset.file} could not be read (${reset.reason}). The old file is kept at ${reset.copy}.`;
}

/** The inbox item for one reset; its id comes from the copy, so each reset is raised once. */
export function fileResetInboxItem(
  reset: FileReset,
  notice: FileResetNotice,
  now: Date = new Date(),
): InboxItem {
  const at = now.toISOString();
  const name = basename(reset.file);
  return {
    id: `inbox:file-reset:${basename(reset.copy)}`,
    kind: "message",
    status: "open",
    priority: "high",
    // The user's settings were replaced by defaults: they should know, whatever else is going on.
    notify: "failure",
    title: `${notice.what} were reset: ${name} could not be read`,
    // Plain text: the inbox shows bodies as one paragraph, without markdown.
    body: [
      `CodeDen could not read ${reset.file} (${reset.reason}), so it started from the defaults.`,
      `Your old file is kept at ${reset.copy}.`,
      `To get it back, stop CodeDen, fix the copy and put it back as ${name}.`,
      notice.after,
    ].join(" "),
    projectId: null,
    sessionId: null,
    threadId: null,
    itemId: null,
    requestId: null,
    issue: null,
    pr: null,
    automationRunId: null,
    createdAt: at,
    updatedAt: at,
    resolvedAt: null,
    resolution: null,
  };
}

/**
 * Tell the user a file was reset to defaults: a warning on stderr (also in the desktop app's
 * server log) and the debug log, and an inbox item that says where the old file is.
 */
export function reportFileReset(
  reset: FileReset,
  notice: FileResetNotice,
  deps: { store: EventStore; log?: (message: string) => void; now?: () => Date },
): InboxItem {
  const message = fileResetMessage(reset, notice);
  console.warn(`[codeden] ${new Date().toISOString()} ${message}`);
  deps.log?.(message);
  const item = fileResetInboxItem(reset, notice, deps.now?.());
  deps.store.append([{ type: "inbox.created", sessionId: null, payload: { item } }]);
  return item;
}

import {
  type BrowserDialog,
  BrowserDialogId,
  DIALOG_TIMEOUT_MS,
  MAX_DIALOG_TEXT,
} from "@codeden/contracts";
import { z } from "zod";
import { defineTool } from "../define";

/**
 * `browser_dialog` (§12.2): answer the alert, confirm or prompt a page opened. The page is paused
 * until somebody answers: the agent here, or the user in the browser panel.
 */

const minutes = Math.round(DIALOG_TIMEOUT_MS / 60_000);

function describe(dialog: BrowserDialog): string {
  const kind = dialog.type === "beforeunload" ? '"Leave this page?" (beforeunload)' : dialog.type;
  return dialog.message ? `${kind} dialog "${dialog.message}"` : `${kind} dialog`;
}

/** What an agent reads when a page dialog is open: what it says, and how to answer it. */
export function dialogNote(dialog: BrowserDialog): string {
  const choices =
    dialog.type === "beforeunload"
      ? "accept: true to leave the page, false to stay"
      : dialog.type === "alert"
        ? "accept: true to close it"
        : "accept: true for OK, false for Cancel";
  const prompt =
    dialog.type === "prompt"
      ? `; promptText is what the prompt returns (default "${dialog.defaultValue ?? ""}")`
      : "";
  return `A ${describe(dialog)} is open on tab ${dialog.tabId} (dialogId "${dialog.dialogId}"). The page waits until it is answered: call browser_dialog with that dialogId and ${choices}${prompt}. Unanswered, it is dismissed after ${minutes} minutes.`;
}

/** `text`, plus the note on a dialog the action opened. */
export function withDialogNote(text: string, dialog: BrowserDialog | undefined): string {
  return dialog ? `${text}\n${dialogNote(dialog)}` : text;
}

export const browserDialog = defineTool({
  name: "browser_dialog",
  description: `Answer an alert, confirm or prompt dialog (or "Leave this page?") open in your browser. The page is paused until it is answered: a click, key or mouse action that opens one says so in its result, and browser_snapshot shows it, each with the dialog's dialogId. accept: true is OK (or Leave), false is Cancel; promptText is what a prompt returns (default: its own default text). The user may answer it in the browser panel first: then the call fails, and only that dialog is ever answered, never one the page opened after it. Unanswered dialogs are dismissed after ${minutes} minutes.`,
  roles: ["agent"],
  scope: "session",
  input: z.object({
    dialogId: BrowserDialogId.describe(
      "The dialogId from the result or snapshot that showed the dialog, e.g. d3fa9c21b",
    ),
    accept: z.boolean().describe("true: OK (Leave); false: Cancel"),
    promptText: z
      .string()
      .max(MAX_DIALOG_TEXT)
      .optional()
      .describe("prompt only: the text it returns"),
  }),
  handler: async (input, { services, sessionId }) => {
    const { dialog } = await services.browser.agentCommand({
      name: "browser.dialog",
      sessionId,
      ...input,
      by: "agent",
    });
    if (!input.accept) return `Dismissed the ${describe(dialog)} (Cancel).`;
    if (dialog.type === "prompt") {
      const text = input.promptText ?? dialog.defaultValue ?? "";
      return `Accepted the ${describe(dialog)} with "${text}".`;
    }
    return `Accepted the ${describe(dialog)}.`;
  },
});

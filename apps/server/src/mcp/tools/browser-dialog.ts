import { type BrowserDialog, DIALOG_TIMEOUT_MS, MAX_DIALOG_TEXT } from "@codeden/contracts";
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
  return `A ${describe(dialog)} is open on tab ${dialog.tabId}. The page waits until it is answered: call browser_dialog with ${choices}${prompt}. Unanswered, it is dismissed after ${minutes} minutes.`;
}

/** `text`, plus the note on a dialog the action opened. */
export function withDialogNote(text: string, dialog: BrowserDialog | undefined): string {
  return dialog ? `${text}\n${dialogNote(dialog)}` : text;
}

export const browserDialog = defineTool({
  name: "browser_dialog",
  description: `Answer the alert, confirm or prompt dialog (or "Leave this page?") open in your browser. The page is paused until it is answered: a click, key or mouse action that opens one says so in its result, and browser_snapshot shows it. accept: true is OK (or Leave), false is Cancel; promptText is what a prompt returns (default: its own default text). The user may answer it in the browser panel first; unanswered dialogs are dismissed after ${minutes} minutes.`,
  roles: ["agent"],
  scope: "session",
  input: z.object({
    accept: z.boolean().describe("true: OK (Leave); false: Cancel"),
    promptText: z
      .string()
      .max(MAX_DIALOG_TEXT)
      .optional()
      .describe("prompt only: the text it returns"),
    tabId: z
      .string()
      .min(1)
      .max(100)
      .optional()
      .describe("Tab id (t1, t2, ...); default: the tab with the open dialog"),
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

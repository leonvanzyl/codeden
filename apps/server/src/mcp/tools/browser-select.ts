import { type BrowserSelectedOption, MAX_SELECT_VALUES } from "@codeden/contracts";
import { z } from "zod";
import { defineTool } from "../define";
import { ref, tabId } from "./browser";
import { withDialogNote } from "./browser-dialog";

/**
 * `browser_select` (§12.2, computer use step 2): choose options of a native `<select>` menu by
 * ref. Its options open in a popup the browser draws itself, which neither snapshot refs nor
 * screenshot coordinates reach.
 */

/** `"Netherlands" (value nl)`, or just `"Netherlands"` when the value is the label. */
export function describeSelected(options: BrowserSelectedOption[]): string {
  return options
    .map((o) =>
      o.value === o.label
        ? JSON.stringify(o.label)
        : `${JSON.stringify(o.label)} (value ${JSON.stringify(o.value)})`,
    )
    .join(", ");
}

export const browserSelect = defineTool({
  name: "browser_select",
  description:
    "Choose an option of a <select> menu by its ref (browser_snapshot shows a combobox with its options, or a listbox for a multiple select): pass the option's label as the snapshot shows it, or its value. Several values select several options of a multiple select (and deselect the rest). The page gets the same change events a person's choice fires. A native select's options open in a popup that browser_click and browser_mouse can't reach, so use this for them; a custom dropdown the page draws itself is clicked open with browser_click instead.",
  roles: ["agent"],
  scope: "session",
  input: z.object({
    ref,
    values: z
      .array(z.string().max(1_000))
      .min(1)
      .max(MAX_SELECT_VALUES)
      .describe('Option labels (as the snapshot shows them) or values, e.g. ["Netherlands"]'),
    tabId,
  }),
  handler: async (input, { services, sessionId }) => {
    const { dialog, selected } = await services.browser.agentCommand({
      name: "browser.select",
      sessionId,
      ...input,
    });
    const text = !selected
      ? `Selected ${input.values.map((v) => JSON.stringify(v)).join(", ")} in ${input.ref}.`
      : selected.length
        ? `Selected ${describeSelected(selected)} in ${input.ref}.`
        : `${input.ref} has no option selected now.`;
    return withDialogNote(text, dialog);
  },
});

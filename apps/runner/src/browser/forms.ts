import { statSync } from "node:fs";
import { isAbsolute } from "node:path";
import type { BrowserSelectedOption, BrowserUploadVia } from "@codeden/contracts";
import type { FileChooser } from "playwright-core";
import { CommandError } from "../errors";
import { type ActionResult, target, withRef } from "./agent";
import type { BrowserSession } from "./session";

/**
 * Agent form controls the snapshot refs can't reach (§12.2 computer use, step 2): a native
 * `<select>`, whose options open in a popup the browser draws itself (the snapshot lists them
 * without refs), and file inputs, whose click opens a file chooser nobody can answer. Both go
 * through Playwright on CDP, so they work the same on the runner's Chromium and on native views
 * behind the desktop app's relay.
 */

/** How long `upload` waits for the file chooser that clicking a button or drop zone opens. */
export const FILE_CHOOSER_WAIT_MS = 3_000;

/** Longest wait to read a selection back; the choice itself is already made by then. */
const SELECT_READ_BACK_TIMEOUT_MS = 1_000;

/** Options named in a "no such option" error; a long list ends with how many more there are. */
const LISTED_OPTIONS = 30;

/** One `<option>` as `readSelect` reports it. */
export interface SelectOptionInfo {
  index: number;
  value: string;
  /** What people see (`option.label`: the label attribute or the text). */
  label: string;
  /** Disabled itself or by its `<optgroup>`. */
  disabled: boolean;
}

/** What `readSelect` reports about the element behind a ref (a label's control is followed). */
export interface SelectInfo {
  /** The element's tag name, lower case: `select` for a select menu. */
  tag: string;
  multiple: boolean;
  /** Disabled itself or by a disabled `<fieldset>`. */
  disabled: boolean;
  options: SelectOptionInfo[];
}

/** The page-side shapes the functions below read (the runner has no DOM types). */
interface PageOption {
  value: string;
  label: string;
  matches(selector: string): boolean;
}
interface PageElement {
  localName: string;
  type?: string;
  multiple?: boolean;
  control?: PageElement | null;
  options?: ArrayLike<PageOption>;
  selectedOptions?: ArrayLike<PageOption>;
  matches(selector: string): boolean;
}

/** In the page: the element, or the control of a `<label>`. */
const readSelect = (el: PageElement): SelectInfo => {
  const node = el.localName === "label" && el.control ? el.control : el;
  if (node.localName !== "select") {
    return { tag: node.localName, multiple: false, disabled: false, options: [] };
  }
  return {
    tag: "select",
    multiple: node.multiple === true,
    disabled: node.matches(":disabled"),
    options: Array.from(node.options ?? [], (o, index) => ({
      index,
      value: o.value,
      label: o.label,
      disabled: o.matches(":disabled"),
    })),
  };
};

const readSelected = (el: PageElement): BrowserSelectedOption[] => {
  const node = el.localName === "label" && el.control ? el.control : el;
  return Array.from(node.selectedOptions ?? [], (o) => ({ value: o.value, label: o.label }));
};

/** In the page: `{ multiple }` when the element (or a label's control) is a file input. */
const readFileInput = (el: PageElement): { multiple: boolean } | null => {
  const node = el.localName === "label" && el.control ? el.control : el;
  return node.localName === "input" && node.type === "file"
    ? { multiple: node.multiple === true }
    : null;
};

function describeOption(option: SelectOptionInfo): string {
  const label = JSON.stringify(option.label);
  return option.value === option.label ? label : `${label} (value ${JSON.stringify(option.value)})`;
}

/**
 * The options `values` name, by index: each value is an option's label (the text the snapshot
 * shows) or, failing that, its value, compared exactly. Throws a `CommandError` that says what to
 * do instead when the ref is no `<select>`, a value names no option, several values go to a
 * single select, or the select or a named option is disabled.
 */
export function pickOptions(ref: string, info: SelectInfo, values: readonly string[]): number[] {
  if (info.tag === "option" || info.tag === "optgroup") {
    throw new CommandError(
      "not_a_select",
      `${ref} is an <${info.tag}> of a <select> menu. Pass the ref of the menu itself (the combobox or listbox it is listed under) and the option's label as the value.`,
    );
  }
  if (info.tag !== "select") {
    throw new CommandError(
      "not_a_select",
      `${ref} is a <${info.tag}>, not a <select> menu. For a custom dropdown, click it open with browser_click, take a new snapshot and click the option.`,
    );
  }
  if (info.disabled) throw new CommandError("disabled", `The <select> ${ref} is disabled`);
  if (values.length > 1 && !info.multiple) {
    throw new CommandError(
      "not_multiple",
      `${ref} takes one option, not ${values.length}: pass one value`,
    );
  }
  const picked: number[] = [];
  for (const wanted of values) {
    const option =
      info.options.find((o) => o.label === wanted) ?? info.options.find((o) => o.value === wanted);
    if (!option) {
      const listed = info.options.slice(0, LISTED_OPTIONS).map(describeOption).join(", ");
      const more = info.options.length - LISTED_OPTIONS;
      const choices = info.options.length
        ? `Its options: ${listed}${more > 0 ? ` and ${more} more` : ""}.`
        : "It has no options.";
      throw new CommandError(
        "no_such_option",
        `No option of ${ref} has the label or value ${JSON.stringify(wanted)}. ${choices}`,
      );
    }
    if (option.disabled) {
      throw new CommandError("disabled", `Option ${describeOption(option)} of ${ref} is disabled`);
    }
    if (!picked.includes(option.index)) picked.push(option.index);
  }
  return picked;
}

/**
 * The options `selectOption` leaves selected when it picks `indexes`: exactly those (it deselects
 * the rest of a multiple select), in the order of the menu.
 */
export function chosenOptions(
  info: SelectInfo,
  indexes: readonly number[],
): BrowserSelectedOption[] {
  return info.options
    .filter((o) => indexes.includes(o.index))
    .map(({ value, label }) => ({ value, label }));
}

/**
 * `browser.select`: choose options of the `<select>` behind `ref`. The page gets the same
 * `input` and `change` events a person's choice would fire. Checks fail at once, so a typo never
 * waits out the action timeout.
 *
 * The selection is read back afterwards (a change handler may change it again), but the read
 * never decides the outcome: a sort-by or language menu whose change navigates the page, or a
 * select the page re-renders, is gone by then. The choice stands, and the result says so
 * (`detached`) instead of waiting out the timeout for an element that will not come back.
 */
export async function select(
  session: BrowserSession,
  ref: string,
  values: readonly string[],
  tabId?: string,
): Promise<ActionResult & { selected?: BrowserSelectedOption[]; detached?: boolean }> {
  const tab = target(session, tabId);
  return withRef(tab.page, ref, async (locator) => {
    const info = await locator.evaluate(readSelect);
    const indexes = pickOptions(ref, info, values);
    const result = await session.dialogs.race(tab.tabId, () =>
      locator.selectOption(indexes.map((index) => ({ index }))),
    );
    // A change handler opened a dialog: the page is paused until it is answered.
    if (result.dialog) return result;
    const chosen = { selected: chosenOptions(info, indexes), detached: true };
    // A navigated document has no refs: the ref resolves to nothing at once.
    if ((await locator.count().catch(() => 0)) === 0) return chosen;
    try {
      const timeout = SELECT_READ_BACK_TIMEOUT_MS;
      return { selected: await locator.evaluate(readSelected, undefined, { timeout }) };
    } catch {
      // The document went away while it was read (a navigation committing just then).
      return chosen;
    }
  });
}

/** Each path is absolute and names a file on this machine. */
export function checkUploadPaths(paths: readonly string[]): void {
  for (const path of paths) {
    if (!isAbsolute(path)) throw new CommandError("invalid_path", `Not an absolute path: ${path}`);
    let isFile = false;
    try {
      isFile = statSync(path).isFile();
    } catch {
      isFile = false;
    }
    if (!isFile) throw new CommandError("file_not_found", `No such file: ${path}`);
  }
}

/**
 * `browser.upload`: set `paths` on the file input behind `ref` (hidden ones too, or the input a
 * label is for), or click `ref` (a "Browse" button, a drop zone) and answer the file chooser it
 * opens. File choosers are intercepted only while this waits for one, so a person clicking a
 * file input in a native view still gets the desktop app's own picker.
 */
export async function upload(
  session: BrowserSession,
  ref: string,
  paths: readonly string[],
  tabId?: string,
): Promise<ActionResult & { via?: BrowserUploadVia }> {
  checkUploadPaths(paths);
  const tab = target(session, tabId);
  const files = [...paths];
  const single = (what: string) =>
    new CommandError("not_multiple", `${what} takes one file, not ${files.length}: pass one path`);
  return withRef(tab.page, ref, async (locator) => {
    const input = await locator.evaluate(readFileInput);
    if (input) {
      if (files.length > 1 && !input.multiple) throw single(`The file input ${ref}`);
      const result = await session.dialogs.race(tab.tabId, () => locator.setInputFiles(files));
      return { ...result, via: "input" };
    }
    const result = await session.dialogs.race(tab.tabId, async () => {
      const opened = tab.page.waitForEvent("filechooser", { timeout: FILE_CHOOSER_WAIT_MS });
      // Settled below; a click that fails first must not leave it unhandled.
      opened.catch(() => undefined);
      await locator.click();
      let chooser: FileChooser;
      try {
        chooser = await opened;
      } catch {
        throw new CommandError(
          "no_file_chooser",
          `Clicking ${ref} opened no file chooser within ${FILE_CHOOSER_WAIT_MS / 1000} s, so no files were set (the click itself went through). Pass the ref of the file input (a file input shows as a button in the snapshot), or of the button or drop zone whose click opens the file chooser.`,
        );
      }
      if (files.length > 1 && !chooser.isMultiple()) {
        throw single(`The file chooser ${ref} opened`);
      }
      await chooser.setFiles(files);
    });
    return result.dialog ? result : { via: "chooser" };
  });
}

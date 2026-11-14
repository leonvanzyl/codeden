import { z } from "zod";
import { Id } from "../common";
import { BrowserActionResult, BrowserElementRef, BrowserTabId } from "./browser";

/**
 * Agent form controls the snapshot refs and screenshots can't reach (§12.2 computer use, step 2):
 * a native `<select>` menu, whose options open in a popup the browser draws itself, and a file
 * input, whose click opens a file chooser. Spread into `RunnerCommand` next to `BrowserCommands`.
 */

/** Most options one `browser.select` picks (a multiple select). */
export const MAX_SELECT_VALUES = 100;

/** Most files one `browser.upload` sets. */
export const MAX_UPLOAD_FILES = 20;

/** An option of a `<select>` after `browser.select`: its `value` and the `label` people see. */
export const BrowserSelectedOption = z.object({
  value: z.string(),
  label: z.string(),
});
export type BrowserSelectedOption = z.infer<typeof BrowserSelectedOption>;

/**
 * How `browser.upload` set the files: on the file `input` itself (the ref was one, or a label
 * of one), or through the file `chooser` that clicking the ref (a button, a drop zone) opened.
 */
export const BrowserUploadVia = z.enum(["input", "chooser"]);
export type BrowserUploadVia = z.infer<typeof BrowserUploadVia>;

const TabTarget = { sessionId: Id, tabId: BrowserTabId.optional() };

/** `browser.select` and `browser.upload`, spread into `RunnerCommand`. */
export const BrowserFormCommands = [
  /**
   * Choose options of the `<select>` behind `ref`: each of `values` matches an option's value or
   * its label (the text people see), exactly. Several values only on a multiple select. The page
   * gets its real `input` and `change` events. Fails at once, never waiting, when the ref is not
   * a `<select>`, a value matches no option, or the select or an option is disabled.
   */
  z.object({
    name: z.literal("browser.select"),
    ...TabTarget,
    ref: BrowserElementRef,
    values: z.array(z.string().max(1_000)).min(1).max(MAX_SELECT_VALUES),
  }),
  /**
   * Set files on the file input behind `ref` (also a hidden one, or a label of one), or click
   * `ref` (a "Browse" button, a drop zone) and answer the file chooser it opens with them.
   * `paths` are absolute paths of files on the runner's machine; the server has checked them.
   */
  z.object({
    name: z.literal("browser.upload"),
    ...TabTarget,
    ref: BrowserElementRef,
    paths: z.array(z.string().min(1).max(4_096)).min(1).max(MAX_UPLOAD_FILES),
  }),
] as const;

/** Result schemas for `browser.select` and `browser.upload`, spread into `RunnerCommandResults`. */
export const BrowserFormCommandResults = {
  /**
   * `selected`: the options now selected (absent when the change opened a page dialog).
   * `detached`: the select left the page right after the choice (its change handler navigated,
   * or the page re-rendered it), so `selected` is what was chosen rather than read back.
   */
  "browser.select": BrowserActionResult.extend({
    selected: z.array(BrowserSelectedOption).optional(),
    detached: z.boolean().optional(),
  }),
  /** `via`: how the files were set (absent when a page dialog interrupted the action). */
  "browser.upload": BrowserActionResult.extend({ via: BrowserUploadVia.optional() }),
};

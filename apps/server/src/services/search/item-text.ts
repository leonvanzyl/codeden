import { type Item, searchableText } from "@codeden/contracts";

/** Marks the start of a match in FTS5 `highlight()` output. */
export const HIGHLIGHT_OPEN = "\u0002";
/** Marks the end of a match in FTS5 `highlight()` output. */
export const HIGHLIGHT_CLOSE = "\u0003";

/**
 * The text the index stores for an item (`searchableText`), without the two control characters
 * search uses to mark matches, so a snippet's highlights are always real matches.
 */
export function indexedText(item: Item): string {
  return searchableText(item).replaceAll(HIGHLIGHT_OPEN, "").replaceAll(HIGHLIGHT_CLOSE, "");
}

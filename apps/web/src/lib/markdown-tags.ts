/**
 * A wrapper tag on a line of its own, at the start of the line: `<issue>`, `</vision>`,
 * `<context kind="x">`. An indented tag is left alone: in Markdown it is code (four spaces) or
 * part of a list item.
 */
const TAG_LINE = /^<\/?[A-Za-z][\w.:-]*(?:\s[^<>]*)?\/?>\s*$/;
/** The opening or closing line of a fenced code block, at any indent (fences nest in lists). */
const FENCE = /^\s*(`{3,}|~{3,})/;

/**
 * Text written for an agent often wraps sections in XML-style tags on lines of their own
 * (`<issue>` … `</issue>`). In Markdown such a line opens an HTML block that runs to the next
 * blank line, so the Markdown right after it (a `## heading`, `**bold**`, a list) shows raw.
 * A blank line before and after each such tag line ends the block at the tag, which the
 * renderer drops, and the section renders as Markdown. Only unindented tag lines outside fenced
 * code count, so indented code and code blocks inside lists keep their tags; every other line
 * is unchanged.
 */
export function separateTagLines(text: string): string {
  const out: string[] = [];
  let fence: string | null = null;
  for (const line of text.split(/\r?\n/)) {
    const marker = FENCE.exec(line)?.[1];
    if (fence) {
      const closes =
        marker !== undefined &&
        marker[0] === fence[0] &&
        marker.length >= fence.length &&
        line.trim() === marker;
      if (closes) fence = null;
      out.push(line);
    } else if (marker) {
      fence = marker;
      out.push(line);
    } else if (TAG_LINE.test(line)) {
      if (out.length > 0 && out[out.length - 1]?.trim() !== "") out.push("");
      out.push(line, "");
    } else {
      out.push(line);
    }
  }
  return out.join("\n");
}

/** A line that is only an XML-style tag: `<issue>`, `</vision>`, `<context kind="x">`. */
const TAG_LINE = /^\s*<\/?[A-Za-z][\w.:-]*(?:\s[^<>]*)?\/?>\s*$/;
/** The opening or closing line of a fenced code block. */
const FENCE = /^ {0,3}(`{3,}|~{3,})/;

/**
 * Text written for an agent often wraps sections in XML-style tags on lines of their own
 * (`<issue>` … `</issue>`). In Markdown such a line opens an HTML block that runs to the next
 * blank line, so the Markdown right after it (a `## heading`, `**bold**`, a list) shows raw.
 * A blank line before and after each tag line (outside code fences) ends the block at the tag,
 * which the renderer drops, and the section renders as Markdown. Other lines are unchanged.
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
      out.push(line.trim(), "");
    } else {
      out.push(line);
    }
  }
  return out.join("\n");
}

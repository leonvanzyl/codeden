import { describe, expect, it } from "vitest";
import { separateTagLines } from "@/lib/markdown-tags";

describe("separateTagLines", () => {
  it("puts blank lines around lines that are only a tag", () => {
    expect(separateTagLines("Intro\n<issue>\n## Bug\nText\n</issue>\nEnd")).toBe(
      "Intro\n\n<issue>\n\n## Bug\nText\n\n</issue>\n\nEnd",
    );
    expect(separateTagLines('  <context kind="ci">  \nlog')).toBe('<context kind="ci">\n\nlog');
  });

  it("leaves code fences, inline tags and autolinks alone", () => {
    const text = [
      "```html",
      "<div>",
      "```",
      "Use <kbd>Ctrl</kbd> here",
      "<https://example.com>",
      "~~~~",
      "<issue>",
      "```",
      "~~~~",
    ].join("\n");
    expect(separateTagLines(text)).toBe(text);
  });

  it("keeps CRLF text readable", () => {
    expect(separateTagLines("a\r\n<vision>\r\nb")).toBe("a\n\n<vision>\n\nb");
  });
});

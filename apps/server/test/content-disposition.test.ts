import { describe, expect, it } from "vitest";
import { contentDisposition } from "../src/routes/content-disposition";

/** The name `filename*` carries, decoded. */
function starName(header: string): string | undefined {
  const encoded = /filename\*=UTF-8''(\S+)$/.exec(header)?.[1];
  return encoded === undefined ? undefined : decodeURIComponent(encoded);
}

describe("contentDisposition", () => {
  it("leaves a plain name as it is", () => {
    expect(contentDisposition("inline", "image.png")).toBe('inline; filename="image.png"');
    expect(contentDisposition("attachment", "notes (final).txt")).toBe(
      'attachment; filename="notes (final).txt"',
    );
  });

  // #68: macOS puts a narrow no-break space (U+202F) before "PM" in a screenshot's name. A
  // header can't hold it, so the image answered 500 and showed as a broken image.
  it("names a macOS screenshot in a header the server can send", () => {
    const name = "Screenshot 2026-11-02 at 2.55.06 PM.png";
    const header = contentDisposition("inline", name);
    expect(header).toBe(
      "inline; filename=\"Screenshot 2026-11-02 at 2.55.06_PM.png\"; filename*=UTF-8''Screenshot%202026-11-02%20at%202.55.06%E2%80%AFPM.png",
    );
    expect(starName(header)).toBe(name);
  });

  it("always answers a valid header value that can't end the quoted name or the line", () => {
    const names = [
      "résumé.png",
      "スクリーンショット 2026-11-02.png",
      "party 🎉.gif",
      'a"; filename="evil.html',
      "back\\slash.png",
      "line\r\nx-injected: 1.png",
      "tab\tand\u0000null\u007f.png",
      "it's (1)* café.png",
      "lone surrogate \ud83c.png",
    ];
    for (const name of names) {
      const header = contentDisposition("attachment", name);
      // Printable ASCII only: what `Headers` and Node's HTTP server accept everywhere.
      expect(header).toMatch(/^[\x20-\x7e]+$/);
      expect(() => new Headers({ "content-disposition": header })).not.toThrow();
      // One quoted name with nothing escaping it, then only the encoded form.
      expect(header).toMatch(
        /^attachment; filename="[^"\\]*"; filename\*=UTF-8''[\w.%!#$&+^`|~-]+$/,
      );
      expect(starName(header)).toBe(name.toWellFormed());
    }
  });
});

/** Characters `encodeURIComponent` leaves alone that RFC 8187's `filename*` does not allow. */
const escapeExtra = (c: string) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`;

/**
 * A `Content-Disposition` value that names a stored file, for any name a user can give one.
 *
 * A header value holds only Latin-1 and no control characters but tab, and file names often
 * hold more: macOS names a screenshot with a narrow no-break space (U+202F) before "PM", and
 * names carry CJK or emoji. Such a name put in the header as it is makes the whole response
 * fail (#68). So `filename` is an ASCII stand-in (anything else, quotes and backslashes become
 * `_`), and a name that needed changing also travels complete as `filename*` (RFC 8187, UTF-8
 * percent-encoded), which browsers prefer.
 */
export function contentDisposition(type: "inline" | "attachment", name: string): string {
  const fallback = name.replace(/[^\x20-\x7e]|["\\]/g, "_");
  const header = `${type}; filename="${fallback}"`;
  if (fallback === name) return header;
  const encoded = encodeURIComponent(name.toWellFormed()).replace(/[*'()]/g, escapeExtra);
  return `${header}; filename*=UTF-8''${encoded}`;
}

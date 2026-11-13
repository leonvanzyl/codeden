import type { ToolOutput } from "./items";

/**
 * Tool output kept in transcript pages, live updates and the browser's live transcript. The
 * rest is fetched on demand (§6, `GET /api/sessions/:id/items/:itemId/output`).
 */
export const OUTPUT_PREVIEW_CHARS = 16_000;

/**
 * Most tool output the server stores on an item while it streams. Older output is dropped past
 * this, so every chunk rewrites a bounded row however long the command runs.
 */
export const STREAMED_OUTPUT_CHARS = 64_000;

/** Size of `text` in UTF-8 bytes, as Node's `Buffer.byteLength` counts it (works in browsers). */
export function utf8ByteLength(text: string): number {
  let bytes = 0;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code < 0x80) bytes += 1;
    else if (code < 0x800) bytes += 2;
    else if (code >= 0xd800 && code <= 0xdbff && isLowSurrogate(text.charCodeAt(i + 1))) {
      bytes += 4;
      i++;
    } else bytes += 3; // the rest of the BMP, and a lone surrogate (encoded as U+FFFD)
  }
  return bytes;
}

const isLowSurrogate = (code: number) => code >= 0xdc00 && code <= 0xdfff;

/**
 * Append a streamed output chunk, keeping only the last `max` characters (the end of command
 * output is the useful part), marking the output `truncated` once anything is dropped and
 * counting every byte seen in `totalBytes`. The work per chunk is bounded by `max` and the
 * chunk, never by the output streamed so far. Pure.
 */
export function appendToolOutput(
  output: ToolOutput | undefined,
  chunk: string,
  max: number,
): ToolOutput {
  const prev = output?.text ?? "";
  const totalBytes = (output?.totalBytes ?? utf8ByteLength(prev)) + utf8ByteLength(chunk);
  if (prev.length + chunk.length <= max) {
    return { ...output, text: prev + chunk, truncated: output?.truncated ?? false, totalBytes };
  }
  const keep = max - chunk.length;
  let text = keep > 0 ? prev.slice(prev.length - keep) + chunk : chunk.slice(chunk.length - max);
  // Never start on the second half of a surrogate pair cut in two.
  if (isLowSurrogate(text.charCodeAt(0))) text = text.slice(1);
  return { ...output, text, truncated: true, totalBytes };
}

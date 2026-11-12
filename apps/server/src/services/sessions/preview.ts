import type { ItemRecord } from "@codeden/contracts";

/** Tool output kept in transcript pages and live updates; the rest is fetched on demand (§6). */
export const OUTPUT_PREVIEW_CHARS = 16_000;

/**
 * Most tool output stored on an item while it streams. Older output is dropped past this, so
 * every chunk rewrites a bounded row however long the command runs.
 */
export const STREAMED_OUTPUT_CHARS = 64_000;

/**
 * Trim large tool outputs to their last `max` characters (the end of command output is the
 * useful part) and mark them truncated with the full size. Pure.
 */
export function previewRecord(record: ItemRecord, max = OUTPUT_PREVIEW_CHARS): ItemRecord {
  const { item } = record;
  if (item.kind !== "tool_call" || !item.output || item.output.text.length <= max) return record;
  const text = item.output.text;
  return {
    ...record,
    item: {
      ...item,
      output: {
        ...item.output,
        text: text.slice(text.length - max),
        truncated: true,
        totalBytes: item.output.totalBytes ?? Buffer.byteLength(text, "utf8"),
      },
    },
  };
}

import { type ItemRecord, OUTPUT_PREVIEW_CHARS } from "@codeden/contracts";

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

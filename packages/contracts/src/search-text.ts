import type { Item, ToolCallItem } from "./items";

/** Most characters of one item that transcript search indexes; the rest is not searchable. */
export const MAX_SEARCHABLE_CHARS = 16_000;

/**
 * The searchable text of a transcript item (§6): what was asked and answered, which commands
 * ran and which files were touched. Reasoning, tool output, diffs, todo lists and follow-up
 * chips are left out: they are large or noisy, and the messages around them say what happened.
 * Returns "" when nothing in the item is worth indexing.
 */
export function searchableText(item: Item): string {
  return join(parts(item)).slice(0, MAX_SEARCHABLE_CHARS);
}

function parts(item: Item): Array<string | undefined> {
  switch (item.kind) {
    case "user_message":
      return [item.input.text];
    case "assistant_message":
    case "plan":
      return [item.text];
    case "tool_call":
      return [item.title, ...toolParts(item)];
    case "subagent":
      return [item.agentType, item.description, item.prompt, item.summary];
    case "user_question":
      return [
        ...item.questions.flatMap((q) => [q.header, q.question]),
        ...Object.values(item.answers ?? {}).flat(),
      ];
    case "approval_request":
      return [item.title, item.reason, item.command, ...(item.paths ?? [])];
    case "notice":
      return [item.message];
    case "error":
      return [item.error.message];
    case "reasoning":
    case "todo_list":
    case "followups":
      return [];
  }
}

function toolParts(item: ToolCallItem): Array<string | undefined> {
  switch (item.toolKind) {
    case "command":
      return [item.command];
    case "file_edit":
      return item.changes.flatMap((c) => [c.previousPath, c.path]);
    case "file_read":
      return [item.path];
    case "search":
      return [item.query, item.path];
    case "web":
      return [item.url, item.query];
    case "mcp":
      return [`${item.server} ${item.tool}`];
    case "browser":
      return [item.action, item.url];
    case "other":
      return [item.toolName];
  }
}

/** Distinct, non-empty parts on their own lines (a title often repeats the command). */
function join(values: Array<string | undefined>): string {
  const seen = new Set<string>();
  for (const value of values) {
    const text = typeof value === "string" ? value.trim() : "";
    if (text) seen.add(text);
  }
  return [...seen].join("\n");
}

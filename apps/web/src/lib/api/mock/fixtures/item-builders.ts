import {
  type Attachment,
  type FileChange,
  type Item,
  type ItemOf,
  type MessageSender,
  messageFrom,
  type RoleSender,
  type ToolCallItem,
} from "@codeden/contracts";

/** Terse constructors for transcript fixtures. */

export const user = (id: string, text: string, attachments: Attachment[] = []): Item => ({
  id,
  kind: "user_message",
  status: "completed",
  input: { text, attachments },
});

/** A message from the project's PM or the orchestrator, as the server sends it. */
export const fromRole = (id: string, from: RoleSender, text: string): Item => ({
  id,
  kind: "user_message",
  status: "completed",
  input: messageFrom(from, text),
});

/** A session's opening brief from a PM, the factory or an automation (no sender line). */
export const brief = (id: string, from: MessageSender, text: string): Item => ({
  id,
  kind: "user_message",
  status: "completed",
  input: { text, attachments: [], from },
});

export const assistant = (id: string, text: string, streaming = false): Item => ({
  id,
  kind: "assistant_message",
  status: streaming ? "in_progress" : "completed",
  text,
});

export const thought = (id: string, summary: string, text = summary): Item => ({
  id,
  kind: "reasoning",
  status: "completed",
  summary,
  text,
});

const out = (text: string) => ({ text, truncated: false });

export function cmd(
  id: string,
  command: string,
  output: string,
  exitCode: number | null = 0,
  durationMs = 2400,
): ToolCallItem {
  return {
    id,
    kind: "tool_call",
    toolKind: "command",
    status: exitCode === null ? "in_progress" : exitCode === 0 ? "completed" : "failed",
    toolName: "Bash",
    command,
    output: out(output),
    exitCode,
    durationMs,
  };
}

export const read = (
  id: string,
  path: string,
  startLine?: number,
  endLine?: number,
): ToolCallItem => ({
  id,
  kind: "tool_call",
  toolKind: "file_read",
  status: "completed",
  toolName: "Read",
  path,
  startLine,
  endLine,
});

export const search = (
  id: string,
  query: string,
  matchCount: number,
  path?: string,
): ToolCallItem => ({
  id,
  kind: "tool_call",
  toolKind: "search",
  status: "completed",
  toolName: "Grep",
  query,
  path,
  matchCount,
});

export const edit = (id: string, changes: FileChange[]): ToolCallItem => ({
  id,
  kind: "tool_call",
  toolKind: "file_edit",
  status: "completed",
  toolName: "Edit",
  changes,
});

export const web = (id: string, url: string, title: string): ToolCallItem => ({
  id,
  kind: "tool_call",
  toolKind: "web",
  status: "completed",
  toolName: "WebFetch",
  title,
  url,
});

export const browser = (id: string, action: string, url: string, title: string): ToolCallItem => ({
  id,
  kind: "tool_call",
  toolKind: "browser",
  status: "completed",
  toolName: "browser_navigate",
  title,
  action,
  url,
});

export const mcp = (
  id: string,
  server: string,
  tool: string,
  title: string,
  output?: string,
  input?: Record<string, string | number>,
): ToolCallItem => ({
  id,
  kind: "tool_call",
  toolKind: "mcp",
  status: "completed",
  toolName: `mcp__${server}__${tool}`,
  title,
  server,
  tool,
  input,
  output: output === undefined ? undefined : out(output),
});

export const todos = (
  id: string,
  list: [string, "pending" | "in_progress" | "completed"][],
): ItemOf<"todo_list"> => ({
  id,
  kind: "todo_list",
  status: "completed",
  todos: list.map(([text, status], i) => ({ id: `${id}-${i}`, text, status })),
});

export const followups = (id: string, prompts: [string, string][]): Item => ({
  id,
  kind: "followups",
  status: "completed",
  source: "agent",
  suggestions: prompts.map(([label, prompt]) => ({ label, prompt })),
});

export const notice = (
  id: string,
  message: string,
  level: "info" | "warning" = "info",
  code?: string,
): Item => ({
  id,
  kind: "notice",
  status: "completed",
  level,
  code,
  message,
});

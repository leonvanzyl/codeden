import { randomUUID } from "node:crypto";
import path from "node:path";
import type {
  AgentEvent,
  FileChange,
  ItemStatus,
  ToolCallItem,
  UserInput,
} from "@codeden/contracts";
import { num, shorten, str, toJson, toolOutput } from "../util/text";
import type { OcFileDiff, OcToolContent } from "./protocol";

/**
 * The transcript's record of input CodeDen sent (a prompt or a steer). OpenCode doesn't echo
 * prompts as events, so the session records them itself, with the input as sent: its sender
 * (a PM's or the factory's brief) and attachments included, CodeDen's instructions left out.
 */
export function userMessageEvent(threadId: string, turnId: string, input: UserInput): AgentEvent {
  return {
    type: "item.completed",
    threadId,
    turnId,
    item: { id: `user-${randomUUID()}`, kind: "user_message", status: "completed", input },
  };
}

/** What is known about one tool call while it runs and when it ends. */
export interface ToolState {
  id: string;
  name: string;
  input: Record<string, unknown>;
  status: ItemStatus;
  /** Result text (`content`), error and metadata once the call ended. */
  output?: string;
  error?: string;
  metadata?: Record<string, unknown>;
  /** File diffs from the permission request or the result metadata. */
  diffs?: OcFileDiff[];
  startedAt?: number;
  endedAt?: number;
}

/** Context for mapping: the worktree (diff paths are relative to it) and MCP server names. */
export interface ToolMapContext {
  cwd: string;
  /** Known MCP server names; their tools are named `<server>_<tool>`. */
  mcpServers: readonly string[];
}

/** Text of a tool result's content parts. */
export function contentText(content: readonly OcToolContent[] | undefined): string {
  return (content ?? [])
    .map((c) => (c.type === "text" && typeof c.text === "string" ? c.text : ""))
    .filter(Boolean)
    .join("\n");
}

/** File diffs in permission or tool metadata (`metadata.files`). */
export function diffsOf(metadata: Record<string, unknown> | undefined): OcFileDiff[] | undefined {
  const files = metadata?.files;
  if (!Array.isArray(files)) return undefined;
  const out = files.filter(
    (f): f is OcFileDiff =>
      !!f && typeof f === "object" && typeof (f as OcFileDiff).file === "string",
  );
  return out.length ? out : undefined;
}

function fileChange(diff: OcFileDiff, cwd: string): FileChange {
  const change =
    diff.status === "added"
      ? "add"
      : diff.status === "deleted"
        ? "delete"
        : diff.status === "renamed" || diff.status === "moved"
          ? "rename"
          : "modify";
  return {
    path: path.resolve(cwd, diff.file),
    change,
    ...(diff.patch ? { diff: diff.patch } : {}),
    ...(typeof diff.additions === "number" ? { additions: Math.max(0, diff.additions) } : {}),
    ...(typeof diff.deletions === "number" ? { deletions: Math.max(0, diff.deletions) } : {}),
  };
}

/** Changes of a file tool: its diffs, else what the input names. */
function changesOf(state: ToolState, cwd: string): FileChange[] {
  if (state.diffs?.length) return state.diffs.map((d) => fileChange(d, cwd));
  const target = str(state.input, "path") ?? str(state.input, "filePath");
  if (!target) return [];
  const content = str(state.input, "content");
  return [
    {
      path: path.resolve(cwd, target),
      change: "modify",
      ...(state.name === "write" && content !== undefined
        ? { additions: content.split("\n").filter(Boolean).length }
        : {}),
    },
  ];
}

function mcpParts(
  name: string,
  servers: readonly string[],
): { server: string; tool: string } | undefined {
  const server = [...servers]
    .sort((a, b) => b.length - a.length)
    .find((s) => name.startsWith(`${s}_`) && name.length > s.length + 1);
  return server ? { server, tool: name.slice(server.length + 1) } : undefined;
}

/**
 * An OpenCode tool call as a CodeDen `tool_call` item (§7.3). Returns undefined for tools
 * CodeDen shows another way: `question` (a `user_question`), `subagent` (a `subagent` item
 * with a child thread) and `todowrite` (a `todo_list`).
 */
export function toolCallItem(state: ToolState, ctx: ToolMapContext): ToolCallItem | undefined {
  const { name, input } = state;
  if (name === "question" || name === "subagent" || name === "todowrite") return undefined;
  const base = {
    id: state.id,
    kind: "tool_call" as const,
    status: state.status,
    toolName: name,
    input: toJson(input),
    ...(state.output ? { output: toolOutput(state.output) } : {}),
    ...(state.error ? { error: { message: state.error } } : {}),
    ...(state.startedAt !== undefined && state.endedAt !== undefined
      ? { durationMs: Math.max(0, Math.round(state.endedAt - state.startedAt)) }
      : {}),
  };
  switch (name) {
    case "shell": {
      const command = str(input, "command") ?? "";
      const exit = num(state.metadata, "exit");
      const workdir = str(input, "workdir");
      return {
        ...base,
        toolKind: "command",
        command,
        cwd: workdir ? path.resolve(ctx.cwd, workdir) : ctx.cwd,
        ...(exit !== undefined ? { exitCode: Math.round(exit) } : {}),
        status:
          state.status === "completed" && exit !== undefined && exit !== 0
            ? "failed"
            : state.status,
        title: `Run ${shorten(command, 60)}`,
      };
    }
    case "edit":
    case "write":
    case "patch": {
      const changes = changesOf(state, ctx.cwd);
      const only = changes.length === 1 ? changes[0] : undefined;
      return {
        ...base,
        toolKind: "file_edit",
        changes,
        title: only
          ? `${name === "write" && only.change !== "modify" ? "Create" : "Edit"} ${path.basename(only.path)}`
          : changes.length
            ? `Edit ${changes.length} files`
            : "Edit files",
      };
    }
    case "read": {
      const target = str(input, "path") ?? str(input, "filePath") ?? "";
      const offset = num(input, "offset");
      return {
        ...base,
        toolKind: "file_read",
        path: target ? path.resolve(ctx.cwd, target) : target,
        ...(offset && offset >= 1 ? { startLine: Math.round(offset) } : {}),
        title: `Read ${path.basename(target) || target}`,
      };
    }
    case "grep":
    case "glob": {
      const query = str(input, "pattern") ?? "";
      const where = str(input, "path");
      const matches = num(state.metadata, "matches") ?? num(state.metadata, "count");
      return {
        ...base,
        toolKind: "search",
        query,
        ...(where ? { path: path.resolve(ctx.cwd, where) } : {}),
        ...(matches !== undefined && matches >= 0 ? { matchCount: Math.round(matches) } : {}),
        title: `${name === "glob" ? "Find" : "Search"} ${shorten(query, 60)}`,
      };
    }
    case "webfetch": {
      const url = str(input, "url");
      return {
        ...base,
        toolKind: "web",
        ...(url ? { url } : {}),
        title: `Fetch ${shorten(url ?? "", 60)}`,
      };
    }
    case "websearch": {
      const query = str(input, "query");
      return {
        ...base,
        toolKind: "web",
        ...(query ? { query } : {}),
        title: query ? `Search ${shorten(query, 60)}` : "Web search",
      };
    }
    case "skill":
      return { ...base, toolKind: "other", title: `Skill ${str(input, "id") ?? ""}`.trim() };
    case "execute":
      return { ...base, toolKind: "other", title: "Run code" };
    default: {
      const mcp = mcpParts(name, ctx.mcpServers);
      if (mcp) return { ...base, toolKind: "mcp", ...mcp, title: `${mcp.server}: ${mcp.tool}` };
      return { ...base, toolKind: "other", title: name };
    }
  }
}

/** A subagent result without OpenCode's `<subagent ...>` wrapper. */
export function subagentSummary(text: string): string {
  return text
    .replace(/^\s*<subagent\b[^>]*>\s*/i, "")
    .replace(/\s*<\/subagent>\s*$/i, "")
    .trim();
}

type Todo = { id?: string; text: string; status: "pending" | "in_progress" | "completed" };

/** `todowrite` input -> todo list entries (unknown statuses count as pending). */
export function todosOf(input: Record<string, unknown>): Todo[] | undefined {
  const todos = input.todos;
  if (!Array.isArray(todos)) return undefined;
  return todos
    .map((t, i): Todo | undefined => {
      const text = str(t, "content") ?? str(t, "text");
      if (!text) return undefined;
      const status = str(t, "status");
      return {
        id: str(t, "id") ?? String(i + 1),
        text,
        status: status === "in_progress" || status === "completed" ? status : "pending",
      };
    })
    .filter((t): t is Todo => !!t);
}

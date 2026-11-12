import type { Attachment, FileChange, Item, ItemStatus, ToolCallItem } from "@codeden/contracts";
import { shorten, toJson, toolOutput, unixToIso } from "../util/text";
import { type AgentNames, collabToolCall } from "./collab";
import { saveImageResult } from "./image-result";
import type { ImageGenerationItem } from "./protocol/ImageGenerationItem";
import type { UserInput as CodexUserInput, FileUpdateChange, ThreadItem } from "./protocol/v2";

/** Codex item status -> CodeDen item status. */
export function itemStatus(status: string | undefined): ItemStatus {
  switch (status) {
    case "inProgress":
      return "in_progress";
    case "failed":
      return "failed";
    case "declined":
      return "declined";
    case "interrupted":
      return "cancelled";
    default:
      return "completed";
  }
}

/** Codex user input -> CodeDen `UserInput`. */
export function userInputFromCodex(content: CodexUserInput[]): {
  text: string;
  attachments: Attachment[];
} {
  const text: string[] = [];
  const attachments: Attachment[] = [];
  for (const part of content) {
    if (part.type === "text") text.push(part.text);
    else if (part.type === "localImage") {
      attachments.push({
        type: "image",
        mediaType: mediaTypeFor(part.path),
        source: { type: "path", path: part.path },
      });
    } else if (part.type === "mention" || part.type === "skill") {
      attachments.push({ type: "file", path: part.path, name: part.name });
    }
  }
  return { text: text.join("\n"), attachments };
}

function mediaTypeFor(path: string): "image/png" | "image/jpeg" | "image/gif" | "image/webp" {
  const lower = path.toLowerCase();
  if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) return "image/jpeg";
  if (lower.endsWith(".gif")) return "image/gif";
  if (lower.endsWith(".webp")) return "image/webp";
  return "image/png";
}

function fileChange(change: FileUpdateChange): FileChange {
  let additions = 0;
  let deletions = 0;
  for (const line of change.diff.split("\n")) {
    if (line.startsWith("+") && !line.startsWith("+++")) additions += 1;
    else if (line.startsWith("-") && !line.startsWith("---")) deletions += 1;
  }
  const kind = change.kind;
  const base = { path: change.path, diff: change.diff, additions, deletions };
  if (kind.type === "add")
    return {
      ...base,
      change: "add",
      additions: additions || change.diff.split("\n").filter(Boolean).length,
    };
  if (kind.type === "delete") return { ...base, change: "delete" };
  if (kind.move_path)
    return { ...base, change: "rename", previousPath: change.path, path: kind.move_path };
  return { ...base, change: "modify" };
}

function commandItem(item: Extract<ThreadItem, { type: "commandExecution" }>): ToolCallItem {
  const status = itemStatus(item.status);
  const actions = item.commandActions ?? [];
  const display = actions.length ? actions.map((a) => a.command).join(" && ") : item.command;
  const base = {
    id: item.id,
    kind: "tool_call" as const,
    status:
      status === "completed" && item.exitCode !== null && item.exitCode !== 0
        ? ("failed" as const)
        : status,
    toolName: "shell",
    input: toJson({ command: item.command, commandActions: actions }),
    ...(item.aggregatedOutput !== null ? { output: toolOutput(item.aggregatedOutput) } : {}),
    ...(item.durationMs !== null ? { durationMs: Math.max(0, Math.round(item.durationMs)) } : {}),
  };
  const single = actions.length === 1 ? actions[0] : undefined;
  if (single?.type === "read") {
    return {
      ...base,
      toolKind: "file_read",
      path: single.path,
      title: `Read ${single.name || single.path}`,
    };
  }
  if (single?.type === "search" || single?.type === "listFiles") {
    const query = single.type === "search" ? (single.query ?? single.command) : single.command;
    return {
      ...base,
      toolKind: "search",
      query,
      ...(single.path ? { path: single.path } : {}),
      title: shorten(single.command, 80),
    };
  }
  return {
    ...base,
    toolKind: "command",
    command: display,
    cwd: item.cwd,
    exitCode: item.exitCode,
    title: `Run ${shorten(display, 60)}`,
  };
}

const noNames: AgentNames = () => undefined;

/**
 * Map a Codex `ThreadItem` to a CodeDen item. Returns `undefined` for items CodeDen doesn't show.
 * `names` gives sub-agents' display names for the titles of calls between agents.
 */
export function mapThreadItem(item: ThreadItem, names: AgentNames = noNames): Item | undefined {
  switch (item.type) {
    case "userMessage":
      return {
        id: item.id,
        kind: "user_message",
        status: "completed",
        input: userInputFromCodex(item.content),
      };
    case "agentMessage":
      return { id: item.id, kind: "assistant_message", status: "completed", text: item.text };
    case "reasoning": {
      const text = item.content.join("\n");
      const summary = item.summary.join("\n");
      return {
        id: item.id,
        kind: "reasoning",
        status: "completed",
        text,
        ...(summary ? { summary } : {}),
        ...(!text && !summary ? { redacted: true } : {}),
      };
    }
    case "plan":
      return { id: item.id, kind: "plan", status: "completed", text: item.text };
    case "commandExecution":
      return commandItem(item);
    case "fileChange": {
      const changes = item.changes.map(fileChange);
      const title =
        changes.length === 1
          ? `Edit ${changes[0]?.path.replace(/\\/g, "/").split("/").pop()}`
          : `Edit ${changes.length} files`;
      return {
        id: item.id,
        kind: "tool_call",
        toolKind: "file_edit",
        status: itemStatus(item.status),
        toolName: "apply_patch",
        title,
        changes,
      };
    }
    case "mcpToolCall": {
      const text = item.result ? mcpResultText(item.result.content) : "";
      return {
        id: item.id,
        kind: "tool_call",
        toolKind: "mcp",
        status: itemStatus(item.status),
        toolName: `mcp__${item.server}__${item.tool}`,
        server: item.server,
        tool: item.tool,
        title: `${item.server}: ${item.tool}`,
        input: toJson(item.arguments),
        ...(item.result ? { output: toolOutput(text) } : {}),
        ...(item.error ? { error: { message: item.error.message } } : {}),
        ...(item.durationMs !== null
          ? { durationMs: Math.max(0, Math.round(item.durationMs)) }
          : {}),
      };
    }
    case "dynamicToolCall":
      return {
        id: item.id,
        kind: "tool_call",
        toolKind: "other",
        status: itemStatus(item.status),
        toolName: item.tool,
        title: item.tool,
        input: toJson(item.arguments),
      };
    case "collabAgentToolCall":
      // Spawns never get here: the thread mapper turns them into `subagent` items.
      return collabToolCall(item, itemStatus(item.status), names);
    case "webSearch": {
      const action = item.action;
      const url = action && "url" in action ? (action.url ?? undefined) : undefined;
      return {
        id: item.id,
        kind: "tool_call",
        toolKind: "web",
        status: "completed",
        toolName: "web_search",
        title: item.query ? `Search ${shorten(item.query, 60)}` : "Web search",
        query: item.query,
        ...(url ? { url } : {}),
      };
    }
    case "imageView":
      return {
        id: item.id,
        kind: "tool_call",
        toolKind: "file_read",
        status: "completed",
        toolName: "view_image",
        title: `View ${item.path}`,
        path: item.path,
      };
    case "imageGeneration":
      return imageGenerationItem(item);
    case "contextCompaction":
      return {
        id: item.id,
        kind: "notice",
        status: "completed",
        level: "info",
        code: "context_compacted",
        message: "Context compacted",
      };
    case "enteredReviewMode":
    case "exitedReviewMode":
      return {
        id: item.id,
        kind: "notice",
        status: "completed",
        level: "info",
        code: item.type,
        message: item.review,
      };
    default:
      return undefined;
  }
}

/**
 * Codex's built-in image generation. `result` holds the whole image base64-encoded (megabytes),
 * so it never goes into the item: the image is the file Codex saved (`savedPath`), or a copy
 * CodeDen writes when Codex saved none, which the server stores as an artifact and shows inline.
 */
function imageGenerationItem(item: ImageGenerationItem): ToolCallItem {
  let failure = imageGenerationFailure(item);
  let file = item.savedPath;
  if (!failure && !file && item.status === "completed" && item.result) {
    const saved = saveImageResult(item.id, item.result);
    if ("path" in saved) file = saved.path;
    else failure = saved.error;
  }
  const prompt = item.revisedPrompt?.trim();
  return {
    id: item.id,
    kind: "tool_call",
    toolKind: "other",
    status: failure ? "failed" : itemStatus(item.status),
    toolName: "image_generation",
    title: "Generate image",
    input: toJson({
      revisedPrompt: item.revisedPrompt,
      savedPath: file,
      transparentBackground: item.transparentBackground,
    }),
    ...(failure ? { error: { message: failure } } : {}),
    ...(!failure && file
      ? { generatedImages: [{ path: file, ...(prompt ? { caption: prompt } : {}) }] }
      : {}),
  };
}

/** Why an image generation failed, or `undefined` when it didn't. */
function imageGenerationFailure(item: ImageGenerationItem): string | undefined {
  if (item.failure?.type === "usageLimitExceeded") {
    const resets = unixToIso(item.failure.resetsAt);
    return `Codex image generation limit reached${resets ? ` (resets ${resets})` : ""}`;
  }
  if (item.failure || item.status === "failed") return "Codex image generation failed";
  if (item.status === "completed" && !item.result && !item.savedPath) {
    return "Codex finished without an image";
  }
  return undefined;
}

function mcpResultText(content: unknown[]): string {
  return content
    .map((c) =>
      c && typeof c === "object" && (c as { type?: string }).type === "text"
        ? String((c as { text?: unknown }).text ?? "")
        : "",
    )
    .filter(Boolean)
    .join("\n");
}

/** The in-progress shape of an item when it starts (status forced to in_progress). */
export function startedItem(item: ThreadItem, names: AgentNames = noNames): Item | undefined {
  const mapped = mapThreadItem(item, names);
  if (!mapped || mapped.kind === "user_message" || mapped.kind === "notice") return mapped;
  return { ...mapped, status: "in_progress" } as Item;
}

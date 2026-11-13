import { readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type {
  FileChange,
  GeneratedImage,
  ItemStatus,
  ToolCallItem,
  UserInput,
} from "@codeden/contracts";
import { num, shorten, str, toJson, toolOutput } from "../util/text";
import type { AcpContentBlock, AcpToolCall, AcpToolContent } from "./protocol";

/** What is known about one tool call: the merged `tool_call` and `tool_call_update`s. */
export interface AcpToolState extends AcpToolCall {
  /** The tool's name, when the agent reports one (later protocol drafts). */
  name?: string;
  startedAt?: number;
  endedAt?: number;
  /** Images the call created, reported by a vendor extension (e.g. Cursor's image generation). */
  generatedImages?: GeneratedImage[];
}

/** Context for mapping: the worktree (relative paths resolve against it) and MCP server names. */
export interface AcpToolContext {
  cwd: string;
  mcpServers: readonly string[];
}

/** Merge a `tool_call_update` into what is known: given fields replace, `null` clears. */
export function mergeToolCall(state: AcpToolState, patch: AcpToolCall & { name?: unknown }) {
  for (const key of ["title", "kind", "status", "content", "locations"] as const) {
    if (patch[key] !== undefined) (state as unknown as Record<string, unknown>)[key] = patch[key];
  }
  if (patch.rawInput !== undefined) state.rawInput = patch.rawInput;
  if (patch.rawOutput !== undefined) state.rawOutput = patch.rawOutput;
  if (typeof patch.name === "string" && patch.name) state.name = patch.name;
}

/** The text of a content block (text blocks only). */
export function blockText(block: AcpContentBlock | undefined): string {
  return block?.type === "text" && typeof block.text === "string" ? block.text : "";
}

/** The text a tool call produced: its text content, else what its raw output carries. */
export function toolText(state: AcpToolState): string {
  const parts = (state.content ?? [])
    .map((c: AcpToolContent) =>
      c.type === "content" ? blockText(c.content as AcpContentBlock) : "",
    )
    .filter(Boolean);
  if (parts.length) return parts.join("\n");
  const raw = state.rawOutput;
  if (typeof raw === "string") return raw;
  const out = str(raw, "output") ?? str(raw, "stdout") ?? str(raw, "content") ?? str(raw, "text");
  const err = str(raw, "stderr");
  return [out, err].filter(Boolean).join("\n");
}

/** The command an `execute` call runs: its raw input, else its title. */
export function commandOf(state: Pick<AcpToolCall, "rawInput" | "title">): string {
  const input = state.rawInput;
  const command = (input as Record<string, unknown> | undefined)?.command;
  if (Array.isArray(command)) return command.map(String).join(" ");
  if (typeof command === "string") return command;
  const cmd = str(input, "cmd") ?? str(input, "script");
  return cmd ?? (state.title ?? "").replace(/^`(.*)`$/s, "$1");
}

/** The folder an `execute` call runs in (its raw input's `cwd`), else the worktree. */
export function workdirOf(state: Pick<AcpToolCall, "rawInput">, cwd: string): string {
  const dir = str(state.rawInput, "cwd") ?? str(state.rawInput, "workdir");
  return dir ? path.resolve(cwd, dir) : cwd;
}

/** Every path a tool call names: its locations, diffs and the usual raw-input fields. */
export function pathsOf(state: AcpToolCall, cwd: string): string[] {
  const found: string[] = [];
  for (const loc of state.locations ?? []) if (loc?.path) found.push(loc.path);
  for (const c of state.content ?? []) {
    if (c.type === "diff" && typeof c.path === "string") found.push(c.path);
  }
  for (const key of ["path", "file_path", "filePath", "target", "destination", "source"]) {
    const value = str(state.rawInput, key);
    if (value) found.push(value);
  }
  return [...new Set(found.map((p) => path.resolve(cwd, p)))];
}

const lines = (text: string | null | undefined) =>
  text ? text.split("\n").filter((l, i, all) => l !== "" || i < all.length - 1).length : 0;

/** File changes of an edit call: its diffs, else the paths it names. */
function changesOf(state: AcpToolState, cwd: string): FileChange[] {
  const kind = state.kind;
  const diffs = (state.content ?? []).filter(
    (c): c is { type: "diff"; path: string; oldText?: string | null; newText: string } =>
      c.type === "diff" && typeof c.path === "string",
  );
  if (diffs.length) {
    return diffs.map((d) => {
      const added = d.oldText === null || d.oldText === undefined;
      return {
        path: path.resolve(cwd, d.path),
        change: kind === "delete" ? "delete" : added ? "add" : "modify",
        ...(added ? { additions: lines(d.newText) } : {}),
      };
    });
  }
  const change: FileChange["change"] =
    kind === "delete" ? "delete" : kind === "move" ? "rename" : "modify";
  return pathsOf(state, cwd).map((p) => ({ path: p, change }));
}

/** `<server>__<tool>`, `<server>-<tool>`, `<server>: <tool>` and similar, for known servers. */
function mcpParts(
  name: string,
  servers: readonly string[],
): { server: string; tool: string } | undefined {
  const clean = name.replace(/^mcp(__|_|:|\/)/i, "");
  for (const server of [...servers].sort((a, b) => b.length - a.length)) {
    const m = new RegExp(`^${escapeRegExp(server)}(?:__|_|-|:\\s*|/|\\.)(.+)$`, "i").exec(clean);
    if (m?.[1]) return { server, tool: m[1].trim() };
  }
  return undefined;
}

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * ACP's own tool kinds. A call of one of these kinds is that kind of call (a command, an edit,
 * a read, ...) whatever its name or title says, so it is never taken for an MCP tool.
 */
const BUILTIN_KINDS: ReadonlySet<string> = new Set([
  "read",
  "edit",
  "delete",
  "move",
  "search",
  "execute",
  "think",
  "fetch",
  "switch_mode",
]);

/**
 * The MCP server and tool a call belongs to, when it names one of `servers`. Only calls of kind
 * `other` (or no kind, or a custom `_kind`) can be MCP calls: the agent writes the name and the
 * title, so a command titled `codeden-x; rm -rf ~` stays a command.
 */
export function mcpOf(state: AcpToolState, servers: readonly string[]) {
  if (typeof state.kind === "string" && BUILTIN_KINDS.has(state.kind)) return undefined;
  const server = str(state.rawInput, "server") ?? str(state.rawInput, "serverName");
  const tool = str(state.rawInput, "tool") ?? str(state.rawInput, "toolName");
  if (server && tool && servers.includes(server)) return { server, tool };
  for (const label of [state.name, state.title]) {
    const parts = label ? mcpParts(label, servers) : undefined;
    if (parts) return parts;
  }
  return undefined;
}

function itemStatus(status: AcpToolState["status"]): ItemStatus {
  if (status === "completed") return "completed";
  if (status === "failed") return "failed";
  return "in_progress";
}

/** An ACP tool call as a CodeDen `tool_call` item (§7.3), under the item id `id`. */
export function toolCallItem(
  state: AcpToolState,
  ctx: AcpToolContext,
  id: string = state.toolCallId,
): ToolCallItem {
  const output = toolText(state);
  const title = state.title?.trim() || undefined;
  const base = {
    id,
    kind: "tool_call" as const,
    status: itemStatus(state.status),
    toolName: state.name || (typeof state.kind === "string" ? state.kind : "") || "tool",
    ...(state.rawInput !== undefined ? { input: toJson(state.rawInput) } : {}),
    ...(output ? { output: toolOutput(output) } : {}),
    ...(state.status === "failed" ? { error: { message: shorten(output || "Failed", 500) } } : {}),
    ...(state.startedAt !== undefined && state.endedAt !== undefined
      ? { durationMs: Math.max(0, Math.round(state.endedAt - state.startedAt)) }
      : {}),
    ...(state.generatedImages?.length ? { generatedImages: state.generatedImages } : {}),
  };
  switch (state.kind) {
    case "execute": {
      const command = commandOf(state);
      const exit = num(state.rawOutput, "exitCode") ?? num(state.rawOutput, "exit_code");
      return {
        ...base,
        toolKind: "command",
        command,
        cwd: workdirOf(state, ctx.cwd),
        ...(exit !== undefined ? { exitCode: Math.round(exit) } : {}),
        title: title ?? `Run ${shorten(command, 60)}`,
      };
    }
    case "edit":
    case "delete":
    case "move": {
      const changes = changesOf(state, ctx.cwd);
      const only = changes.length === 1 ? changes[0] : undefined;
      const fallback = only
        ? `${only.change === "add" ? "Create" : only.change === "delete" ? "Delete" : "Edit"} ${path.basename(only.path)}`
        : `Edit ${changes.length || ""} files`.replace("  ", " ");
      return { ...base, toolKind: "file_edit", changes, title: title ?? fallback };
    }
    case "read": {
      const target = pathsOf(state, ctx.cwd)[0] ?? "";
      const line = state.locations?.[0]?.line;
      return {
        ...base,
        toolKind: "file_read",
        path: target,
        ...(typeof line === "number" && line >= 1 ? { startLine: Math.round(line) } : {}),
        title: title ?? `Read ${path.basename(target) || "file"}`,
      };
    }
    case "search": {
      const query =
        str(state.rawInput, "pattern") ??
        str(state.rawInput, "query") ??
        str(state.rawInput, "glob") ??
        title ??
        "";
      const where = str(state.rawInput, "path");
      return {
        ...base,
        toolKind: "search",
        query,
        ...(where ? { path: path.resolve(ctx.cwd, where) } : {}),
        title: title ?? `Search ${shorten(query, 60)}`,
      };
    }
    case "fetch": {
      const url = str(state.rawInput, "url");
      const query = str(state.rawInput, "query");
      return {
        ...base,
        toolKind: "web",
        ...(url ? { url } : {}),
        ...(query ? { query } : {}),
        title: title ?? (url ? `Fetch ${shorten(url, 60)}` : "Web search"),
      };
    }
    default: {
      const mcp = mcpOf(state, ctx.mcpServers);
      if (mcp) return { ...base, toolKind: "mcp", ...mcp, title: `${mcp.server}: ${mcp.tool}` };
      return { ...base, toolKind: "other", title: title ?? base.toolName };
    }
  }
}

/** CodeDen's role prompt in front of a message (ACP sessions take no system prompt). */
export function withInstructions(input: UserInput, text: string | undefined): UserInput {
  if (!text) return input;
  return { ...input, text: `<instructions>\n${text}\n</instructions>\n\n${input.text}` };
}

/**
 * CodeDen input as ACP prompt content. Images go inline (base64) when the agent takes them;
 * files and images it can't take go as links to the file.
 */
export function promptBlocks(input: UserInput, images: boolean): AcpContentBlock[] {
  const blocks: AcpContentBlock[] = [{ type: "text", text: input.text }];
  for (const attachment of input.attachments) {
    if (attachment.type === "file") {
      blocks.push(link(attachment.path, attachment.name, attachment.mediaType));
      continue;
    }
    const source = attachment.source;
    if (source.type === "artifact") {
      throw new Error("Artifact attachments must be resolved to a path or base64 before sending");
    }
    if (!images) {
      if (source.type === "path") blocks.push(link(source.path, attachment.name));
      continue;
    }
    const data =
      source.type === "base64" ? source.data : readFileSync(source.path).toString("base64");
    blocks.push({ type: "image", mimeType: attachment.mediaType, data });
  }
  return blocks;
}

function link(file: string, name?: string, mimeType?: string): AcpContentBlock {
  return {
    type: "resource_link",
    uri: pathToFileURL(file).href,
    name: name ?? path.basename(file),
    ...(mimeType ? { mimeType } : {}),
  };
}

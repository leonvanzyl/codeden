import type { ApprovalAction, FileChange, ItemStatus, ToolCallItem } from "@codeden/contracts";
import {
  classifyCommand,
  classifyFetch,
  classifyRead,
  classifyWrite,
  type RiskAssessment,
  type RiskContext,
} from "../policy/risk";
import { num, shorten, str, toJson, toolOutput } from "../util/text";

/** Claude tools that are not rendered as `tool_call` items. */
export const SUBAGENT_TOOLS = new Set(["Agent", "Task"]);
export const TODO_TOOL = "TodoWrite";
export const QUESTION_TOOL = "AskUserQuestion";
export const PLAN_TOOL = "ExitPlanMode";
/** Tools whose calls CodeDen renders as something other than a tool call. */
export function isSpecialTool(name: string): boolean {
  return (
    SUBAGENT_TOOLS.has(name) || name === TODO_TOOL || name === QUESTION_TOOL || name === PLAN_TOOL
  );
}

export const COMMAND_TOOLS = new Set(["Bash", "PowerShell"]);
export const EDIT_TOOLS = new Set(["Edit", "MultiEdit", "Write", "NotebookEdit"]);

type Input = Record<string, unknown>;

/** `mcp__server__tool` -> `{ server, tool }`. */
export function parseMcpName(name: string): { server: string; tool: string } | undefined {
  const m = /^mcp__(.+?)__(.+)$/.exec(name);
  return m?.[1] && m[2] ? { server: m[1], tool: m[2] } : undefined;
}

/** The file an edit tool writes (`file_path`, `notebook_path` or `path`), or "". */
export function editPath(input: Input): string {
  return str(input, "file_path") ?? str(input, "notebook_path") ?? str(input, "path") ?? "";
}

/** Build a `tool_call` item for a Claude `tool_use` block. */
export function toolCallItem(
  id: string,
  name: string,
  input: Input,
  cwd: string,
  status: ItemStatus = "in_progress",
): ToolCallItem {
  const base = { id, kind: "tool_call" as const, status, toolName: name, input: toJson(input) };
  if (COMMAND_TOOLS.has(name)) {
    const command = str(input, "command") ?? "";
    const title = str(input, "description") ?? (command ? `Run ${shorten(command, 60)}` : name);
    return { ...base, toolKind: "command", command, cwd, title };
  }
  if (EDIT_TOOLS.has(name)) {
    const path = editPath(input);
    return {
      ...base,
      toolKind: "file_edit",
      title: path ? `${name === "Write" ? "Write" : "Edit"} ${baseName(path)}` : name,
      changes: path ? [{ path, change: "modify" }] : [],
    };
  }
  if (name === "Read") {
    const path = str(input, "file_path") ?? "";
    const offset = num(input, "offset");
    const limit = num(input, "limit");
    const startLine = offset && offset > 0 ? Math.floor(offset) : undefined;
    const endLine = startLine && limit && limit > 0 ? startLine + Math.floor(limit) - 1 : undefined;
    return {
      ...base,
      toolKind: "file_read",
      path,
      startLine,
      endLine,
      title: `Read ${baseName(path)}`,
    };
  }
  if (name === "Grep" || name === "Glob") {
    const query = str(input, "pattern") ?? "";
    return {
      ...base,
      toolKind: "search",
      query,
      path: str(input, "path"),
      title: `${name} ${shorten(query, 60)}`,
    };
  }
  if (name === "WebFetch") {
    const url = str(input, "url");
    return { ...base, toolKind: "web", url, title: url ? `Fetch ${url}` : name };
  }
  if (name === "WebSearch") {
    const query = str(input, "query");
    return {
      ...base,
      toolKind: "web",
      query,
      title: query ? `Search ${shorten(query, 60)}` : name,
    };
  }
  const mcp = parseMcpName(name);
  if (mcp) {
    if (/browser|playwright|chrome|puppeteer/i.test(mcp.server)) {
      return {
        ...base,
        toolKind: "browser",
        action: mcp.tool,
        url: str(input, "url"),
        title: `${mcp.server}: ${mcp.tool}`,
      };
    }
    return {
      ...base,
      toolKind: "mcp",
      server: mcp.server,
      tool: mcp.tool,
      title: `${mcp.server}: ${mcp.tool}`,
    };
  }
  return { ...base, toolKind: "other", title: name };
}

function baseName(p: string): string {
  return p.replace(/\\/g, "/").split("/").pop() || p;
}

/** Text of a `tool_result` block's content (string or content-block array). */
export function toolResultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((block) =>
        block && typeof block === "object" && str(block, "type") === "text"
          ? (str(block, "text") ?? "")
          : "",
      )
      .filter(Boolean)
      .join("\n");
  }
  return "";
}

interface PatchHunk {
  oldStart?: number;
  newStart?: number;
  oldLines?: number;
  newLines?: number;
  lines?: string[];
}

/** Turn the CLI's `structuredPatch` hunks into unified diff text and line counts. */
function patchToDiff(
  path: string,
  hunks: PatchHunk[],
): Pick<FileChange, "diff" | "additions" | "deletions"> {
  let additions = 0;
  let deletions = 0;
  const out = [`--- a/${path}`, `+++ b/${path}`];
  for (const h of hunks) {
    out.push(`@@ -${h.oldStart ?? 0},${h.oldLines ?? 0} +${h.newStart ?? 0},${h.newLines ?? 0} @@`);
    for (const line of h.lines ?? []) {
      if (line.startsWith("+")) additions += 1;
      else if (line.startsWith("-")) deletions += 1;
      out.push(line);
    }
  }
  return { diff: out.join("\n"), additions, deletions };
}

/** Final state of a tool call once its `tool_result` arrived. */
export function completeToolCall(
  item: ToolCallItem,
  result: { content: unknown; isError: boolean; toolUseResult?: unknown; durationMs?: number },
): ToolCallItem {
  const text = toolResultText(result.content);
  const status: ItemStatus = result.isError
    ? /denied|declined|rejected|doesn't want/i.test(text)
      ? "declined"
      : "failed"
    : "completed";
  const done: ToolCallItem = {
    ...item,
    status,
    output: toolOutput(text),
    ...(result.isError ? { error: { message: shorten(text, 300) || "Tool failed" } } : {}),
    ...(result.durationMs !== undefined
      ? { durationMs: Math.max(0, Math.round(result.durationMs)) }
      : {}),
  };
  const tur = result.toolUseResult;
  if (done.toolKind === "file_edit" && tur && typeof tur === "object" && !result.isError) {
    const path = str(tur, "filePath") ?? done.changes[0]?.path ?? "";
    const type = str(tur, "type");
    const hunks = (tur as { structuredPatch?: PatchHunk[] }).structuredPatch;
    const change: FileChange = {
      path,
      change: type === "create" ? "add" : "modify",
      ...(Array.isArray(hunks) && hunks.length > 0 ? patchToDiff(path, hunks) : {}),
    };
    if (type === "create" && (!hunks || hunks.length === 0)) {
      const content = str(tur, "content") ?? "";
      const lines = content.split(/\r?\n/);
      change.additions = content ? lines.length : 0;
      change.diff = [
        `--- /dev/null`,
        `+++ b/${path}`,
        `@@ -0,0 +1,${lines.length} @@`,
        ...lines.map((l) => `+${l}`),
      ].join("\n");
    }
    return { ...done, changes: [change] };
  }
  if (done.toolKind === "command" && tur && typeof tur === "object") {
    const interrupted = (tur as { interrupted?: boolean }).interrupted;
    if (interrupted) return { ...done, status: "cancelled" };
  }
  return done;
}

/** Risk of a Claude tool call under the `auto` policy (§11.2). */
export function assessClaudeTool(name: string, input: Input, ctx: RiskContext): RiskAssessment {
  if (COMMAND_TOOLS.has(name)) {
    // The Bash tool is a POSIX shell (Git Bash on Windows).
    const shell = name === "PowerShell" ? "powershell" : "posix";
    return classifyCommand(str(input, "command") ?? "", { ...ctx, shell });
  }
  if (EDIT_TOOLS.has(name)) return classifyWrite(editPath(input), ctx);
  if (name === "Read") return classifyRead(str(input, "file_path") ?? "", ctx);
  // Grep reads the files under `path`; its `pattern` and `glob` are not files. Glob only lists
  // names, so it never reads a secret.
  if (name === "Grep") {
    const target = str(input, "path");
    return target ? classifyRead(target, ctx) : { risky: false };
  }
  if (name === "Glob") return { risky: false };
  if (name === "WebFetch") return classifyFetch(str(input, "url") ?? "", ctx);
  return { risky: false };
}

/** The approval category for a tool call that is not otherwise risky. */
export function defaultApprovalAction(name: string): ApprovalAction {
  if (COMMAND_TOOLS.has(name)) return "command";
  if (EDIT_TOOLS.has(name)) return "file_change";
  if (name === "WebFetch" || name === "WebSearch") return "network";
  return "tool";
}

/** Human title for an approval request. */
export function approvalTitle(name: string, input: Input): string {
  if (COMMAND_TOOLS.has(name)) return `Run \`${shorten(str(input, "command") ?? name, 100)}\``;
  if (EDIT_TOOLS.has(name))
    return `${name === "Write" ? "Write" : "Edit"} ${editPath(input) || "a file"}`;
  if (name === PLAN_TOOL) return "Approve the plan and start implementing";
  if (name === "WebFetch") return `Fetch ${str(input, "url") ?? "a URL"}`;
  if (name === "Read") return `Read ${str(input, "file_path") ?? "a file"}`;
  const mcp = parseMcpName(name);
  if (mcp) return `Use ${mcp.server}: ${mcp.tool}`;
  return `Use ${name}`;
}

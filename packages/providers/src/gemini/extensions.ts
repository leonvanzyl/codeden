import { readFileSync, statSync } from "node:fs";
import path from "node:path";
import type { ItemOf, RuntimeResponse } from "@codeden/contracts";
import { approvalItem, select } from "../acp/approvals";
import type { AcpExtensionHost, AcpExtensions } from "../acp/extensions";
import { type AcpToolFacts, type AcpToolState, blockText } from "../acp/items";
import type {
  AcpContentBlock,
  AcpPermissionRequest,
  AcpPermissionResult,
  AcpToolCall,
} from "../acp/protocol";
import { geminiDir } from "./auth";

/** The title Gemini CLI gives its `exit_plan_mode` permission request: the plan file follows. */
const PLAN_APPROVAL = /^Requesting plan approval for:\s*(.+?)\s*$/s;
/** The folder detail Gemini CLI puts in a shell command's content: `[in <dir>] (why)`. */
const COMMAND_DIR = /^\[in (.+?)\](?=\s|$)/;
const MAX_PLAN_BYTES = 256 * 1024;
const CANCELLED: AcpPermissionResult = { outcome: { outcome: "cancelled" } };

/**
 * How CodeDen reads Gemini CLI beyond ACP itself:
 * - `toolCall`: the MCP server and tool its permission requests name in
 *   `_meta["gemini-cli"].mcp` (its titles are just the tool's name), and the folder a shell
 *   command runs in (`[in <dir>]` in the call's content), so the classifier judges it there.
 * - `permission`: in plan mode, its `exit_plan_mode` request becomes CodeDen's plan approval.
 *   Gemini CLI never reports leaving plan mode on its own, and its plan tools are of kind
 *   `other`, so any other unidentified tool it asks about while planning goes to the user.
 */
export const geminiExtensions: AcpExtensions = {
  toolCall: geminiToolFacts,
  permission(req, call, host) {
    if (!host.planning) return undefined;
    const kind = typeof call.kind === "string" && call.kind ? call.kind : "other";
    // Builtin kinds and MCP calls are CodeDen's policy's to judge, as in any session.
    if (kind !== "other" || call.mcp) return undefined;
    const plan = PLAN_APPROVAL.exec(call.title ?? "")?.[1];
    return plan ? approvePlan(req, call, plan, host) : askWhilePlanning(req, call, host);
  },
};

/** What Gemini CLI's own fields say about a tool call. */
export function geminiToolFacts(call: AcpToolCall): AcpToolFacts | undefined {
  const facts: AcpToolFacts = {};
  const vendor = (call._meta?.["gemini-cli"] ?? undefined) as
    | { mcp?: { server_name?: unknown; tool_name?: unknown } }
    | undefined;
  const server = vendor?.mcp?.server_name;
  const tool = vendor?.mcp?.tool_name;
  if (typeof server === "string" && server && typeof tool === "string" && tool) {
    facts.mcp = { server, tool };
  }
  if (call.kind === "execute") {
    for (const c of call.content ?? []) {
      if (c.type !== "content") continue;
      const dir = COMMAND_DIR.exec(blockText(c.content as AcpContentBlock).trim())?.[1];
      if (dir) {
        facts.cwd = dir;
        break;
      }
    }
  }
  return facts.mcp || facts.cwd ? facts : undefined;
}

/**
 * Gemini CLI's finished plan: shown as a plan, then CodeDen's plan approval. Approving leaves
 * plan mode for the session's level and lets `exit_plan_mode` run (Gemini CLI then works in its
 * `default` mode, asking before edits and commands). Declining keeps it planning; ACP can't carry
 * the user's note, so the card says to send it as the next message.
 */
async function approvePlan(
  req: AcpPermissionRequest,
  call: AcpToolState,
  planFile: string,
  host: AcpExtensionHost,
): Promise<AcpPermissionResult> {
  const ctx = host.ctx();
  if (!ctx) return CANCELLED;
  const planId = host.mapper.toolItemId(`plan-${call.toolCallId || "gemini"}`);
  const item: ItemOf<"plan"> = {
    id: planId,
    kind: "plan",
    status: "completed",
    text: readPlan(planFile, host.cwd),
  };
  host.mapper.emitItem(item);
  const requestId = `plan-${call.toolCallId || "gemini"}-${Math.random().toString(36).slice(2, 8)}`;
  const response = await host.broker.request(ctx, {
    id: `approval-${requestId}`,
    kind: "approval_request",
    status: "in_progress",
    requestId,
    action: "plan",
    title: "Implement the plan",
    reason:
      "Gemini CLI finished planning. Declining keeps it planning: send what to change as your next message.",
    toolName: "exit_plan_mode",
    toolCallItemId: planId,
    options: ["allow_once", "deny"],
  });
  if (response.kind === "approval" && response.decision !== "deny") {
    await host.exitPlanMode();
    return select(req.options, "allow");
  }
  return answer(req, response);
}

/** A tool CodeDen can't identify while planning: the user decides, at every level. */
async function askWhilePlanning(
  req: AcpPermissionRequest,
  call: AcpToolState,
  host: AcpExtensionHost,
): Promise<AcpPermissionResult> {
  const ctx = host.ctx();
  if (!ctx) return CANCELLED;
  const item = approvalItem(
    call,
    { kind: "ask", action: "other", reason: "Plan mode: Gemini CLI asks before this tool" },
    { cwd: host.cwd, mcpServers: [] },
    host.mapper.toolItemId(call.toolCallId),
  );
  return answer(req, await host.broker.request(ctx, item));
}

function answer(req: AcpPermissionRequest, response: RuntimeResponse): AcpPermissionResult {
  if (response.kind !== "approval") return CANCELLED;
  return select(req.options, response.decision === "deny" ? "reject" : "allow");
}

/**
 * The plan's markdown: a `.md` file of at most 256 KB in the worktree or Gemini CLI's own
 * folder (where it keeps plans). Anything else is named, not read.
 */
export function readPlan(file: string, cwd: string): string {
  const resolved = path.resolve(cwd, file);
  const named = `Gemini CLI's plan is in \`${resolved}\`.`;
  if (!/\.md$/i.test(resolved)) return named;
  if (!within(resolved, cwd) && !within(resolved, geminiDir())) return named;
  try {
    if (statSync(resolved).size > MAX_PLAN_BYTES) return named;
    return readFileSync(resolved, "utf8").trim() || named;
  } catch {
    return named;
  }
}

function within(file: string, dir: string): boolean {
  const rel = path.relative(dir, file);
  return !!rel && !rel.startsWith("..") && !path.isAbsolute(rel);
}

import type { ItemOf } from "@codeden/contracts";
import type { ApprovalBroker } from "../approvals";
import { shorten, toJson } from "../util/text";
import { type AcpToolState, commandOf, mcpOf, pathsOf, workdirOf } from "./items";
import type { AcpEventMapper } from "./mapper";
import type { AcpPolicy, AcpPolicyDecision } from "./policy";
import { WRITE_KINDS } from "./policy";
import type { AcpPermissionOption, AcpPermissionRequest, AcpPermissionResult } from "./protocol";

/** What answering a permission request needs from the session. */
export interface AcpApprovalDeps {
  broker: ApprovalBroker;
  policy: AcpPolicy;
  mapper: AcpEventMapper;
  cwd: string;
  mcpServers: readonly string[];
  trustedServers: readonly string[];
  /** The agent's own answer to this request (`AcpExtensions.permission`), if it has one. */
  own?: (call: AcpToolState) => Promise<AcpPermissionResult> | undefined;
}

const CANCELLED: AcpPermissionResult = { outcome: { outcome: "cancelled" } };

/**
 * Answer `session/request_permission` (§11.2): CodeDen's policy approves or refuses the call
 * on the spot (recorded in the transcript as decided by policy), or it becomes an
 * `approval_request` the user answers. Only "once" options are ever chosen: an agent's
 * "always" option saves a rule in the agent's own settings, so `allow_session` is remembered by
 * CodeDen for this session instead. A cancelled turn answers `cancelled`, as ACP requires.
 */
export async function answerPermission(
  req: AcpPermissionRequest,
  deps: AcpApprovalDeps,
): Promise<AcpPermissionResult> {
  const call = deps.mapper.tool(req.toolCall ?? { toolCallId: "" });
  const ctx = deps.mapper.ctx();
  if (!ctx) return CANCELLED;
  const own = deps.own?.(call);
  if (own) return own;
  const decision = deps.policy.decide(call);
  const item = approvalItem(call, decision, deps, deps.mapper.toolItemId(call.toolCallId));
  const trusted = decision.kind === "allow" && isTrustedCall(call, deps);
  if (decision.kind === "allow") {
    if (!trusted) {
      deps.broker.record(ctx, {
        ...item,
        status: "completed",
        reason: `Allowed by the ${levelName(deps.policy.level)} permission level`,
        decision: "allow_once",
        decidedBy: "policy",
      });
    }
    return select(req.options, "allow");
  }
  if (decision.kind === "deny") {
    deps.broker.record(ctx, {
      ...item,
      status: "declined",
      reason: decision.message,
      decision: "deny",
      decidedBy: "policy",
    });
    return select(req.options, "reject");
  }
  const response = await deps.broker.request(ctx, item);
  if (response.kind === "approval" && response.decision !== "deny") {
    if (response.decision === "allow_session") deps.policy.allowForSession(call);
    return select(req.options, "allow");
  }
  if (response.kind === "approval") return select(req.options, "reject");
  return CANCELLED;
}

/**
 * The "once" option of a kind: allow or reject. Never an "always" option, which would save a
 * rule in the agent's own settings: without a "once" option to allow with, the call is
 * refused once, and without any "once" option the request is answered `cancelled`.
 */
export function select(
  options: readonly AcpPermissionOption[],
  want: "allow" | "reject",
): AcpPermissionResult {
  const list = Array.isArray(options) ? options : [];
  const option =
    list.find((o) => o.kind === `${want}_once`) ?? list.find((o) => o.kind === "reject_once");
  return option ? { outcome: { outcome: "selected", optionId: option.optionId } } : CANCELLED;
}

/**
 * A call to CodeDen's own MCP tools: allowed silently, never recorded as a decision. Only calls
 * of kind `other` qualify (`mcpOf`), never a command or an edit titled like one.
 */
function isTrustedCall(call: AcpToolState, deps: AcpApprovalDeps): boolean {
  const mcp = mcpOf(call, deps.mcpServers);
  return mcp !== undefined && deps.trustedServers.includes(mcp.server);
}

function levelName(level: string): string {
  return level === "full" ? "Full" : level === "supervised" ? "Supervised" : "Auto";
}

/** The approval card for a permission request. */
export function approvalItem(
  call: AcpToolState,
  decision: AcpPolicyDecision,
  deps: Pick<AcpApprovalDeps, "cwd" | "mcpServers">,
  /** The `tool_call` item the request gates. */
  toolItemId?: string,
): ItemOf<"approval_request"> {
  const requestId = `perm-${call.toolCallId || "call"}-${Math.random().toString(36).slice(2, 8)}`;
  const base = {
    id: `approval-${requestId}`,
    kind: "approval_request" as const,
    status: "in_progress" as const,
    requestId,
    action: decision.kind === "ask" ? decision.action : actionOf(call),
    ...(decision.kind === "ask" ? { reason: decision.reason } : {}),
    toolName: call.name || String(call.kind ?? "tool"),
    ...(call.rawInput !== undefined ? { toolInput: toJson(call.rawInput) } : {}),
    ...(call.toolCallId && toolItemId ? { toolCallItemId: toolItemId } : {}),
    options: ["allow_once", "allow_session", "deny"] as ItemOf<"approval_request">["options"],
  };
  const title = call.title?.trim();
  switch (call.kind) {
    case "execute": {
      const command = commandOf(call);
      return {
        ...base,
        title: `Run \`${shorten(command, 100)}\``,
        command,
        cwd: workdirOf(call, deps.cwd),
      };
    }
    case "edit":
    case "delete":
    case "move": {
      const paths = pathsOf(call, deps.cwd);
      const verb = call.kind === "delete" ? "Delete" : call.kind === "move" ? "Move" : "Edit";
      return {
        ...base,
        title:
          paths.length === 1 ? `${verb} ${paths[0]}` : title || `${verb} ${paths.length} files`,
        ...(paths.length ? { paths } : {}),
      };
    }
    default: {
      const mcp = mcpOf(call, deps.mcpServers);
      return {
        ...base,
        title: mcp ? `Run ${mcp.server}: ${mcp.tool}` : title || `Allow ${base.toolName}`,
      };
    }
  }
}

function actionOf(call: AcpToolState): ItemOf<"approval_request">["action"] {
  if (call.kind === "execute") return "command";
  if (WRITE_KINDS.has(String(call.kind))) return "file_change";
  if (call.kind === "fetch") return "network";
  return "tool";
}

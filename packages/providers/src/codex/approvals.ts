import type { UserQuestion } from "@codeden/contracts";
import type { RiskAssessment } from "../policy/risk";
import { shorten } from "../util/text";
import {
  type ApprovalContext,
  type ApprovalItem,
  approvedByPolicy,
  decisionOf,
} from "./approval-context";
import { handleElicitation } from "./elicitation";
import { commandRisk, patchRisk, permissionsRisk } from "./policy";
import type { ServerRequest } from "./protocol";
import type {
  CommandExecutionApprovalDecision,
  FileChangeApprovalDecision,
  ToolRequestUserInputResponse,
} from "./protocol/v2";
import { CodexRpcError } from "./rpc";

/** The item with the classifier's verdict, for the user to decide. */
function withRisk(item: ApprovalItem, risk: RiskAssessment): ApprovalItem {
  if (!risk.risky) return item;
  return {
    ...item,
    action: item.action === "network" ? item.action : risk.action,
    reason: item.reason ?? risk.reason,
  };
}

/** Handle an app-server -> client request. Resolves with the JSON-RPC result. */
export async function handleServerRequest(
  req: ServerRequest,
  ac: ApprovalContext,
): Promise<unknown> {
  switch (req.method) {
    case "item/commandExecution/requestApproval": {
      const p = req.params;
      const command = p.commandActions?.length
        ? p.commandActions.map((a) => a.command).join(" && ")
        : (p.command ?? "");
      const risk = commandRisk(
        [p.command ?? "", ...(p.commandActions ?? []).map((a) => a.command)],
        ac.risk,
      );
      const item: ApprovalItem = {
        id: `approval-${p.approvalId ?? p.itemId}`,
        kind: "approval_request",
        status: "in_progress",
        requestId: p.approvalId ?? p.itemId,
        action: p.networkApprovalContext ? "network" : "command",
        title: command ? `Run \`${shorten(command, 100)}\`` : "Run a command",
        ...(p.reason ? { reason: p.reason } : {}),
        ...(command ? { command } : {}),
        ...(p.cwd ? { cwd: p.cwd } : {}),
        toolName: "shell",
        toolCallItemId: p.itemId,
        options: ["allow_once", "allow_session", "deny"],
      };
      if (approvedByPolicy(ac, p, item, risk)) return { decision: "accept" };
      const response = await ac.broker.request(ac.ctx(p.threadId, p.turnId), withRisk(item, risk));
      const map: Record<string, CommandExecutionApprovalDecision> = {
        allow_once: "accept",
        allow_session: "acceptForSession",
        deny: "decline",
        cancel: "cancel",
      };
      return { decision: map[decisionOf(response)] ?? "cancel" };
    }
    case "item/fileChange/requestApproval": {
      const p = req.params;
      const paths = ac.filePaths(p.itemId) ?? [];
      const item: ApprovalItem = {
        id: `approval-${p.itemId}`,
        kind: "approval_request",
        status: "in_progress",
        requestId: p.itemId,
        action: p.grantRoot ? "outside_worktree" : "file_change",
        title:
          paths.length === 1
            ? `Edit ${paths[0]}`
            : paths.length
              ? `Edit ${paths.length} files`
              : "Apply a patch",
        ...(p.reason ? { reason: p.reason } : {}),
        ...(paths.length ? { paths } : {}),
        toolName: "apply_patch",
        toolCallItemId: p.itemId,
        options: ["allow_once", "allow_session", "deny"],
      };
      const risk = patchRisk(paths, p.grantRoot, ac.risk);
      if (approvedByPolicy(ac, p, item, risk)) return { decision: "accept" };
      const response = await ac.broker.request(ac.ctx(p.threadId, p.turnId), item);
      const map: Record<string, FileChangeApprovalDecision> = {
        allow_once: "accept",
        allow_session: "acceptForSession",
        deny: "decline",
        cancel: "cancel",
      };
      return { decision: map[decisionOf(response)] ?? "cancel" };
    }
    case "item/permissions/requestApproval": {
      const p = req.params;
      const item: ApprovalItem = {
        id: `approval-${p.itemId}`,
        kind: "approval_request",
        status: "in_progress",
        requestId: p.itemId,
        action: p.permissions.network ? "network" : "outside_worktree",
        title: "Grant additional permissions",
        ...(p.reason ? { reason: p.reason } : {}),
        cwd: p.cwd,
        toolInput: JSON.parse(JSON.stringify(p.permissions)),
        options: ["allow_once", "allow_session", "deny"],
      };
      const granted = {
        ...(p.permissions.network ? { network: p.permissions.network } : {}),
        ...(p.permissions.fileSystem ? { fileSystem: p.permissions.fileSystem } : {}),
      };
      // Granted for this turn only, so the next request is judged again.
      const risk = permissionsRisk(p.permissions, ac.risk);
      if (approvedByPolicy(ac, p, item, risk)) return { permissions: granted, scope: "turn" };
      const response = await ac.broker.request(ac.ctx(p.threadId, p.turnId), withRisk(item, risk));
      const decision = decisionOf(response);
      if (decision === "allow_once" || decision === "allow_session") {
        return { permissions: granted, scope: decision === "allow_session" ? "session" : "turn" };
      }
      return { permissions: {}, scope: "turn" };
    }
    case "item/tool/requestUserInput": {
      const p = req.params;
      const questions: UserQuestion[] = p.questions.map((q) => ({
        id: q.id,
        header: q.header,
        question: q.question,
        options: (q.options ?? []).map((o) => ({ label: o.label, description: o.description })),
        multiSelect: false,
        allowFreeText: q.isOther || !q.options?.length,
      }));
      const response = await ac.broker.request(ac.ctx(p.threadId, p.turnId), {
        id: `question-${p.itemId}`,
        kind: "user_question",
        status: "in_progress",
        requestId: p.itemId,
        questions,
      });
      const answers: ToolRequestUserInputResponse["answers"] = {};
      if (response.kind === "answer") {
        for (const [id, values] of Object.entries(response.answers))
          answers[id] = { answers: values };
      }
      return { answers };
    }
    case "mcpServer/elicitation/request":
      return handleElicitation(req.params, ac);
    case "execCommandApproval":
    case "applyPatchApproval":
      // Legacy v1 approvals; v2 clients never receive them, but never leave the agent hanging.
      return { decision: { denied: { rejection: "Unsupported approval request" } } };
    default:
      throw new CodexRpcError(-32601, `CodeDen does not handle ${req.method}`);
  }
}

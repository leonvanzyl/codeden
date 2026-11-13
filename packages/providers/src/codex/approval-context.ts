import type { AutonomyLevel, ItemOf, RuntimeResponse } from "@codeden/contracts";
import type { ApprovalBroker, ItemCtx } from "../approvals";
import type { RiskAssessment, RiskContext } from "../policy/risk";
import { levelAllows } from "./policy";

export interface ApprovalContext {
  broker: ApprovalBroker;
  risk: RiskContext;
  /**
   * The session's current permission level. Under Auto and Full, requests the level allows are
   * approved by policy instead of reaching the user (§11.2). Default `supervised`: ask for all.
   */
  autonomy?: () => AutonomyLevel;
  /**
   * Where a request's item goes, from the Codex thread and turn that raised it (a sub-agent's
   * requests go to its child thread).
   */
  ctx: (codexThreadId: string, turnId: string) => ItemCtx;
  /** Paths touched by a pending file change item, if known. */
  filePaths: (itemId: string) => string[] | undefined;
}

export type ApprovalItem = ItemOf<"approval_request">;

export const decisionOf = (r: RuntimeResponse) => (r.kind === "approval" ? r.decision : "cancel");

/**
 * Approve `item` by policy when the permission level allows `risk`: record it as decided by
 * policy (shown in the transcript, never waited on) and return true. Otherwise return false and
 * the caller asks the user, with the classifier's reason.
 */
export function approvedByPolicy(
  ac: ApprovalContext,
  p: { threadId: string; turnId: string },
  item: ApprovalItem,
  risk: RiskAssessment,
): boolean {
  const autonomy = ac.autonomy?.() ?? "supervised";
  if (!levelAllows(autonomy, risk)) return false;
  ac.broker.record(ac.ctx(p.threadId, p.turnId), {
    ...item,
    status: "completed",
    reason: `Allowed by the ${autonomy === "full" ? "Full" : "Auto"} permission level`,
    decision: "allow_once",
    decidedBy: "policy",
  });
  return true;
}

import type { ApprovalAction } from "@codeden/contracts";

/** The classifier's verdict on one action: safe, or risky with the approval it needs. */
export type RiskAssessment =
  | { risky: false }
  | {
      risky: true;
      action: ApprovalAction;
      reason: string;
      /**
       * Touches CodeDen's own credential files (§15): asks at every level, Full included, is
       * refused for read-only sessions, and a remembered approval of the whole tool doesn't
       * cover it.
       */
      codeden?: true;
    };

export const SAFE: RiskAssessment = { risky: false };

export const risky = (action: ApprovalAction, reason: string): RiskAssessment => ({
  risky: true,
  action,
  reason,
});

/** True for a verdict on CodeDen's own credential files. */
export const touchesCodeden = (risk: RiskAssessment): boolean =>
  risk.risky && risk.codeden === true;

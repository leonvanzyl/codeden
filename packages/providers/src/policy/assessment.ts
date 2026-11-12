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

/**
 * The verdict for several checks of one action: CodeDen's own credentials first (a level may
 * allow an ordinary risk that comes before them), then the first risky one, else safe.
 */
export function mostSevere(risks: readonly RiskAssessment[]): RiskAssessment {
  return risks.find(touchesCodeden) ?? risks.find((r) => r.risky) ?? SAFE;
}

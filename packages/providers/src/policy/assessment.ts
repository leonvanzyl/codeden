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
      /**
       * Asks at every level, Full included, like `codeden`, but without its read-only refusal:
       * writing an agent's own allow-list (`./agent-permissions`), which would let that agent
       * run what it lists without CodeDen asking, and reading an agent CLI's login
       * (`./provider-logins`), which would hand over the user's account.
       */
      always?: true;
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
 * True for a verdict every level asks about: CodeDen's credentials, an agent's allow-list, an
 * agent CLI's login.
 */
export const asksAtEveryLevel = (risk: RiskAssessment): boolean =>
  risk.risky && (risk.codeden === true || risk.always === true);

/**
 * The verdict for several checks of one action: CodeDen's own credentials first, then what
 * every level asks about (a level may allow an ordinary risk that comes before them), then the
 * first risky one, else safe.
 */
export function mostSevere(risks: readonly RiskAssessment[]): RiskAssessment {
  return (
    risks.find(touchesCodeden) ?? risks.find(asksAtEveryLevel) ?? risks.find((r) => r.risky) ?? SAFE
  );
}

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
 * How severe a verdict is: the highest permission level that still asks about it. CodeDen's own
 * credentials (every level asks, and read-only sessions are refused) come before what else every
 * level asks about, then a write outside the worktree, which Full asks about, then the risks only
 * Auto asks about, then no risk.
 */
function severity(risk: RiskAssessment): number {
  if (!risk.risky) return 0;
  if (risk.codeden === true) return 4;
  if (risk.always === true) return 3;
  return risk.action === "outside_worktree" ? 2 : 1;
}

/**
 * The verdict for several checks of one action, or for the parts of one command: the most severe
 * (`severity`), and the first of those, whatever their order. So a risk a level allows (a force
 * push at Full) never hides one it asks about (a delete outside the worktree) (#627).
 */
export function mostSevere(risks: readonly RiskAssessment[]): RiskAssessment {
  let worst: RiskAssessment = SAFE;
  for (const risk of risks) {
    if (severity(risk) > severity(worst)) worst = risk;
  }
  return worst;
}

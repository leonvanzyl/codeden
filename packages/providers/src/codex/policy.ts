import type { AutonomyLevel } from "@codeden/contracts";
import { asksAtEveryLevel, mostSevere } from "../policy/assessment";
import {
  classifyCommand,
  classifyRead,
  classifyWrite,
  type RiskAssessment,
  type RiskContext,
} from "../policy/risk";
import type { RequestPermissionProfile } from "./protocol/v2";

/**
 * CodeDen's policy for what Codex asks (§11.2). Codex runs in its workspace-write sandbox, which
 * keeps `.git` read-only and (under Auto) the network off, so it asks to escalate for ordinary
 * work such as `git commit` or `pnpm install`. Under Auto and Full those requests go through the
 * same risk classifier as Claude's tool calls: what the level allows is approved by policy
 * (recorded with `decidedBy: "policy"`), and only the rest reaches the user.
 */

/**
 * True when the permission level allows an action the classifier assessed as `risk`. CodeDen's
 * own credential files and agents' own allow-lists are never allowed by policy. Commands Codex
 * runs inside its sandbox without asking (reads included) never reach this policy.
 */
export function levelAllows(autonomy: AutonomyLevel, risk: RiskAssessment): boolean {
  if (autonomy === "auto") return !risk.risky;
  if (autonomy === "full") {
    return !risk.risky || (risk.action !== "outside_worktree" && !asksAtEveryLevel(risk));
  }
  return false;
}

/**
 * Risk of a command Codex asks to run: the command line as sent and each parsed action, so a
 * redirect or path the parsed form drops still counts. Here and below, CodeDen's own
 * credentials win over an earlier ordinary risk (`mostSevere`).
 */
export function commandRisk(texts: string[], ctx: RiskContext): RiskAssessment {
  return mostSevere(texts.filter(Boolean).map((text) => classifyCommand(text, ctx)));
}

/**
 * Risk of a patch Codex asks to apply: each file it changes, and the root it asks to write
 * under for the rest of the session. Unknown paths can't be judged, so they need the user.
 */
export function patchRisk(
  paths: string[],
  grantRoot: string | null | undefined,
  ctx: RiskContext,
): RiskAssessment {
  const targets = [...paths, ...(grantRoot ? [grantRoot] : [])];
  if (targets.length === 0) {
    return { risky: true, action: "outside_worktree", reason: "Changes files Codex did not name" };
  }
  return mostSevere(targets.map((target) => classifyWrite(target, ctx)));
}

/**
 * Risk of extra permissions Codex asks for: network access (not restricted, as for Claude,
 * while no host list applies) and folders to read or write. Patterns and special folders can't
 * be judged, so they need the user.
 */
export function permissionsRisk(
  permissions: RequestPermissionProfile,
  ctx: RiskContext,
): RiskAssessment {
  const fs = permissions.fileSystem;
  if (!fs) return { risky: false };
  const unknown: RiskAssessment = {
    risky: true,
    action: "outside_worktree",
    reason: "Asks for access to folders by pattern",
  };
  const checks: RiskAssessment[] = [
    ...(fs.write ?? []).map((p) => classifyWrite(p, ctx)),
    ...(fs.read ?? []).map((p) => classifyRead(p, ctx)),
    ...(fs.entries ?? []).map((entry) => {
      if (entry.path.type !== "path") return unknown;
      if (entry.access === "write") return classifyWrite(entry.path.path, ctx);
      return entry.access === "read"
        ? classifyRead(entry.path.path, ctx)
        : { risky: false as const };
    }),
  ];
  return mostSevere(checks);
}

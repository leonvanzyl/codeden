import path from "node:path";
import type { ApprovalAction, AutonomyLevel } from "@codeden/contracts";
import { readOnlyCommandDenial } from "../policy/read-only";
import {
  classifyCommand,
  classifyFetch,
  classifyRead,
  classifyWrite,
  type RiskAssessment,
  type RiskContext,
} from "../policy/risk";
import { str } from "../util/text";
import type { OcPermissionRequest } from "./protocol";

/** What CodeDen does with one OpenCode permission request. */
export type PolicyDecision =
  | { kind: "allow" }
  | { kind: "deny"; message: string }
  | { kind: "ask"; action: ApprovalAction; reason: string };

/** A permission request plus the tool call it gates, when known. */
export interface PermissionCall {
  request: OcPermissionRequest;
  toolName?: string;
  toolInput?: Record<string, unknown>;
}

/** OpenCode's tools that write files (their permission action is `edit`). */
export const EDIT_TOOLS = new Set(["edit", "write", "patch"]);

const ALLOW: PolicyDecision = { kind: "allow" };

/**
 * CodeDen's approval policy for OpenCode (§11.2). The session's rules make every edit, shell
 * command, path outside the worktree and web fetch ask (`SESSION_PERMISSIONS`); this decides
 * each ask with the same classifier and levels as the other providers:
 * - read_only (or a read-only role) -> edits refused, commands only when read-only
 * - supervised -> every edit and command goes to the user, plus anything risky
 * - auto       -> only risky calls go to the user
 * - full       -> only writes outside the worktree go to the user
 * Asks that come from the user's own OpenCode rules (subagents, skills, MCP tools, `.env`
 * reads) go to the user unless the classifier clears them.
 */
export class OpenCodePolicy {
  private readonly sessionAllow = new Set<string>();

  constructor(
    private autonomy: AutonomyLevel,
    private readonly ctx: RiskContext,
    /** Read-only sessions (orchestrator, PMs). */
    private readonly readOnly = false,
  ) {}

  get level(): AutonomyLevel {
    return this.autonomy;
  }

  get isReadOnly(): boolean {
    return this.readOnly || this.autonomy === "read_only";
  }

  /**
   * Switch the level; it applies from the next permission request. Read-only forgets the
   * session's remembered approvals, so switching back later asks again.
   */
  setAutonomy(level: AutonomyLevel): void {
    this.autonomy = level;
    if (level === "read_only") this.sessionAllow.clear();
  }

  decide(call: PermissionCall): PolicyDecision {
    const { request } = call;
    // A remembered approval never overrides read-only.
    if (!this.isReadOnly && this.sessionAllow.has(this.key(call))) return ALLOW;
    switch (request.action) {
      case "shell":
        return this.shell(call);
      case "edit":
        return this.edit(request.resources);
      case "external_directory":
        // Writes there are decided by the `edit` ask that follows, which carries the diff.
        return this.gate(this.firstRisk(request.resources.map(dirOf), classifyRead));
      case "webfetch":
        return this.gate(this.firstRisk(request.resources, classifyFetch));
      case "read":
        return this.gate(this.firstRisk(request.resources, classifyRead), undefined, true);
      default:
        return {
          kind: "ask",
          action: "tool",
          reason: `OpenCode asks before ${request.action}`,
        };
    }
  }

  /** Remember an `allow_session` decision: commands and paths match exactly. */
  allowForSession(call: PermissionCall): void {
    this.sessionAllow.add(this.key(call));
  }

  private shell(call: PermissionCall): PolicyDecision {
    const command = commandOf(call);
    if (this.isReadOnly) {
      // Agent sessions at `read_only` may run the project's checks; read-only roles may not.
      const reason = readOnlyCommandDenial(command, { allowChecks: !this.readOnly });
      return reason ? { kind: "deny", message: `This session is read-only: ${reason}.` } : ALLOW;
    }
    const workdir = str(call.toolInput, "workdir");
    const dir = workdir ? path.resolve(this.ctx.cwd, workdir) : undefined;
    return this.gate(classifyCommand(command, dir ? { ...this.ctx, dir } : this.ctx), "command");
  }

  private edit(paths: readonly string[]): PolicyDecision {
    if (this.isReadOnly) {
      return {
        kind: "deny",
        message: this.readOnly
          ? "This session is read-only: it cannot edit files. Act through CodeDen tools instead."
          : "This session has read-only permissions: it cannot edit files, commit or push. Report what you found instead.",
      };
    }
    return this.gate(this.firstRisk(paths, classifyWrite), "file_change");
  }

  private firstRisk(
    targets: readonly string[],
    classify: (target: string, ctx: RiskContext) => RiskAssessment,
  ): RiskAssessment {
    for (const target of targets) {
      const risk = classify(target, this.ctx);
      if (risk.risky) return risk;
    }
    return { risky: false };
  }

  /**
   * The level's gate (the same as Claude's): edits and commands (`supervisedAction`) always
   * ask in supervised mode; `alwaysRisky` asks for flagged calls even at full autonomy
   * (secrets reads).
   */
  private gate(
    risk: RiskAssessment,
    supervisedAction?: ApprovalAction,
    alwaysRisky = false,
  ): PolicyDecision {
    if (this.autonomy === "supervised") {
      if (risk.risky) return { kind: "ask", action: risk.action, reason: risk.reason };
      if (supervisedAction) {
        return {
          kind: "ask",
          action: supervisedAction,
          reason: "Supervised mode: every edit and command needs approval",
        };
      }
      return ALLOW;
    }
    if (!risk.risky) return ALLOW;
    if (this.autonomy === "full" && risk.action !== "outside_worktree" && !alwaysRisky) {
      return ALLOW;
    }
    return { kind: "ask", action: risk.action, reason: risk.reason };
  }

  private key(call: PermissionCall): string {
    const { action, resources } = call.request;
    if (action === "shell") return `shell:${commandOf(call)}`;
    return `${action}:${[...resources].sort().join("\n")}`;
  }
}

/** The command an OpenCode `shell` ask is about: the tool input, else its parsed parts. */
export function commandOf(call: PermissionCall): string {
  return str(call.toolInput, "command") ?? call.request.resources.join(" && ");
}

/** `C:/work/other/*` -> `C:/work/other`. */
function dirOf(resource: string): string {
  return resource.replace(/[\\/]\*$/, "");
}

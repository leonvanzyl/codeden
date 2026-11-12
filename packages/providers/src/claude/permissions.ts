import type { PermissionMode } from "@anthropic-ai/claude-agent-sdk";
import type { ApprovalAction, AutonomyLevel } from "@codeden/contracts";
import { touchesCodeden } from "../policy/assessment";
import { isInNotes } from "../policy/paths";
import { readOnlyCommandDenial } from "../policy/read-only";
import type { RiskContext } from "../policy/risk";
import { str } from "../util/text";
import {
  assessClaudeTool,
  COMMAND_TOOLS,
  defaultApprovalAction,
  EDIT_TOOLS,
  editPath,
  PLAN_TOOL,
  QUESTION_TOOL,
} from "./tools";

const FINISH_PLAN = "Finish the plan and present it with ExitPlanMode; once the user approves it";

/** The decision for one tool call. */
export type Gate = { ask: false } | { ask: true; action: ApprovalAction; reason: string };

/**
 * Native permission mode per autonomy level (§11.2):
 * - read_only  -> `default`; edits and writing commands are denied by the PreToolUse hook
 *                 (`ClaudePolicy.denial`), so they never reach a prompt
 * - supervised -> `default`, and every edit/command is forced to ask via a PreToolUse hook
 * - auto       -> `acceptEdits`, plus the risky-action classifier
 * - full       -> `bypassPermissions`, asking only for writes outside the worktree (the OS
 *                 temp directory counts as inside, except for secrets files there)
 * Plan mode overrides all of them with `plan`. CodeDen's own credential files ask at every
 * level and are refused for read-only sessions (`../policy/codeden-home`).
 */
export function permissionModeFor(autonomy: AutonomyLevel, planMode: boolean): PermissionMode {
  if (planMode) return "plan";
  if (autonomy === "read_only" || autonomy === "supervised") return "default";
  if (autonomy === "auto") return "acceptEdits";
  return "bypassPermissions";
}

/**
 * CodeDen's approval policy for Claude tool calls. `gate()` runs in a PreToolUse hook (so it
 * sees every call, including ones Claude would auto-allow) and again in `canUseTool`.
 * Hook `ask` decisions route the call to `canUseTool` in every permission mode.
 */
export class ClaudePolicy {
  private readonly sessionAllow = new Set<string>();
  /** Plan mode: edits outside Claude's notes and writing commands are refused. */
  private planning = false;

  constructor(
    private autonomy: AutonomyLevel,
    private readonly ctx: RiskContext,
    /** Read-only sessions (orchestrator, PMs): edits and writing commands are denied. */
    private readonly readOnly = false,
  ) {}

  get level(): AutonomyLevel {
    return this.autonomy;
  }

  /**
   * True while edits and writing commands are refused: a read-only role (orchestrator, PMs),
   * or the `read_only` permission level, which can change live with `setAutonomy`.
   */
  get isReadOnly(): boolean {
    return this.readOnly || this.autonomy === "read_only";
  }

  /** Switch the level; the next `gate()` uses it. `allow_session` decisions are kept. */
  setAutonomy(level: AutonomyLevel): void {
    this.autonomy = level;
  }

  /**
   * Plan mode on or off. Claude's `plan` mode hands file edits to `canUseTool`, which Auto and
   * Full would approve, so CodeDen refuses them itself while the agent plans.
   */
  setPlanning(on: boolean): void {
    this.planning = on;
  }

  /**
   * Why a call is refused outright (read-only sessions, plan mode), or undefined. `dir` is the
   * shell's current directory, as for `gate`.
   */
  denial(toolName: string, input: Record<string, unknown>, dir?: string): string | undefined {
    if (this.isReadOnly && touchesCodeden(this.assess(toolName, input, dir))) {
      return this.readOnly
        ? "This session is read-only: CodeDen's own credential files are off limits. Act through CodeDen tools instead."
        : "This session has read-only permissions: CodeDen's own credential files are off limits. Report what you found instead.";
    }
    // A planning agent writes its plan into Claude's notes folders, at every level (the
    // `read_only` level included). Read-only roles (orchestrator, PMs) never plan.
    if (this.planning && !this.readOnly && this.isNotesEdit(toolName, input)) return undefined;
    if (!this.isReadOnly) return this.planning ? this.planDenial(toolName, input) : undefined;
    if (EDIT_TOOLS.has(toolName)) {
      return this.readOnly
        ? "This session is read-only: it cannot edit files. Act through CodeDen tools instead."
        : "This session has read-only permissions: it cannot edit files, commit or push. Report what you found instead.";
    }
    if (COMMAND_TOOLS.has(toolName)) {
      // Agent sessions at `read_only` may run the project's checks; read-only roles may not.
      const reason = readOnlyCommandDenial(str(input, "command") ?? "", {
        allowChecks: !this.readOnly,
      });
      return reason ? `This session is read-only: ${reason}.` : undefined;
    }
    return undefined;
  }

  /**
   * Plan mode refusals at every level: edits (the plan file in Claude's notes folders was let
   * through by `denial`) and shell commands outside the read-only allowlist (checks may run).
   */
  private planDenial(toolName: string, input: Record<string, unknown>): string | undefined {
    if (EDIT_TOOLS.has(toolName)) {
      return `Plan mode: don't edit files yet. ${FINISH_PLAN}, you can implement it.`;
    }
    if (COMMAND_TOOLS.has(toolName)) {
      const reason = readOnlyCommandDenial(str(input, "command") ?? "", { allowChecks: true });
      return reason ? `Plan mode: ${reason}. ${FINISH_PLAN}, you can run it.` : undefined;
    }
    return undefined;
  }

  /** An edit tool writing inside Claude's notes folders (its plans folder, auto-memory). */
  private isNotesEdit(toolName: string, input: Record<string, unknown>): boolean {
    if (!EDIT_TOOLS.has(toolName)) return false;
    const target = editPath(input);
    return target !== "" && isInNotes(target, this.ctx);
  }

  /**
   * Decide one tool call. `dir` is the shell's current directory as Claude reports it (an
   * earlier `cd` persists between Bash calls); relative paths resolve from it.
   */
  gate(toolName: string, input: Record<string, unknown>, dir?: string): Gate {
    if (toolName === QUESTION_TOOL) {
      return { ask: true, action: "other", reason: "The agent is asking a question" };
    }
    if (toolName === PLAN_TOOL) {
      return { ask: true, action: "plan", reason: "The agent finished planning" };
    }
    const risk = this.assess(toolName, input, dir);
    // Approving a tool for the session (`Read`) never covers CodeDen's own credentials; an
    // approved command or edit matches exactly, so it may.
    const exact = COMMAND_TOOLS.has(toolName) || EDIT_TOOLS.has(toolName);
    const remembered = this.sessionAllow.has(this.key(toolName, input));
    if (remembered && (exact || !touchesCodeden(risk))) return { ask: false };
    if (this.autonomy === "supervised") {
      if (risk.risky) return { ask: true, action: risk.action, reason: risk.reason };
      if (COMMAND_TOOLS.has(toolName) || EDIT_TOOLS.has(toolName)) {
        return {
          ask: true,
          action: defaultApprovalAction(toolName),
          reason: "Supervised mode: every edit and command needs approval",
        };
      }
      return { ask: false };
    }
    if (!risk.risky) return { ask: false };
    if (this.autonomy === "full" && risk.action !== "outside_worktree" && !risk.codeden) {
      return { ask: false };
    }
    return { ask: true, action: risk.action, reason: risk.reason };
  }

  private assess(toolName: string, input: Record<string, unknown>, dir?: string) {
    return assessClaudeTool(toolName, input, dir ? { ...this.ctx, dir } : this.ctx);
  }

  /**
   * Whether a `canUseTool` call (Claude's own permission prompt) needs the user. In supervised
   * mode everything Claude asks about goes to the user; otherwise only gated calls do.
   */
  needsUser(toolName: string, input: Record<string, unknown>, dir?: string): Gate {
    const gate = this.gate(toolName, input, dir);
    if (gate.ask || this.autonomy !== "supervised") return gate;
    if (this.sessionAllow.has(this.key(toolName, input))) return gate;
    return {
      ask: true,
      action: defaultApprovalAction(toolName),
      reason: "Claude asked for permission",
    };
  }

  /** Remember an `allow_session` decision. Commands and edits match exactly; others by name. */
  allowForSession(toolName: string, input: Record<string, unknown>): void {
    this.sessionAllow.add(this.key(toolName, input));
  }

  private key(toolName: string, input: Record<string, unknown>): string {
    if (COMMAND_TOOLS.has(toolName)) return `${toolName}:${str(input, "command") ?? ""}`;
    if (EDIT_TOOLS.has(toolName)) {
      return `edit:${str(input, "file_path") ?? str(input, "notebook_path") ?? ""}`;
    }
    return toolName;
  }
}

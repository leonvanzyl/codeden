import type { ApprovalAction, AutonomyLevel, SessionOptions } from "@codeden/contracts";
import { asksAtEveryLevel, mostSevere, touchesCodeden } from "../policy/assessment";
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
import { type AcpToolState, commandOf, mcpOf, pathsOf, workdirOf } from "./items";

/** What CodeDen does with one `session/request_permission`. */
export type AcpPolicyDecision =
  | { kind: "allow" }
  | { kind: "deny"; message: string }
  | { kind: "ask"; action: ApprovalAction; reason: string };

const ALLOW: AcpPolicyDecision = { kind: "allow" };

/** The policy for a session's options: its level, worktree, role and MCP servers. */
export function policyFor(opts: SessionOptions): AcpPolicy {
  return new AcpPolicy(
    opts.autonomy,
    {
      cwd: opts.cwd,
      extraRoots: opts.additionalDirectories,
      ...(opts.codedenHome ? { codedenHome: opts.codedenHome } : {}),
    },
    opts.readOnly ?? false,
    trustedServers(opts),
    opts.mcpServers.map((s) => s.name),
  );
}

/** CodeDen's own MCP servers, whose tools run without asking. */
export function trustedServers(opts: Pick<SessionOptions, "mcpServers">): string[] {
  return opts.mcpServers.filter((s) => s.transport === "http" && s.trusted).map((s) => s.name);
}

/** Kinds of tool call that change files. */
export const WRITE_KINDS = new Set(["edit", "delete", "move"]);

/**
 * CodeDen's approval policy for an ACP agent (§11.2). The agent asks before the tool calls its
 * own rules gate (`session/request_permission`); this decides each ask with the same classifier
 * and levels as the other providers, so a level change applies from the next ask:
 * - read_only (or a read-only role) -> edits refused, commands only when read-only
 * - supervised -> every edit and command goes to the user, plus anything risky
 * - auto       -> only risky calls go to the user
 * - full       -> only writes outside the worktree go to the user
 * While planning, edits and writing commands are refused at every level. Tools of CodeDen's
 * own (trusted) MCP servers never ask; other MCP and unknown tools ask under supervised and
 * are refused for read-only sessions.
 */
export class AcpPolicy {
  private readonly sessionAllow = new Set<string>();
  /** Plan mode: no edits or writing commands at any level. */
  planning = false;

  constructor(
    private autonomy: AutonomyLevel,
    private readonly ctx: RiskContext,
    /** Read-only sessions (orchestrator, PMs). */
    private readonly readOnly = false,
    /** Names of MCP servers whose tools run without asking (CodeDen's own). */
    private readonly trustedServers: readonly string[] = [],
    /** Names of every MCP server the session has, to recognise MCP tool calls. */
    private readonly mcpServers: readonly string[] = [],
  ) {}

  get level(): AutonomyLevel {
    return this.autonomy;
  }

  get isReadOnly(): boolean {
    return this.readOnly || this.autonomy === "read_only";
  }

  setAutonomy(level: AutonomyLevel): void {
    this.autonomy = level;
    if (level === "read_only") this.sessionAllow.clear();
  }

  decide(call: AcpToolState): AcpPolicyDecision {
    // Only calls of kind `other` can be MCP calls (`mcpOf`): a command or an edit is judged
    // as one, whatever the agent titled it.
    const mcp = mcpOf(call, this.mcpServers);
    if (mcp && this.trustedServers.includes(mcp.server)) return ALLOW;
    if (!this.isReadOnly && !this.planning && this.sessionAllow.has(this.key(call))) return ALLOW;
    const kind = typeof call.kind === "string" ? call.kind : "other";
    if (kind === "execute") return this.shell(call);
    if (WRITE_KINDS.has(kind)) return this.edit(call);
    if (kind === "read" || kind === "search") {
      return this.gate(this.firstRisk(pathsOf(call, this.ctx.cwd), classifyRead), undefined, true);
    }
    if (kind === "fetch") {
      const url = str(call.rawInput, "url");
      return url
        ? this.gate(classifyFetch(url, this.ctx))
        : this.unknown("network", "The agent asks to use the web");
    }
    if (kind === "think") return ALLOW;
    if (kind === "switch_mode") {
      if (this.isReadOnly) return { kind: "deny", message: "This session cannot change its mode." };
      // Leaving plan mode is the plan approval: the user decides it at every level.
      if (this.planning) {
        return {
          kind: "ask",
          action: "plan",
          reason: "The agent asks to leave plan mode and start",
        };
      }
      return this.unknown("other", "The agent asks to change its mode");
    }
    return this.unknown(
      mcp ? "tool" : "other",
      mcp ? `The agent asks to run ${mcp.server}: ${mcp.tool}` : "The agent asks before this tool",
    );
  }

  /** Remember an `allow_session` decision: commands (in their folder) and paths match exactly. */
  allowForSession(call: AcpToolState): void {
    this.sessionAllow.add(this.key(call));
  }

  private shell(call: AcpToolState): AcpPolicyDecision {
    const command = commandOf(call);
    const dir = workdirOf(call, this.ctx.cwd);
    const risk = classifyCommand(command, { ...this.ctx, dir });
    if (this.isReadOnly || this.planning) {
      if (touchesCodeden(risk) && this.isReadOnly) return this.credentialsDenial();
      // Agent sessions (read-only level, or planning) may run the project's checks; roles may not.
      const reason = readOnlyCommandDenial(command, { allowChecks: !this.readOnly });
      if (reason) return { kind: "deny", message: `${this.readOnlyPrefix()}: ${reason}.` };
      if (this.isReadOnly) return ALLOW;
    }
    return this.gate(risk, "command");
  }

  private edit(call: AcpToolState): AcpPolicyDecision {
    if (this.isReadOnly || this.planning) {
      return {
        kind: "deny",
        message: this.planning
          ? "Plan mode: no edits until the plan is approved. Present the plan instead."
          : this.readOnly
            ? "This session is read-only: it cannot edit files. Act through CodeDen tools instead."
            : "This session has read-only permissions: it cannot edit files, commit or push. Report what you found instead.",
      };
    }
    const paths = pathsOf(call, this.ctx.cwd);
    if (!paths.length) return this.unknown("file_change", "The agent didn't say which file");
    return this.gate(this.firstRisk(paths, classifyWrite), "file_change");
  }

  /** An ask CodeDen can't judge: refused when read-only, asked under supervised, else allowed. */
  private unknown(action: ApprovalAction, reason: string): AcpPolicyDecision {
    if (this.isReadOnly) {
      return { kind: "deny", message: `${this.readOnlyPrefix()}: this tool is not allowed.` };
    }
    if (this.autonomy === "supervised" || action === "file_change") {
      return { kind: "ask", action, reason };
    }
    return ALLOW;
  }

  private readOnlyPrefix(): string {
    if (this.planning && !this.isReadOnly) return "Plan mode";
    return this.readOnly ? "This session is read-only" : "This session has read-only permissions";
  }

  private credentialsDenial(): AcpPolicyDecision {
    return {
      kind: "deny",
      message: this.readOnly
        ? "This session is read-only: CodeDen's own credential files are off limits. Act through CodeDen tools instead."
        : "This session has read-only permissions: CodeDen's own credential files are off limits. Report what you found instead.",
    };
  }

  private firstRisk(
    targets: readonly string[],
    classify: (target: string, ctx: RiskContext) => RiskAssessment,
  ): RiskAssessment {
    return mostSevere(targets.map((target) => classify(target, this.ctx)));
  }

  /** The level's gate, the same as the other providers'. */
  private gate(
    risk: RiskAssessment,
    supervisedAction?: ApprovalAction,
    alwaysRisky = false,
  ): AcpPolicyDecision {
    const codeden = touchesCodeden(risk);
    if (codeden && this.isReadOnly) return this.credentialsDenial();
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
    const always = alwaysRisky || asksAtEveryLevel(risk);
    if (this.autonomy === "full" && risk.action !== "outside_worktree" && !always) return ALLOW;
    return { kind: "ask", action: risk.action, reason: risk.reason };
  }

  private key(call: AcpToolState): string {
    const kind = typeof call.kind === "string" ? call.kind : "other";
    if (kind === "execute") {
      return `execute:${workdirOf(call, this.ctx.cwd)}\n${commandOf(call)}`;
    }
    const paths = pathsOf(call, this.ctx.cwd).sort().join("\n");
    return `${kind}:${call.name ?? ""}:${paths || (call.title ?? "")}`;
  }
}

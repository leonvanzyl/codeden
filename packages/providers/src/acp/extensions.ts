import type { ApprovalBroker } from "../approvals";
import type { ResolvedCommand } from "../util/exec";
import type { AcpEventMapper, ThreadCtx } from "./mapper";
import type { AcpInitializeResult, AcpSessionSetup } from "./protocol";
import type { AcpSubagents } from "./subagents";

/** What a vendor extension can reach in its session. */
export interface AcpExtensionHost {
  readonly cwd: string;
  readonly broker: ApprovalBroker;
  /** The thread the call came from: the root's, or a subagent's child thread. */
  readonly mapper: AcpEventMapper;
  /** The session's subagent runs. */
  readonly subagents: AcpSubagents;
  /** The agent runs subagents as child sessions (it accepted the `subagents` capability). */
  readonly childSessions: boolean;
  /** The running turn's context, if a turn runs. */
  ctx(): ThreadCtx | undefined;
  /** Plan mode is on. */
  readonly planning: boolean;
  /**
   * The user approved the plan: the agent leaves plan mode for the session's level, and
   * CodeDen hears `session.updated { planMode: false }`.
   */
  exitPlanMode(): Promise<void>;
}

/** A host from the session's parts; `planning` and `childSessions` are read live. */
export function extensionHost(parts: {
  cwd: string;
  broker: ApprovalBroker;
  mapper: AcpEventMapper;
  subagents: AcpSubagents;
  childSessions: () => boolean;
  planning: () => boolean;
  exitPlanMode: () => Promise<void>;
}): AcpExtensionHost {
  return {
    cwd: parts.cwd,
    broker: parts.broker,
    mapper: parts.mapper,
    subagents: parts.subagents,
    get childSessions() {
      return parts.childSessions();
    },
    ctx: () => parts.mapper.ctx(),
    get planning() {
      return parts.planning();
    },
    exitPlanMode: parts.exitPlanMode,
  };
}

/**
 * An agent's vendor methods beyond ACP itself (`<vendor>/<method>`), plugged into the generic
 * session. Anything not handled is refused with JSON-RPC "method not found" (requests) or
 * ignored (notifications), which agents treat as an unsupported feature.
 */
export interface AcpExtensions {
  /** Answer a vendor request. Returns undefined when this extension doesn't handle `method`. */
  request?(method: string, params: unknown, host: AcpExtensionHost): Promise<unknown> | undefined;
  /** Handle a vendor notification. */
  notification?(method: string, params: unknown, host: AcpExtensionHost): void;
  /**
   * Extra `clientCapabilities` fields to advertise in `initialize` (vendor `_meta` flags), e.g.
   * the `subagents` opt-in that makes the agent run subagents as child sessions.
   */
  clientCapabilities?: Record<string, unknown>;
}

/** How one ACP agent is driven: its command, auth method, modes and vendor extensions. */
export interface AcpAgentSpec {
  /** "Cursor": shown in errors and notices. */
  label: string;
  /** Arguments that start its ACP server, e.g. `["acp"]`. */
  args: readonly string[];
  authMethod?: string;
  /** Its mode ids: full tools, planning, and read-only (when it has them). */
  modes: { agent: string; plan?: string; readOnly?: string };
  extensions?: AcpExtensions;
}

export interface AcpSessionConfig {
  executable: ResolvedCommand;
  spec: AcpAgentSpec;
  /** The agent reported its session setup (models, modes): for the adapter's model list. */
  onSetup?: (setup: AcpSessionSetup, info: AcpInitializeResult) => void;
  startTimeoutMs?: number;
  interruptTimeoutMs?: number;
}

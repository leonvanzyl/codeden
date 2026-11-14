import type {
  ModelInfo,
  ProviderCapabilities,
  ProviderStatus,
  SessionOptions,
} from "@codeden/contracts";
import { modeIds, modelsOf } from "../acp/config";
import { classifyAcpError } from "../acp/errors";
import type { AcpAgentSpec } from "../acp/extensions";
import type { AcpInitializeResult, AcpSessionSetup } from "../acp/protocol";
import { AcpSession } from "../acp/session";
import { type ProviderAdapter, type ProviderSession, ProviderSessionError } from "../adapter";
import { ModelCatalog } from "../models";
import type { ResolvedCommand } from "../util/exec";
import { findExecutable, type LocateOptions } from "../util/locate";
import { geminiSessionArgs, writeGeminiAdminPolicies } from "./admin-policy";
import { geminiAllowListNotice } from "./allow-list";
import { detectGemini, GEMINI_MIN_VERSION, isSupportedGeminiVersion } from "./detect";
import { geminiExtensions } from "./extensions";
import { fallbackGeminiModels, geminiModelInfos } from "./models";
import { GEMINI_ACP_ARGS, type GeminiProbe, probeGemini } from "./probe";

export const GEMINI_PROVIDER_ID = "gemini";

/**
 * How CodeDen drives `gemini --acp`. No `authMethod`: Gemini CLI's `authenticate` rewrites the
 * login method in the user's settings (and clears a cached login of another kind), so sessions
 * use the login the user already chose. Agent sessions run in its `default` mode, which asks
 * before every edit, command and MCP tool; there is no read-only mode (its `plan` mode refuses
 * CodeDen's own tools), so read-only sessions stay in `default` and CodeDen's policy refuses
 * edits and commands. Each session also gets `--admin-policy` (`./admin-policy`), so allow-lists
 * in Gemini CLI's settings and policy files don't skip CodeDen's approvals, while the user's own
 * deny rules still apply.
 */
export const GEMINI_AGENT: AcpAgentSpec = {
  label: "Gemini CLI",
  args: GEMINI_ACP_ARGS,
  modes: { agent: "default", plan: "plan" },
  extensions: geminiExtensions,
  allowListNotice: geminiAllowListNotice,
};

/**
 * Honest flags (Principle 5). Approvals and the read-only level go through Gemini CLI's
 * permission requests, decided by CodeDen's policy for every call (so autonomy changes apply
 * live). Plan mode is its `plan` mode with CodeDen's plan approval; resume is `session/load`.
 * Not wired up: questions (Gemini CLI drops its `ask_user` tool in ACP mode), steering (ACP
 * can't add input to a running prompt), subagents, rollback, fork, reasoning effort and skills.
 * Images and MCP servers (CodeDen's tools are an HTTP MCP server) follow what the CLI reports
 * in `initialize`; plan mode, what its sessions list.
 */
const BASE_CAPABILITIES: ProviderCapabilities = {
  resume: true,
  steer: false,
  interrupt: true,
  approvals: true,
  userQuestions: false,
  subagents: false,
  rollback: false,
  fork: false,
  images: true,
  planMode: true,
  reasoningEffort: false,
  mcp: true,
  skills: false,
  liveAutonomy: true,
  readOnly: true,
};

export interface GeminiAdapterOptions {
  executable?: ResolvedCommand;
  /** Where to look for the CLI (tests); default PATH, then Homebrew's folders on macOS. */
  locate?: LocateOptions;
  /** Max time for a probe (detection). */
  probeTimeoutMs?: number;
  startTimeoutMs?: number;
  interruptTimeoutMs?: number;
}

/** Gemini CLI through its ACP server (`gemini --acp`), one process per session (§7.2). */
export class GeminiAdapter implements ProviderAdapter {
  readonly id = GEMINI_PROVIDER_ID;
  readonly displayName = "Gemini CLI";
  private readonly catalog = new ModelCatalog(fallbackGeminiModels());
  private info: AcpInitializeResult | undefined;
  /** Whether the last session listed a `plan` mode; unknown until one has. */
  private planListed: boolean | undefined;
  private found: { command: ResolvedCommand; version: string | null } | undefined;

  constructor(private readonly options: GeminiAdapterOptions = {}) {}

  /** The CLI to run: a given copy, the one detection found, else one looked up now. */
  private async executable(): Promise<{ command: ResolvedCommand; version: string | null }> {
    if (this.options.executable) return { command: this.options.executable, version: null };
    if (this.found) return this.found;
    const lookup = await findExecutable("gemini", {
      ...(this.options.probeTimeoutMs ? { timeoutMs: this.options.probeTimeoutMs } : {}),
      ...this.options.locate,
    });
    if (!lookup.command) throw new Error("Gemini CLI is not installed (no `gemini` on PATH)");
    this.found = { command: lookup.command, version: lookup.version };
    return this.found;
  }

  async detect(): Promise<ProviderStatus> {
    // A reinstall or an uninstall since the last detection: look again.
    this.found = undefined;
    const status = await detectGemini({
      ...(this.options.executable ? { executable: this.options.executable } : {}),
      ...(this.options.locate ? { locate: this.options.locate } : {}),
      ...(this.options.probeTimeoutMs ? { timeoutMs: this.options.probeTimeoutMs } : {}),
      probe: (exe, version) => this.probe(exe, version),
    });
    return status;
  }

  /** What the CLI reported in `initialize` refines resume, images and MCP; sessions, plan mode. */
  capabilities(): ProviderCapabilities {
    const caps = this.info?.agentCapabilities;
    return {
      ...BASE_CAPABILITIES,
      ...(caps
        ? {
            resume: caps.loadSession === true,
            images: caps.promptCapabilities?.image === true,
            mcp: caps.mcpCapabilities?.http === true,
          }
        : {}),
      ...(this.planListed === false ? { planMode: false } : {}),
    };
  }

  models(): ModelInfo[] {
    return this.catalog.list();
  }

  /**
   * Gemini CLI lists its models only in a session (`models.availableModels`), so there is no
   * `refreshModels`: its aliases stand in until a session reports the account's list.
   */
  onModelsChanged(listener: () => void): () => void {
    return this.catalog.subscribe(listener);
  }

  async openSession(opts: SessionOptions): Promise<ProviderSession> {
    const { command, version } = await this.executable();
    if (version && !isSupportedGeminiVersion(version)) {
      throw new ProviderSessionError(
        "version_unsupported",
        `Gemini CLI ${version} is older than ${GEMINI_MIN_VERSION}, the oldest CodeDen supports. Update it with \`npm install -g @google/gemini-cli@latest\`.`,
      );
    }
    // Allow-lists in Gemini CLI's settings and policy files don't skip CodeDen's approvals, and
    // the user's own deny rules stay in force.
    const policies = writeGeminiAdminPolicies(opts.codedenHome, { cwd: opts.cwd });
    const session = new AcpSession(opts, {
      executable: command,
      spec: { ...GEMINI_AGENT, args: geminiSessionArgs(GEMINI_AGENT.args, policies) },
      onSetup: (setup, info) => this.onSetup(setup, info),
      ...(this.options.startTimeoutMs ? { startTimeoutMs: this.options.startTimeoutMs } : {}),
      ...(this.options.interruptTimeoutMs
        ? { interruptTimeoutMs: this.options.interruptTimeoutMs }
        : {}),
    });
    try {
      await session.start();
    } catch (error) {
      await session.close();
      throw signInError(error);
    }
    return session;
  }

  /** A session reported its models and modes: they are the account's current ones. */
  private onSetup(setup: AcpSessionSetup, info: AcpInitializeResult): void {
    this.info = info;
    const modes = modeIds(setup);
    if (modes.length) this.planListed = modes.includes(GEMINI_AGENT.modes.plan ?? "plan");
    const reported = modelsOf(setup);
    if (reported?.models.length) this.catalog.set(geminiModelInfos(reported.models));
  }

  /** Detection found a supported copy: sessions run it, after the handshake shows its flags. */
  private async probe(exe: ResolvedCommand, version: string | null): Promise<GeminiProbe> {
    this.found = { command: exe, version };
    const result = await probeGemini(exe, {
      ...(this.options.probeTimeoutMs ? { timeoutMs: this.options.probeTimeoutMs } : {}),
    });
    if (result.info) this.info = result.info;
    return result;
  }
}

/** A session that couldn't start because Gemini CLI isn't signed in says how to sign in. */
function signInError(error: unknown): unknown {
  if (classifyAcpError(error) !== "auth") return error;
  const message = error instanceof Error ? error.message : String(error);
  return new ProviderSessionError(
    "not_logged_in",
    `Gemini CLI is not signed in (${message.replace(/\.$/, "")}). Run \`gemini\` and sign in with Google, or set GEMINI_API_KEY.`,
  );
}

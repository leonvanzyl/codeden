import type {
  ModelInfo,
  ProviderCapabilities,
  ProviderStatus,
  SessionOptions,
} from "@codeden/contracts";
import { modelsOf } from "../acp/config";
import type { AcpAgentSpec } from "../acp/extensions";
import type { AcpInitializeResult, AcpSessionSetup } from "../acp/protocol";
import { AcpSession } from "../acp/session";
import type { ProviderAdapter, ProviderSession, RefreshModelsOptions } from "../adapter";
import { executableFingerprint, ModelFreshness } from "../freshness";
import { ModelCatalog } from "../models";
import type { ResolvedCommand } from "../util/exec";
import type { LocateOptions } from "../util/locate";
import { detectCursor, findCursor } from "./detect";
import { cursorExtensions } from "./extensions";
import { cursorModelInfos, fallbackCursorModels } from "./models";
import { type CursorProbe, probeCursor } from "./probe";

export const CURSOR_PROVIDER_ID = "cursor";

/** How CodeDen drives `agent acp`: Cursor's login method, its modes and its extensions. */
export const CURSOR_AGENT: AcpAgentSpec = {
  label: "Cursor",
  args: ["acp"],
  authMethod: "cursor_login",
  modes: { agent: "agent", plan: "plan", readOnly: "ask" },
  extensions: cursorExtensions,
};

/**
 * Honest flags (Principle 5). Approvals and the read-only level go through Cursor's permission
 * requests, decided by CodeDen's policy for every call (so autonomy changes apply live), and
 * read-only sessions also run in Cursor's read-only `ask` mode. Plan mode is Cursor's `plan`
 * mode with its plan approval; questions are Cursor's question requests; resume is
 * `session/load`. Not wired up: steering (ACP has no way to add input to a running prompt),
 * subagents, rollback, fork and reasoning effort (Cursor lists each effort as its own model).
 * Images and MCP servers (CodeDen's tools are an HTTP MCP server) follow what the CLI reports
 * in `initialize`, once detection or a session has started it.
 */
const BASE_CAPABILITIES: ProviderCapabilities = {
  resume: true,
  steer: false,
  interrupt: true,
  approvals: true,
  userQuestions: true,
  subagents: false,
  rollback: false,
  fork: false,
  images: false,
  planMode: true,
  reasoningEffort: false,
  mcp: true,
  skills: false,
  liveAutonomy: true,
  readOnly: true,
};

export interface CursorAdapterOptions {
  executable?: ResolvedCommand;
  /** Where to look for the CLI (tests); default PATH, then its installer's folders. */
  locate?: LocateOptions;
  /** Max time for a probe (detection, model discovery). */
  probeTimeoutMs?: number;
  startTimeoutMs?: number;
  interruptTimeoutMs?: number;
}

/** Cursor through its CLI's ACP server (`agent acp`), one process per session (§7.2). */
export class CursorAdapter implements ProviderAdapter {
  readonly id = CURSOR_PROVIDER_ID;
  readonly displayName = "Cursor";
  private readonly catalog = new ModelCatalog(fallbackCursorModels());
  private readonly freshness = new ModelFreshness();
  private listed = false;
  /** From the last detection; unknown until then (the probe reads `agent status` itself). */
  private signedIn: boolean | undefined;
  private info: AcpInitializeResult | undefined;
  private found: ResolvedCommand | undefined;
  private probing: Promise<CursorProbe> | undefined;

  constructor(private readonly options: CursorAdapterOptions = {}) {}

  /**
   * The CLI to run: the copy detection validated, else one looked up now whose `--version` is
   * Cursor's (`findCursor`; results are cached per file). Another program called `agent` is
   * never run with anything but `--version`. Undefined when no Cursor CLI is installed.
   */
  private async executable(): Promise<ResolvedCommand | undefined> {
    if (this.options.executable) return this.options.executable;
    if (this.found) return this.found;
    const lookup = await findCursor({
      ...(this.options.locate ? { locate: this.options.locate } : {}),
      ...(this.options.probeTimeoutMs ? { timeoutMs: this.options.probeTimeoutMs } : {}),
    });
    this.found ??= lookup.command;
    return this.found;
  }

  async detect(): Promise<ProviderStatus> {
    // A reinstall or an uninstall since the last detection: look again.
    this.found = undefined;
    const status = await detectCursor({
      ...(this.options.executable ? { executable: this.options.executable } : {}),
      ...(this.options.locate ? { locate: this.options.locate } : {}),
      ...(this.options.probeTimeoutMs ? { timeoutMs: this.options.probeTimeoutMs } : {}),
      probe: (exe, signedIn) => {
        this.found = exe;
        this.signedIn = signedIn;
        return this.probe(exe);
      },
    });
    return status;
  }

  /** What the CLI reported in `initialize` refines images and MCP; the rest is fixed. */
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
    };
  }

  models(): ModelInfo[] {
    return this.catalog.list();
  }

  onModelsChanged(listener: () => void): () => void {
    return this.catalog.subscribe(listener);
  }

  /** Ask the CLI for its models without a session or a model call. Never throws. */
  async refreshModels(opts: RefreshModelsOptions = {}): Promise<void> {
    const exe = await this.executable();
    if (!exe) return;
    if (
      opts.maxAgeMs !== undefined &&
      !this.probing &&
      this.freshness.isFresh(executableFingerprint(exe), opts.maxAgeMs)
    ) {
      return;
    }
    await this.probe(exe).catch(() => undefined);
  }

  async openSession(opts: SessionOptions): Promise<ProviderSession> {
    const executable = await this.executable();
    if (!executable) {
      throw new Error(
        "The Cursor CLI is not installed (no `cursor-agent`, or `agent` from Cursor)",
      );
    }
    const session = new AcpSession(opts, {
      executable,
      spec: CURSOR_AGENT,
      onSetup: (setup, info) => this.onSetup(setup, info, executable),
      ...(this.options.startTimeoutMs ? { startTimeoutMs: this.options.startTimeoutMs } : {}),
      ...(this.options.interruptTimeoutMs
        ? { interruptTimeoutMs: this.options.interruptTimeoutMs }
        : {}),
    });
    try {
      await session.start();
    } catch (error) {
      await session.close();
      throw error;
    }
    return session;
  }

  /** A session reported its models: they are the account's current list. */
  private onSetup(setup: AcpSessionSetup, info: AcpInitializeResult, exe: ResolvedCommand): void {
    this.info = info;
    const reported = modelsOf(setup);
    if (reported?.models.length) this.setModels(cursorModelInfos(reported.models), exe);
  }

  /** One probe at a time; its models replace the catalog. */
  private probe(exe: ResolvedCommand): Promise<CursorProbe> {
    this.probing ??= probeCursor(exe, {
      ...(this.signedIn !== undefined ? { signedIn: this.signedIn } : {}),
      ...(this.options.probeTimeoutMs ? { timeoutMs: this.options.probeTimeoutMs } : {}),
    })
      .then((result) => {
        if (result.info) this.info = result.info;
        if (result.models.length) this.setModels(cursorModelInfos(result.models), exe);
        else if (!this.listed) {
          this.catalog.set(
            fallbackCursorModels(
              result.acp ? "Cursor listed no models yet." : "Cursor's ACP server did not start.",
            ),
          );
        }
        return result;
      })
      .finally(() => {
        this.probing = undefined;
      });
    return this.probing;
  }

  private setModels(models: ModelInfo[], from: ResolvedCommand): void {
    this.listed = true;
    this.freshness.confirm(executableFingerprint(from));
    this.catalog.set(models);
  }
}

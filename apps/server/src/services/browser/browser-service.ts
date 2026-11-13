import type {
  BrowserHostClientMessage,
  BrowserOpenResponse,
  BrowserRelayEndpoint,
  BrowserTab,
  BrowserTabsResponse,
  DevServer,
  RunnerCommandName,
  RunnerCommandOf,
  RunnerCommandResult,
  Settings,
} from "@codeden/contracts";
import { errorMessage, ServiceError } from "../errors";
import { type RunnerDeps, runnerErrorCode, runnerForSession, toServiceError } from "../runner-port";
import type { SessionRepo } from "../sessions/repo";
import { AgentActivity } from "./agent-activity";
import { BrowserHostLink } from "./browser-host";

export interface BrowserServiceDeps extends RunnerDeps {
  repo: SessionRepo;
  /** Current settings (`desktop.nativeBrowser`); native views are off without it. */
  settings?: () => Settings;
  log?: (message: string) => void;
}

/** Navigation and agent actions can wait on slow pages; leave headroom over the runner's 30s. */
const BROWSER_TIMEOUT_MS = 60_000;

/** True when a runner failure means the session has no browser open yet. */
export function isBrowserNotOpen(error: unknown): boolean {
  return (
    runnerErrorCode(error) === "not_found" ||
    (error instanceof ServiceError && error.code === "browser_not_open")
  );
}

/** Who opens a session's browser, which decides its engine when it has none yet. */
export interface OpenOptions {
  /**
   * Prefer the desktop app's native views (§17 Phase 2): set for the desktop window and for
   * agents. A plain browser tab or a phone opens on the runner's Chromium.
   */
  native?: boolean;
}

type HandoffSessions = Extract<BrowserHostClientMessage, { type: "handoff" }>["sessions"];

/**
 * The session browser (§12.2) for the panel routes, the `/ws/browser` channel and the agent
 * tools. Every call names the session it acts for, so nobody can reach another session's
 * context; the runner enforces the same isolation.
 *
 * Engines: a session's browser opens on native views in the desktop app when the app is
 * connected, the setting is on and the desktop window or an agent opens it; otherwise on the
 * runner's Chromium. An open browser keeps its engine until it closes, or until the app quits
 * and hands it to the runner.
 */
export class BrowserService {
  /** When agents drive each session's browser, for the panel's "Agent is acting" chip. */
  readonly agentActivity = new AgentActivity();
  /** The desktop app, when one offers native views. */
  readonly host: BrowserHostLink;

  constructor(private readonly deps: BrowserServiceDeps) {
    this.host = new BrowserHostLink({ handoff: (s) => this.handoff(s), log: deps.log });
  }

  /** A `browser.*` command an agent tool sends: like `command`, and marks the agent acting. */
  agentCommand<N extends Extract<RunnerCommandName, `browser.${string}`>>(
    command: RunnerCommandOf<N>,
    timeoutMs = BROWSER_TIMEOUT_MS,
  ): Promise<RunnerCommandResult<N>> {
    const { sessionId } = command as { sessionId: string };
    return this.agentActivity.track(sessionId, () => this.command(command, timeoutMs));
  }

  /** `navigate` on behalf of an agent tool (marks the agent acting). */
  agentNavigate(sessionId: string, url: string, tabId?: string) {
    return this.agentActivity.track(sessionId, () =>
      this.navigate(sessionId, url, tabId, { native: true }),
    );
  }

  /** Open a dev server for an agent: a new tab, or the first tab of a browser it opens. */
  agentOpenDevServer(sessionId: string, port: number, path?: string): Promise<{ tab: BrowserTab }> {
    return this.agentActivity.track(sessionId, async () => {
      if ((await this.tabs(sessionId)).open) {
        return this.command({ name: "browser.devServer", sessionId, port, path });
      }
      const url = `http://localhost:${port}${path ?? "/"}`;
      const { tabs } = await this.open(sessionId, url, { native: true });
      const tab = tabs.find((t) => t.active) ?? tabs[0];
      if (!tab) throw new ServiceError(500, "browser_error", "The browser opened without a tab");
      return { tab };
    });
  }

  /**
   * Send a `browser.*` command for an existing session to its runner (each session's browser
   * runs next to its code), mapping runner failures.
   */
  async command<N extends Extract<RunnerCommandName, `browser.${string}`>>(
    command: RunnerCommandOf<N>,
    timeoutMs = BROWSER_TIMEOUT_MS,
  ): Promise<RunnerCommandResult<N>> {
    const { sessionId } = command as { sessionId: string };
    this.deps.repo.get(sessionId);
    try {
      return await runnerForSession(this.deps, sessionId).request(command, timeoutMs);
    } catch (error) {
      if (runnerErrorCode(error) === "not_found") {
        throw new ServiceError(
          409,
          "browser_not_open",
          error instanceof Error ? error.message : "The browser is not open",
        );
      }
      throw toServiceError(error);
    }
  }

  async open(
    sessionId: string,
    url?: string,
    opts: OpenOptions = {},
  ): Promise<BrowserOpenResponse> {
    const relay = opts.native ? await this.nativeRelay(sessionId) : undefined;
    const result = await this.command({ name: "browser.open", sessionId, url, relay });
    return { cdpUrl: result.cdpUrl, tabs: result.tabs ?? [], engine: result.engine ?? "runner" };
  }

  /** The session's tabs; `open: false` when it has no browser yet (never throws for that). */
  async tabs(sessionId: string): Promise<BrowserTabsResponse> {
    try {
      const { tabs, engine } = await this.command({ name: "browser.tabs.list", sessionId });
      return { open: true, tabs, engine: engine ?? "runner" };
    } catch (error) {
      if (isBrowserNotOpen(error)) return { open: false, tabs: [] };
      throw error;
    }
  }

  /** Open the browser if needed, then navigate the active tab. */
  async navigate(sessionId: string, url: string, tabId?: string, opts: OpenOptions = {}) {
    if (!(await this.tabs(sessionId)).open) await this.open(sessionId, undefined, opts);
    return this.command({ name: "browser.navigate", sessionId, url, tabId });
  }

  /** Local dev servers the home runner can see (its own descendants plus probed ports). */
  async devServers(probe?: number[]): Promise<DevServer[]> {
    try {
      const { ports } = await this.deps.runner.request({ name: "ports.list", probe }, 20_000);
      return ports;
    } catch (error) {
      throw toServiceError(error);
    }
  }

  /**
   * The desktop app's relay for a session that has no browser yet, when native views are on
   * offer; undefined means the runner's Chromium (an open browser keeps its engine).
   */
  private async nativeRelay(sessionId: string): Promise<BrowserRelayEndpoint | undefined> {
    if (!this.host.available) return undefined;
    if (this.deps.settings && !this.deps.settings().desktop.nativeBrowser) return undefined;
    if ((await this.tabs(sessionId)).open) return undefined;
    try {
      return await this.host.attach(sessionId);
    } catch (error) {
      this.deps.log?.(
        `browser: native views unavailable, using the runner: ${errorMessage(error)}`,
      );
      return undefined;
    }
  }

  /** The desktop app quits: its open sessions move to the runner's Chromium. */
  private async handoff(sessions: HandoffSessions): Promise<string[]> {
    const failed: string[] = [];
    await Promise.all(
      sessions.map(async ({ sessionId, tabs, cookies }) => {
        try {
          if (!this.deps.repo.find(sessionId)) throw new Error("no such session");
          await runnerForSession(this.deps, sessionId).request(
            { name: "browser.handoff", sessionId, tabs, cookies },
            BROWSER_TIMEOUT_MS,
          );
        } catch (error) {
          this.deps.log?.(`browser: hand-off of ${sessionId}: ${errorMessage(error)}`);
          failed.push(sessionId);
        }
      }),
    );
    return failed;
  }
}

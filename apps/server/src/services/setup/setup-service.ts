import type {
  LoginCommandResponse,
  SetupCheck,
  SetupStatus,
  SetupToolId,
} from "@codeden/contracts";
import { defaultShell, findExecutable, refreshProcessPath } from "@codeden/providers";
import type { SettingsStore } from "../../settings-store";
import { errorMessage } from "../errors";
import type { Exec } from "../exec";
import type { BrowserProbe } from "./browsers";
import { CHECKS, type CheckEnv } from "./checks";
import { LOGIN_COMMANDS, type Locate, type LoginTool, loginCommandLine } from "./tool-lookup";

export interface SetupServiceDeps {
  exec: Exec;
  settings: Pick<SettingsStore, "get" | "update">;
  /** Per-check timeout (default 20s); a slow CLI never blocks the checklist. */
  checkTimeoutMs?: number;
  /** Cached results are reused for this long unless a refresh is requested (default 5 min). */
  cacheMs?: number;
  platform?: NodeJS.Platform;
  nodeVersion?: string;
  browserProbe?: Partial<BrowserProbe>;
  now?: () => number;
  /** Finds claude, codex and gh (default: PATH, then their known install locations). */
  locate?: Locate;
  /** The user's home folder, for known install locations (default: `os.homedir()`). */
  userHome?: string;
  /**
   * Picks up PATH changes made since CodeDen started, before an explicit re-check (default:
   * the Windows registry's user and machine `Path`; nothing elsewhere).
   */
  refreshPath?: () => Promise<unknown>;
  /** The setup terminal's shell, for sign-in commands (default: `defaultShell()`). */
  shell?: string;
  /**
   * Called after every completed check (not for cached results), e.g. so the runner re-detects
   * its providers after an install or a login and refreshes their model lists.
   */
  onChecked?: (status: SetupStatus) => void;
}

const ORDER: SetupToolId[] = [
  "claude",
  "codex",
  "opencode",
  "cursor",
  "gh",
  "git",
  "browser",
  "node",
];
/** Agent providers: setup is ready when at least one is installed and signed in. */
export const PROVIDER_CHECKS: readonly SetupToolId[] = ["claude", "codex", "opencode", "cursor"];

/**
 * First-run setup and re-checks on launch (§14). Runs every detection in parallel with a
 * timeout each, caches the result, and records which tools changed state since the last run.
 */
export class SetupService {
  private cached: SetupStatus | undefined;
  private running: Promise<SetupStatus> | undefined;

  constructor(private readonly deps: SetupServiceDeps) {}

  /** The last detection result, without re-checking (undefined before the first check). */
  get lastStatus(): SetupStatus | undefined {
    return this.cached;
  }

  /** Cached status, re-checked when stale or when `refresh` is set. */
  async status(opts: { refresh?: boolean } = {}): Promise<SetupStatus> {
    const now = this.now();
    const fresh =
      this.cached && now - Date.parse(this.cached.checkedAt) < (this.deps.cacheMs ?? 300_000);
    if (this.cached && fresh && !opts.refresh) {
      return { ...this.cached, setupCompleted: this.deps.settings.get().setup.completed };
    }
    this.running ??= this.refreshThenCheck(opts.refresh === true).finally(() => {
      this.running = undefined;
    });
    return this.running;
  }

  /** Persist that the user finished the checklist. */
  complete(): SetupStatus["setupCompleted"] {
    this.deps.settings.update({
      setup: { completed: true, completedAt: new Date().toISOString() },
    });
    return true;
  }

  /**
   * The command to run in a terminal to sign `tool` in: the copy the last check found, by
   * its full path, so the terminal's own PATH lookup is not involved.
   */
  loginCommand(tool: LoginTool): LoginCommandResponse {
    const check = this.cached?.checks.find((c) => c.id === tool);
    const program = check?.installed ? check.executablePath : null;
    const args = LOGIN_COMMANDS[tool].slice(1);
    return { tool, command: loginCommandLine(tool, this.shell(), program), args };
  }

  private async refreshThenCheck(refresh: boolean): Promise<SetupStatus> {
    if (refresh) {
      try {
        await (this.deps.refreshPath ?? refreshProcessPath)();
      } catch {
        // Checks run with the PATH this process has.
      }
    }
    return this.runChecks();
  }

  private shell(): string {
    return this.deps.shell ?? defaultShell();
  }

  private async runChecks(): Promise<SetupStatus> {
    const userHome = this.deps.userHome;
    const env: CheckEnv = {
      exec: this.deps.exec,
      locate:
        this.deps.locate ?? ((name, opts) => findExecutable(name, { home: userHome, ...opts })),
      shell: this.shell(),
      platform: this.deps.platform ?? process.platform,
      nodeVersion: this.deps.nodeVersion ?? process.version,
      now: this.now(),
      browserProbe: this.deps.browserProbe,
    };
    const checks = await Promise.all(ORDER.map((id) => this.timed(id, env)));
    const previous = this.cached;
    const warnings = checks
      .filter((c) => c.state === "warning" || this.regressed(previous, c))
      .map((c) => ({ id: c.id, message: c.message }));
    const status: SetupStatus = {
      checkedAt: new Date(this.now()).toISOString(),
      setupCompleted: this.deps.settings.get().setup.completed,
      ready: checks.some(
        (c) => PROVIDER_CHECKS.includes(c.id) && c.installed && c.loggedIn === true,
      ),
      checks,
      warnings,
    };
    this.cached = status;
    try {
      this.deps.onChecked?.(status);
    } catch {
      // A failing listener must not fail the check.
    }
    return status;
  }

  private regressed(previous: SetupStatus | undefined, check: SetupCheck): boolean {
    const before = previous?.checks.find((c) => c.id === check.id);
    return before?.state === "ok" && check.state === "missing";
  }

  private async timed(id: SetupToolId, env: CheckEnv): Promise<SetupCheck> {
    const started = this.now();
    const timeoutMs = this.deps.checkTimeoutMs ?? 20_000;
    let timer: NodeJS.Timeout | undefined;
    try {
      const result = await Promise.race([
        CHECKS[id](env),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error(`timed out after ${timeoutMs}ms`)), timeoutMs);
        }),
      ]);
      return { ...result, durationMs: Math.max(0, this.now() - started) };
    } catch (error) {
      return {
        id,
        label: id,
        state: "error",
        installed: false,
        version: null,
        executablePath: null,
        loggedIn: null,
        authMethod: null,
        account: null,
        loginExpiresAt: null,
        message: `Check failed: ${errorMessage(error)}`,
        fix: null,
        durationMs: Math.max(0, this.now() - started),
      };
    } finally {
      clearTimeout(timer);
    }
  }

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }
}

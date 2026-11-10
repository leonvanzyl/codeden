import type { ProviderIssue, ProviderStatus } from "@codeden/contracts";
import { type ResolvedCommand, runCommand } from "../util/exec";
import { compareVersions, parseVersion } from "../util/version";
import { locateOpenCode } from "./locate";
import type { OpenCodeProbe } from "./probe";

/**
 * Oldest OpenCode the adapter is tested against: the v2 HTTP API (`/api/...`), `serve --stdio`
 * and the `{ action, resource, effect }` permission rules. OpenCode 1.x is a different API.
 */
export const OPENCODE_MIN_VERSION = "2.2.0";

/** How to install OpenCode 2 (its npm package ships a native binary on every OS). */
export const OPENCODE_INSTALL_COMMAND = "npm install -g @opencode/cli";
export const OPENCODE_UPGRADE_COMMAND = "opencode upgrade";
export const OPENCODE_LOGIN_COMMAND = "opencode auth login";

/** OpenCode's own free models need no credentials; this provider id serves them. */
const FREE_TIER_PROVIDER = "opencode";

export interface OpenCodeDetectOptions {
  executable?: ResolvedCommand;
  /** How to find `opencode` when no executable is given (default `locateOpenCode`). */
  locate?: () => ResolvedCommand | undefined;
  timeoutMs?: number;
  /** Reads providers and credentials from a short-lived server (`probeOpenCode`). */
  probe?: (exe: ResolvedCommand) => Promise<OpenCodeProbe>;
}

/**
 * `opencode --version`, then a probe of a private server for the providers it can use
 * (§14). Never throws. "Signed in" means at least one provider has a saved credential, an API
 * key in the environment or a config entry; OpenCode's free models alone count as signed in
 * too (they work without an account), reported as `authMethod: "free"`.
 */
export async function detectOpenCode(opts: OpenCodeDetectOptions = {}): Promise<ProviderStatus> {
  const status: ProviderStatus = {
    providerId: "opencode",
    installed: false,
    version: null,
    executablePath: null,
    loggedIn: null,
    authMethod: null,
    account: null,
    loginExpiresAt: null,
    supported: false,
    issues: [],
    checkedAt: new Date().toISOString(),
  };
  const issues: ProviderIssue[] = [];
  const exe = opts.executable ?? (opts.locate ?? locateOpenCode)();
  if (!exe) {
    issues.push({
      code: "not_installed",
      message: "OpenCode is not installed (no `opencode` on PATH).",
      fix: { kind: "install", command: OPENCODE_INSTALL_COMMAND },
    });
    return { ...status, issues };
  }
  const executablePath = exe.kind === "node-script" ? exe.script : exe.path;
  const versionRun = await runCommand(exe, ["--version"], { timeoutMs: opts.timeoutMs ?? 15_000 });
  const version = parseVersion(`${versionRun.stdout}\n${versionRun.stderr}`);
  if (versionRun.error || !version) {
    issues.push({
      code: "detect_failed",
      message: `Could not run \`opencode --version\`: ${versionRun.error?.message ?? (versionRun.timedOut ? "timed out" : versionRun.stderr.trim() || "no version in output")}`,
    });
    return { ...status, executablePath, issues };
  }
  const supported = compareVersions(version, OPENCODE_MIN_VERSION) >= 0;
  if (!supported) {
    const major = Number.parseInt(version, 10);
    issues.push({
      code: "version_unsupported",
      message:
        major < 2
          ? `OpenCode ${version} is OpenCode 1, which CodeDen does not support. Install OpenCode 2.`
          : `OpenCode ${version} is older than the tested minimum ${OPENCODE_MIN_VERSION}.`,
      fix:
        major < 2
          ? { kind: "install", command: OPENCODE_INSTALL_COMMAND }
          : { kind: "upgrade", command: OPENCODE_UPGRADE_COMMAND },
    });
    return { ...status, installed: true, version, executablePath, issues };
  }
  const auth = await readAuth(exe, opts);
  if (auth.loggedIn === false) {
    issues.push({
      code: "not_logged_in",
      message: "OpenCode has no model provider. Connect one with `opencode auth login`.",
      fix: { kind: "login", command: OPENCODE_LOGIN_COMMAND },
    });
  } else if (auth.loggedIn === null) {
    issues.push({
      code: "detect_failed",
      message: `Could not read OpenCode's providers: ${auth.error ?? "unknown error"}`,
    });
  }
  return {
    ...status,
    installed: true,
    version,
    executablePath,
    supported,
    loggedIn: auth.loggedIn,
    authMethod: auth.authMethod,
    account: auth.account,
    issues,
  };
}

/** Login state from a probe. */
export function authFromProbe(probe: Pick<OpenCodeProbe, "providers" | "connected">): {
  loggedIn: boolean;
  authMethod: string | null;
  account: string | null;
} {
  if (probe.connected.length) {
    return {
      loggedIn: true,
      authMethod: "credentials",
      account: probe.connected.join(", "),
    };
  }
  const others = probe.providers.filter((p) => p.id !== FREE_TIER_PROVIDER);
  if (others.length) {
    return {
      loggedIn: true,
      authMethod: "environment",
      account: others.map((p) => p.id).join(", "),
    };
  }
  if (probe.providers.length) return { loggedIn: true, authMethod: "free", account: null };
  return { loggedIn: false, authMethod: null, account: null };
}

async function readAuth(
  exe: ResolvedCommand,
  opts: OpenCodeDetectOptions,
): Promise<{
  loggedIn: boolean | null;
  authMethod: string | null;
  account: string | null;
  error?: string;
}> {
  if (!opts.probe) return { loggedIn: null, authMethod: null, account: null, error: "no probe" };
  try {
    return authFromProbe(await opts.probe(exe));
  } catch (error) {
    const reason = (error instanceof Error ? error.message : String(error)).slice(0, 300);
    return { loggedIn: null, authMethod: null, account: null, error: reason };
  }
}

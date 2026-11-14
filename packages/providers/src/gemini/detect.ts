import type { ProviderIssue, ProviderStatus } from "@codeden/contracts";
import { brokenInstallMessage, type DetectExeOptions, lookupForDetect } from "../util/detect-exe";
import type { ResolvedCommand } from "../util/exec";
import { compareVersions } from "../util/version";
import { type GeminiAuth, readGeminiAuth } from "./auth";
import type { GeminiProbe } from "./probe";

/**
 * Oldest Gemini CLI CodeDen supports. 0.67.0 names the MCP server and tool in its permission
 * requests (so CodeDen's own tools are recognised), and 0.68.0 replays a loaded session's
 * history before it answers `session/load` (so none of it leaks into the next turn).
 */
export const GEMINI_MIN_VERSION = "0.68.0";
export const GEMINI_INSTALL_COMMAND = "npm install -g @google/gemini-cli";
export const GEMINI_UPGRADE_COMMAND = "npm install -g @google/gemini-cli@latest";
/** Gemini CLI has no login command: started on its own, it asks how to sign in. */
export const GEMINI_LOGIN_COMMAND = "gemini";

/** Whether a Gemini CLI version is one CodeDen supports (preview and nightly builds count by their number). */
export function isSupportedGeminiVersion(version: string | null | undefined): boolean {
  return !!version && compareVersions(version, GEMINI_MIN_VERSION) >= 0;
}

/** "Gemini CLI 0.36.0 is too old (needs 0.68.0+)": detection, the setup check and a refused open. */
export function geminiTooOldMessage(version: string | null | undefined): string {
  return `Gemini CLI ${version || "(unknown version)"} is too old (needs ${GEMINI_MIN_VERSION}+)`;
}

export interface GeminiDetectOptions extends DetectExeOptions {
  /** Start `gemini --acp` once to check it answers (`probeGemini`); supported versions only. */
  probe?: (exe: ResolvedCommand, version: string | null) => Promise<GeminiProbe>;
  /** Reads the login (default `readGeminiAuth()`: the user's Gemini folder and environment). */
  auth?: () => GeminiAuth;
}

/**
 * Find a working `gemini` (PATH, then Homebrew's folders on macOS), check its version and that
 * its ACP server answers, and read its login from its own settings (§14). The user's own login
 * is reused; credentials are never read or copied. Never throws.
 */
export async function detectGemini(opts: GeminiDetectOptions = {}): Promise<ProviderStatus> {
  const status: ProviderStatus = {
    providerId: "gemini",
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
  const install = { kind: "install" as const, command: GEMINI_INSTALL_COMMAND };
  const upgrade = { kind: "upgrade" as const, command: GEMINI_UPGRADE_COMMAND };
  const lookup = await lookupForDetect("gemini", { ...opts, timeoutMs: opts.timeoutMs ?? 15_000 });
  const broken = lookup.broken.length > 0 ? { broken: lookup.broken } : {};
  const exe = lookup.command;
  if (!exe) {
    issues.push(
      lookup.broken.length > 0
        ? {
            code: "broken_install",
            message: brokenInstallMessage("Gemini CLI", lookup.broken),
            fix: install,
          }
        : {
            code: "not_installed",
            message: "Gemini CLI is not installed (no `gemini` on PATH).",
            fix: install,
          },
    );
    return { ...status, ...broken, issues };
  }
  const found = {
    ...status,
    ...broken,
    installed: true,
    version: lookup.version,
    executablePath: exe.kind === "node-script" ? exe.script : exe.path,
  };
  if (!isSupportedGeminiVersion(lookup.version)) {
    // Sessions refuse to open on it (`GeminiAdapter.openSession`): `minVersion` makes it unavailable.
    issues.push({
      code: "version_unsupported",
      message: `${geminiTooOldMessage(lookup.version)}. Update it.`,
      fix: upgrade,
      minVersion: GEMINI_MIN_VERSION,
    });
    return { ...found, issues };
  }
  const auth = (opts.auth ?? (() => readGeminiAuth()))();
  let supported = true;
  const probe = await opts.probe?.(exe, lookup.version);
  if (probe && !probe.acp) {
    supported = false;
    issues.push({
      code: "version_unsupported",
      message: `Gemini CLI ${lookup.version} did not start its ACP server (\`gemini --acp\`)${probe.error ? `: ${probe.error}` : ""}. Update it.`,
      fix: upgrade,
    });
  }
  if (auth.loggedIn === false) {
    issues.push({
      code: "not_logged_in",
      message:
        "Gemini CLI is not signed in. Run `gemini` and sign in with Google, or set GEMINI_API_KEY.",
      fix: { kind: "login", command: GEMINI_LOGIN_COMMAND },
    });
  } else if (auth.loggedIn === null) {
    issues.push({
      code: "detect_failed",
      message: `Could not confirm Gemini CLI's login${auth.note ? `: ${auth.note}` : ""}.`,
      fix: { kind: "login", command: GEMINI_LOGIN_COMMAND },
    });
  }
  return {
    ...found,
    supported,
    loggedIn: auth.loggedIn,
    authMethod: auth.authMethod,
    account: auth.account,
    issues,
  };
}

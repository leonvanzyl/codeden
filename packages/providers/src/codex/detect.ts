import type { ProviderIssue, ProviderStatus } from "@codeden/contracts";
import {
  brokenInstallMessage,
  type DetectExeOptions,
  lookupForDetect,
  outdatedVersionMessage,
} from "../util/detect-exe";
import { runCommand } from "../util/exec";
import { compareVersions } from "../util/version";

/** Oldest Codex version whose app-server protocol matches the generated types. */
export const CODEX_MIN_VERSION = "0.160.0";

const INSTALL = { kind: "install", command: "npm install -g @openai/codex" } as const;

export type CodexDetectOptions = DetectExeOptions;

/**
 * Find a working `codex` (PATH, then the standalone installer's folders; a copy older than
 * `CODEX_MIN_VERSION` only when there is no newer one), then `codex login status` (§14).
 * Never throws.
 */
export async function detectCodex(opts: CodexDetectOptions = {}): Promise<ProviderStatus> {
  const status: ProviderStatus = {
    providerId: "codex",
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
  const timeoutMs = opts.timeoutMs ?? 15_000;
  const lookup = await lookupForDetect("codex", {
    ...opts,
    timeoutMs,
    minVersion: CODEX_MIN_VERSION,
  });
  const broken = lookup.broken.length > 0 ? { broken: lookup.broken } : {};
  const exe = lookup.command;
  if (!exe) {
    issues.push(
      lookup.broken.length > 0
        ? {
            code: "broken_install",
            message: brokenInstallMessage("Codex", lookup.broken),
            fix: INSTALL,
          }
        : {
            code: "not_installed",
            message: "Codex is not installed (no `codex` on PATH or in its install folder).",
            fix: INSTALL,
          },
    );
    return { ...status, ...broken, issues };
  }
  const version = lookup.version;
  const executablePath = exe.kind === "node-script" ? exe.script : exe.path;
  const supported = version !== null && compareVersions(version, CODEX_MIN_VERSION) >= 0;
  if (!supported) {
    // The login state is not asked of a copy this old: it can fail on a current configuration
    // and read as "not logged in", which would hide the real cause.
    issues.push({
      code: "version_unsupported",
      message: outdatedVersionMessage("Codex", version, executablePath, CODEX_MIN_VERSION),
      fix: { kind: "upgrade", command: "npm install -g @openai/codex@latest" },
    });
    return { ...status, installed: true, version, executablePath, ...broken, issues };
  }
  const login = await runCommand(exe, ["login", "status"], { timeoutMs });
  const auth = parseCodexLoginStatus(`${login.stdout}\n${login.stderr}`, login.code);
  if (auth.loggedIn === false) {
    issues.push({
      code: "not_logged_in",
      message: "Codex is not logged in.",
      fix: { kind: "login", command: "codex login" },
    });
  } else if (auth.loggedIn === null) {
    issues.push({ code: "detect_failed", message: "Could not read `codex login status`." });
  }
  return {
    ...status,
    installed: true,
    version,
    executablePath,
    supported: true,
    loggedIn: auth.loggedIn,
    authMethod: auth.authMethod,
    ...broken,
    issues,
  };
}

/** Parse `codex login status` text, e.g. `Logged in using ChatGPT` / `Not logged in`. */
export function parseCodexLoginStatus(
  output: string,
  exitCode: number | null,
): { loggedIn: boolean | null; authMethod: string | null } {
  if (/not logged in/i.test(output)) return { loggedIn: false, authMethod: null };
  const m = /logged in(?: using| with)?\s+(?:an?\s+)?([^\r\n]+)/i.exec(output);
  if (m) {
    const raw = (m[1] ?? "").trim().toLowerCase();
    const authMethod = raw.includes("chatgpt")
      ? "chatgpt"
      : raw.includes("api key")
        ? "api_key"
        : raw || null;
    return { loggedIn: true, authMethod };
  }
  if (exitCode !== null && exitCode !== 0 && output.trim())
    return { loggedIn: false, authMethod: null };
  return { loggedIn: null, authMethod: null };
}

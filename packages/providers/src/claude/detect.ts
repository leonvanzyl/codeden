import type { ProviderIssue, ProviderStatus } from "@codeden/contracts";
import {
  brokenInstallMessage,
  type DetectExeOptions,
  lookupForDetect,
  outdatedVersionMessage,
} from "../util/detect-exe";
import { runCommand } from "../util/exec";
import { compareVersions } from "../util/version";

/** Oldest Claude Code version the adapter is tested against (pinned SDK 0.3.330). */
export const CLAUDE_MIN_VERSION = "2.1.290";
const LOGIN_EXPIRY_WARNING_MS = 3 * 24 * 60 * 60 * 1000;
const INSTALL = { kind: "install", command: "npm install -g @anthropic-ai/claude-code" } as const;

export type ClaudeDetectOptions = DetectExeOptions;

/**
 * Find a working `claude` (PATH, then the native installer's folders; a copy older than
 * `CLAUDE_MIN_VERSION` only when there is no newer one), then `claude auth status` (§14).
 * Never throws.
 */
export async function detectClaude(opts: ClaudeDetectOptions = {}): Promise<ProviderStatus> {
  const checkedAt = new Date().toISOString();
  const status: ProviderStatus = {
    providerId: "claude",
    installed: false,
    version: null,
    executablePath: null,
    loggedIn: null,
    authMethod: null,
    account: null,
    loginExpiresAt: null,
    supported: false,
    issues: [],
    checkedAt,
  };
  const issues: ProviderIssue[] = [];
  const timeoutMs = opts.timeoutMs ?? 15_000;
  const lookup = await lookupForDetect("claude", {
    ...opts,
    timeoutMs,
    minVersion: CLAUDE_MIN_VERSION,
  });
  const broken = lookup.broken.length > 0 ? { broken: lookup.broken } : {};
  const exe = lookup.command;
  if (!exe) {
    issues.push(
      lookup.broken.length > 0
        ? {
            code: "broken_install",
            message: brokenInstallMessage("Claude Code", lookup.broken),
            fix: INSTALL,
          }
        : {
            code: "not_installed",
            message: "Claude Code is not installed (no `claude` on PATH or in ~/.local/bin).",
            fix: INSTALL,
          },
    );
    return { ...status, ...broken, issues };
  }
  const version = lookup.version;
  const executablePath = exe.kind === "node-script" ? exe.script : exe.path;
  const supported = version !== null && compareVersions(version, CLAUDE_MIN_VERSION) >= 0;
  if (!supported) {
    // The login state is not asked of a copy this old: it has no `auth status` (it takes the
    // words as a prompt and spends a model call), so the answer would hide the real cause.
    issues.push({
      code: "version_unsupported",
      message: outdatedVersionMessage("Claude Code", version, executablePath, CLAUDE_MIN_VERSION),
      fix: { kind: "upgrade", command: "claude update" },
    });
    return { ...status, installed: true, version, executablePath, ...broken, issues };
  }
  const authRun = await runCommand(exe, ["auth", "status"], { timeoutMs });
  const auth = parseClaudeAuthStatus(authRun.stdout);
  if (auth.loggedIn === false) {
    issues.push({
      code: "not_logged_in",
      message: "Claude Code is not logged in.",
      fix: { kind: "login", command: "claude auth login" },
    });
  } else if (auth.loggedIn === null) {
    const why = authRun.error?.message ?? (authRun.timedOut ? "timed out" : `exit ${authRun.code}`);
    issues.push({
      code: "detect_failed",
      message: `Could not read \`claude auth status\` (${why}).`,
    });
  } else if (
    auth.loginExpiresAt &&
    Date.parse(auth.loginExpiresAt) - Date.now() < LOGIN_EXPIRY_WARNING_MS
  ) {
    issues.push({
      code: "login_expiring",
      message: `Claude Code login expires at ${auth.loginExpiresAt}.`,
      fix: { kind: "login", command: "claude auth login" },
    });
  }
  return {
    ...status,
    installed: true,
    version,
    executablePath,
    supported: true,
    ...auth,
    ...broken,
    issues,
  };
}

/** Parse `claude auth status` JSON (`loggedIn`, `authMethod`, `email`, `loginExpiresAt`). */
export function parseClaudeAuthStatus(
  stdout: string,
): Pick<ProviderStatus, "loggedIn" | "authMethod" | "account" | "loginExpiresAt"> {
  const unknown = { loggedIn: null, authMethod: null, account: null, loginExpiresAt: null };
  const start = stdout.indexOf("{");
  if (start < 0) return unknown;
  try {
    const json = JSON.parse(stdout.slice(start)) as Record<string, unknown>;
    const expires = typeof json.loginExpiresAt === "string" ? json.loginExpiresAt : null;
    return {
      loggedIn: typeof json.loggedIn === "boolean" ? json.loggedIn : null,
      authMethod: typeof json.authMethod === "string" ? json.authMethod : null,
      account: typeof json.email === "string" ? json.email : null,
      loginExpiresAt:
        expires && !Number.isNaN(Date.parse(expires)) ? new Date(expires).toISOString() : null,
    };
  } catch {
    return unknown;
  }
}

import path from "node:path";
import type { ProviderIssue, ProviderStatus } from "@codeden/contracts";
import { brokenInstallMessage, type DetectExeOptions, lookupForDetect } from "../util/detect-exe";
import { type ResolvedCommand, runCommand } from "../util/exec";
import type { ExecutableLookup } from "../util/locate";
import { CURSOR_COMMANDS, isCursorVersion } from "./locate";
import type { CursorProbe } from "./probe";

/** Cursor's installer, per platform. */
export function cursorInstallCommand(platform: NodeJS.Platform = process.platform): string {
  return platform === "win32"
    ? "irm 'https://cursor.com/install?win32=true' | iex"
    : "curl https://cursor.com/install -fsS | bash";
}

export interface CursorDetectOptions extends DetectExeOptions {
  /** Start `agent acp` once to check it answers (and to list models). */
  probe?: (exe: ResolvedCommand, signedIn: boolean) => Promise<CursorProbe>;
  /** Read for `CURSOR_API_KEY` / `CURSOR_AUTH_TOKEN` (default `process.env`); never logged. */
  env?: NodeJS.ProcessEnv;
}

/**
 * Find a working Cursor CLI (`cursor-agent`, then `agent`, on PATH and in its installer's
 * folders), read its login with `agent status`, and check it has the `acp` command (§14).
 * The user's own login is reused; credentials are never read or copied. Never throws.
 */
export async function detectCursor(opts: CursorDetectOptions = {}): Promise<ProviderStatus> {
  const status: ProviderStatus = {
    providerId: "cursor",
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
  const install = { kind: "install" as const, command: cursorInstallCommand() };
  const lookup = await findCursor({ ...opts, timeoutMs });
  const broken = lookup.broken.length > 0 ? { broken: lookup.broken } : {};
  const exe = lookup.command;
  if (!exe) {
    issues.push(
      lookup.broken.length > 0
        ? {
            code: "broken_install",
            message: brokenInstallMessage("Cursor CLI", lookup.broken),
            fix: install,
          }
        : {
            code: "not_installed",
            message: "The Cursor CLI is not installed (no `agent` or `cursor-agent` on PATH).",
            fix: install,
          },
    );
    return { ...status, ...broken, issues };
  }
  const name = commandName(exe);
  const run = await runCommand(exe, ["status"], { timeoutMs });
  const auth = parseCursorStatus(`${run.stdout}\n${run.stderr}`, run.code, opts.env ?? process.env);
  let supported = true;
  const probe = await opts.probe?.(exe, auth.loggedIn === true);
  if (probe && !probe.acp) {
    supported = false;
    issues.push({
      code: "version_unsupported",
      message: `This Cursor CLI${lookup.version ? ` ${lookup.version}` : ""} did not start its ACP server (\`${name} acp\`)${probe.error ? `: ${probe.error}` : ""}. Update it.`,
      fix: { kind: "upgrade", command: `${name} update` },
    });
  }
  if (auth.loggedIn === false) {
    issues.push({
      code: "not_logged_in",
      message: "The Cursor CLI is not signed in.",
      fix: { kind: "login", command: `${name} login` },
    });
  } else if (auth.loggedIn === null) {
    issues.push({ code: "detect_failed", message: `Could not read \`${name} status\`.` });
  }
  return {
    ...status,
    installed: true,
    version: lookup.version,
    executablePath: exe.kind === "node-script" ? exe.script : exe.path,
    supported,
    loggedIn: auth.loggedIn,
    authMethod: auth.authMethod,
    account: auth.account,
    ...broken,
    issues,
  };
}

/** `cursor-agent`, else an `agent` whose version is Cursor's. Broken copies are collected. */
export async function findCursor(opts: DetectExeOptions): Promise<ExecutableLookup> {
  if (opts.lookup || opts.executable) return lookupForDetect(CURSOR_COMMANDS[0], opts);
  const broken: ExecutableLookup["broken"] = [];
  for (const name of CURSOR_COMMANDS) {
    const found = await lookupForDetect(name, opts);
    broken.push(...found.broken);
    if (found.command && (name === "cursor-agent" || isCursorVersion(found.version))) {
      return { ...found, broken };
    }
  }
  return { version: null, broken };
}

/** `agent` or `cursor-agent`: the name to put in fix commands. */
function commandName(exe: ResolvedCommand): string {
  const file = path.win32.basename(exe.kind === "node-script" ? exe.script : exe.path);
  return file.replace(/\.(exe|cmd|bat|ps1|js|mjs)$/i, "") === "cursor-agent"
    ? "cursor-agent"
    : "agent";
}

/**
 * Parse `agent status`: "Logged in as you@example.com" / "Not logged in". An API key or auth
 * token in the environment also signs the CLI in (only their presence is read).
 */
export function parseCursorStatus(
  output: string,
  exitCode: number | null,
  env: NodeJS.ProcessEnv = {},
): { loggedIn: boolean | null; authMethod: string | null; account: string | null } {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: strips ANSI colour codes.
  const text = output.replace(/\x1b\[[0-9;]*m/g, "");
  const viaEnv = env.CURSOR_API_KEY ? "api_key" : env.CURSOR_AUTH_TOKEN ? "auth_token" : null;
  if (
    /not (logged|signed) in|logged out|unauthenticated|please (log|sign) ?in|no (active )?session/i.test(
      text,
    )
  ) {
    return viaEnv
      ? { loggedIn: true, authMethod: viaEnv, account: null }
      : { loggedIn: false, authMethod: null, account: null };
  }
  if (/(logged|signed) in|authenticated/i.test(text)) {
    const email = /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/.exec(text)?.[0] ?? null;
    return { loggedIn: true, authMethod: viaEnv ?? "cursor", account: email };
  }
  if (viaEnv) return { loggedIn: true, authMethod: viaEnv, account: null };
  if (exitCode !== null && exitCode !== 0 && text.trim()) {
    return { loggedIn: false, authMethod: null, account: null };
  }
  return { loggedIn: null, authMethod: null, account: null };
}

import path from "node:path";
import type { ProviderIssue, ProviderStatus } from "@codeden/contracts";
import { brokenInstallMessage, type DetectExeOptions, lookupForDetect } from "../util/detect-exe";
import { type ResolvedCommand, runCommand } from "../util/exec";
import type { ExecutableLookup } from "../util/locate";
import { CURSOR_COMMANDS, cursorBroken, cursorOnly, isCursorVersion } from "./locate";
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
  const auth = await readCursorLogin(exe, timeoutMs, opts.env ?? process.env);
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
  // `agent status` says signed in, but the CLI asked for a login when the probe listed models.
  const loginUnusable = auth.loggedIn === true && probe?.loginRequired === true;
  if (auth.loggedIn === false || loginUnusable) {
    issues.push({
      code: "not_logged_in",
      message: loginUnusable ? cursorLoginMessage(name) : "The Cursor CLI is not signed in.",
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
    loggedIn: loginUnusable ? false : auth.loggedIn,
    authMethod: auth.authMethod,
    account: auth.account,
    ...broken,
    issues,
  };
}

/**
 * `cursor-agent`, else the first `agent` whose `--version` is Cursor's: other programs called
 * `agent` are passed over (only `--version` runs on them) and not reported as broken.
 */
export async function findCursor(opts: DetectExeOptions): Promise<ExecutableLookup> {
  if (opts.lookup || opts.executable) return lookupForDetect(CURSOR_COMMANDS[0], opts);
  const broken: ExecutableLookup["broken"] = [];
  for (const name of CURSOR_COMMANDS) {
    const found = await lookupForDetect(name, {
      ...opts,
      locate: { ...opts.locate, validate: cursorOnly(opts.timeoutMs) },
    });
    broken.push(...cursorBroken(found.broken));
    // A copy whose earlier check is cached as working is still held to Cursor's version.
    if (found.command && isCursorVersion(found.version)) return { ...found, broken };
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
 * What the Cursor CLI prints when its stored login can't be used ("Error: Authentication
 * required. Run 'agent login' ..."). `agent status` can still say "Logged in" then (it only
 * reads that a login was stored), but ACP `authenticate` with `cursor_login` would open the
 * browser login.
 */
const LOGIN_REQUIRED = /authentication required|not (logged|signed) in|please (log|sign) ?in/i;

/** True when a Cursor CLI command failed because its login can't be used. */
export function cursorLoginRequired(code: number | null, output: string): boolean {
  return code !== 0 && LOGIN_REQUIRED.test(output);
}

/**
 * The message for a Cursor CLI whose login can't be used, with the command that renews it.
 * Matches the `auth` error kind (§7.3), so a failed session start reads as a sign-in problem.
 */
export function cursorLoginMessage(name = "agent"): string {
  return `The Cursor CLI needs you to sign in again: run \`${name} login\`, then try again.`;
}

/**
 * Before a session's ACP `authenticate`: `--list-models` runs the same login check without
 * ever opening a browser. Returns the error to fail with when the login can't be used, so
 * CodeDen never starts Cursor's browser login on its own (a factory or automation session
 * included). Any other outcome (a slow or offline CLI) lets the session go ahead.
 */
export async function cursorAuthGuard(
  exe: ResolvedCommand,
  timeoutMs = 15_000,
): Promise<string | undefined> {
  const run = await runCommand(exe, ["--list-models"], { timeoutMs });
  return cursorLoginRequired(run.code, `${run.stdout}\n${run.stderr}`)
    ? cursorLoginMessage(commandName(exe))
    : undefined;
}

/**
 * Run `agent status` and read the login from it (an API key or token in the environment
 * counts). Never throws; `loggedIn: null` when the output can't be read.
 */
export async function readCursorLogin(
  exe: ResolvedCommand,
  timeoutMs: number,
  env: NodeJS.ProcessEnv = process.env,
): Promise<ReturnType<typeof parseCursorStatus>> {
  const run = await runCommand(exe, ["status"], { timeoutMs });
  return parseCursorStatus(`${run.stdout}\n${run.stderr}`, run.code, env);
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
  // Both bill the user's Cursor plan, like a login.
  const viaEnv = env.CURSOR_API_KEY ? "cursor_key" : env.CURSOR_AUTH_TOKEN ? "cursor_token" : null;
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

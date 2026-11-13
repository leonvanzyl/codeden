import type { LoginToolId, SetupCheck, SetupCommand } from "@codeden/contracts";
import { brokenInstallMessage, type ExecutableLookup, shellCommandLine } from "@codeden/providers";
import type { Exec, ExecResult } from "../exec";

/** Finds a working copy of a tool (PATH, then known install locations); injectable for tests. */
export type Locate = (name: string) => Promise<ExecutableLookup>;

/**
 * A look-up through an `Exec` only (`<name> --version`): used when a server is given its own
 * `exec` (tests with fake CLIs) and no `locate`, so no real tool is ever looked for or run.
 */
export function execLocate(exec: Exec): Locate {
  return async (name) => {
    const run = await exec(name, ["--version"], { timeoutMs: 10_000 });
    if (run.notFound || run.code !== 0) return { version: null, broken: [] };
    const version = /\d+\.\d+\.\d+(?:-[\w.]+)?/.exec(run.stdout)?.[0] ?? null;
    return { command: { kind: "native", path: run.path ?? name }, version, broken: [] };
  };
}

/** Tools whose sign-in runs in the setup terminal, with the arguments that sign them in. */
export const LOGIN_COMMANDS = {
  claude: ["claude", "auth", "login"],
  codex: ["codex", "login"],
  opencode: ["opencode", "auth", "login"],
  cursor: ["agent", "login"],
  gh: ["gh", "auth", "login", "--web", "--git-protocol", "https"],
} as const satisfies Record<LoginToolId, readonly string[]>;

export type LoginTool = LoginToolId;

/**
 * The sign-in command typed into the setup terminal (§14 step 3). With a resolved `program`
 * it runs that exact file, quoted for `shell`, so a broken shim or an outdated PATH in the
 * terminal cannot get in the way: `& 'C:\Users\x\.local\bin\claude.exe' auth login`.
 */
export function loginCommandLine(tool: LoginTool, shell: string, program?: string | null): string {
  const [name, ...args] = LOGIN_COMMANDS[tool];
  return shellCommandLine(shell, program || name, args);
}

export function loginFix(tool: LoginTool, shell: string, program?: string | null): SetupCommand {
  return { kind: "login", command: loginCommandLine(tool, shell, program) };
}

type CheckResult = Omit<SetupCheck, "durationMs">;

/** A working copy, or the finished check for a tool that is missing or broken. */
export type ToolLookup =
  | { found: true; path: string; version: string | null; extra: Pick<SetupCheck, "broken"> }
  | { found: false; result: CheckResult };

/**
 * Look a tool up and turn "nothing found" and "found, but nothing runs" into honest checks:
 * not installed (with the install fix) or installed but broken (with the paths).
 */
export async function lookupTool(
  locate: Locate,
  name: string,
  check: Omit<CheckResult, "state" | "message">,
  notInstalled: { message: string; fix: SetupCommand },
): Promise<ToolLookup> {
  const lookup = await locate(name);
  const extra = lookup.broken.length > 0 ? { broken: lookup.broken } : {};
  if (lookup.command) {
    return { found: true, path: lookup.command.path, version: lookup.version, extra };
  }
  if (lookup.broken.length === 0) {
    return { found: false, result: { ...check, state: "missing", ...notInstalled } };
  }
  return {
    found: false,
    result: {
      ...check,
      ...extra,
      state: "missing",
      message: brokenInstallMessage(check.label, lookup.broken),
      fix: notInstalled.fix,
    },
  };
}

/** What went wrong running a command, for a check's details (never includes tokens). */
export function runDetail(command: string, run: ExecResult): string {
  if (run.timedOut) return `\`${command}\` did not finish in time.`;
  const parts = [`\`${command}\` exited with code ${run.code ?? "none"}.`];
  const stderr = clip(run.stderr);
  const stdout = clip(run.stdout);
  if (stderr) parts.push(`stderr: ${stderr}`);
  if (stdout) parts.push(`stdout: ${stdout}`);
  if (!stderr && !stdout) parts.push("It printed nothing.");
  return parts.join("\n");
}

function clip(text: string): string {
  const t = text.trim();
  return t.length > 300 ? `${t.slice(0, 297)}...` : t;
}

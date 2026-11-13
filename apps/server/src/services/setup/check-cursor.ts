import {
  cursorBroken,
  cursorOnly,
  isCursorVersion,
  parseCursorStatus,
  shellCommandLine,
} from "@codeden/providers";
import { base, type CheckEnv, type CheckResult, installFix } from "./check-base";
import { type Locate, loginFix, lookupTool, runDetail, type ToolLookup } from "./tool-lookup";

const NO_ACP =
  /unknown command|not a (valid )?command|invalid command|no such command|unrecognized/i;

/**
 * `cursor-agent`, else the first `agent` whose `--version` is Cursor's dated build. Other
 * programs called `agent` are passed over (only `--version` runs on them), not reported broken.
 */
async function findCursorTool(locate: Locate, platform: NodeJS.Platform): Promise<ToolLookup> {
  const notInstalled = {
    message: "The Cursor CLI is not installed",
    fix: installFix("cursor", platform),
  };
  const cursorLocate: Locate = async (name) => {
    const lookup = await locate(name, { validate: cursorOnly() });
    return { ...lookup, broken: cursorBroken(lookup.broken) };
  };
  const named = await lookupTool(cursorLocate, "cursor-agent", base("cursor"), notInstalled);
  if (named.found) return named;
  const agent = await lookupTool(cursorLocate, "agent", base("cursor"), notInstalled);
  if (agent.found) {
    return isCursorVersion(agent.version)
      ? agent
      : { found: false, result: { ...base("cursor"), state: "missing", ...notInstalled } };
  }
  return named.result.broken ? named : agent;
}

/**
 * The Cursor CLI (§14): a working `agent` (PATH, then its installer's folder), that it has the
 * ACP server CodeDen drives (`agent acp`; older builds need `agent update`), and `agent status`
 * for the login. The user's own login is reused; an API key in the environment also counts.
 */
export async function checkCursor({
  exec,
  locate,
  shell,
  platform,
}: CheckEnv): Promise<CheckResult> {
  const tool = await findCursorTool(locate, platform);
  if (!tool.found) return tool.result;
  const installed = {
    ...base("cursor"),
    ...tool.extra,
    installed: true,
    version: tool.version,
    executablePath: tool.path,
  };
  const acp = await exec(tool.path, ["acp", "--help"], { timeoutMs: 10_000 });
  if (!acp.timedOut && acp.code !== 0 && NO_ACP.test(`${acp.stdout}\n${acp.stderr}`)) {
    return {
      ...installed,
      state: "missing",
      message: "This Cursor CLI has no ACP server (`agent acp`); update it",
      detail: runDetail("agent acp --help", acp),
      fix: { kind: "upgrade", command: shellCommandLine(shell, tool.path, ["update"]) },
    };
  }
  const login = loginFix("cursor", shell, tool.path);
  const status = await exec(tool.path, ["status"], { timeoutMs: 10_000 });
  const auth = parseCursorStatus(`${status.stdout}\n${status.stderr}`, status.code, process.env);
  if (auth.loggedIn === null) {
    return {
      ...installed,
      state: "warning",
      message: "Could not read the Cursor login state",
      detail: runDetail("agent status", status),
      fix: login,
    };
  }
  if (!auth.loggedIn) {
    return {
      ...installed,
      loggedIn: false,
      state: "missing",
      message: "Not signed in to Cursor",
      fix: login,
    };
  }
  return {
    ...installed,
    loggedIn: true,
    authMethod: auth.authMethod,
    account: auth.account,
    state: "ok",
    message: "Signed in",
  };
}

import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { CODEDEN_VERSION, type SetupCheck } from "@codeden/contracts";
import {
  CLAUDE_SDK_VERSION,
  claudeSdkSource,
  importClaudeSdkFrom,
  installClaudeSdk,
  isClaudeSdkInstalled,
} from "@codeden/providers";
import {
  checkSetup,
  homePaths,
  installProblem,
  listInstalled,
  packageRoot,
  readLiveRunnerLock,
  readPointer,
} from "@codeden/server";
import type { LaunchInfo } from "./launcher";
import { findRunningServer } from "./running";

const MARK: Record<SetupCheck["state"], string> = {
  ok: "ok",
  warning: "!!",
  missing: "--",
  error: "xx",
};

/** Native dependencies (§16) and what breaks without them. */
const NATIVE: Array<[label: string, module: string, purpose: string]> = [
  ["Terminals", "node-pty", "the terminal panel is"],
  ["Keychain", "@napi-rs/keyring", "saved API keys are"],
];

/** Why a native module cannot load here, or null when it loads. */
function loadError(mod: string): string | null {
  try {
    createRequire(import.meta.url)(mod);
    return null;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return message.split(/\r?\n/)[0] ?? "error";
  }
}

/** The "Claude Code support" row: the on-demand Claude Agent SDK, loaded to prove it works. */
async function claudeSupport(depsDir: string): Promise<[string, string]> {
  if (claudeSdkSource() === "workspace") return ["ok", `SDK ${CLAUDE_SDK_VERSION} (workspace)`];
  if (!isClaudeSdkInstalled(depsDir)) {
    return ["--", "not installed yet; installs on first use, or run `codeden doctor --install`"];
  }
  try {
    await importClaudeSdkFrom(depsDir);
    return ["ok", `SDK ${CLAUDE_SDK_VERSION} in ${depsDir}`];
  } catch (error) {
    return ["xx", `installed but does not load: ${error instanceof Error ? error.message : error}`];
  }
}

/** `codeden doctor --install`: install Claude Code support now, printing npm's progress. */
async function installClaudeSupport(depsDir: string): Promise<boolean> {
  if (claudeSdkSource() === "workspace" || isClaudeSdkInstalled(depsDir)) return true;
  console.log(`Installing Claude Code support into ${depsDir} ...`);
  try {
    await installClaudeSdk({ depsDir, onProgress: (line) => console.log(`  ${line}`) });
    return true;
  } catch (error) {
    console.error(
      `Claude Code support could not be installed: ${error instanceof Error ? error.message : error}`,
    );
    console.error(
      "Check your network and npm configuration, then run `codeden doctor --install` again.",
    );
    return false;
  }
}

/**
 * `codeden doctor`: diagnostics. Runs the same detection checks as the first-run setup
 * screen (§14): installed versions, logins and supported adapter versions, with the one
 * command that fixes each problem. Exits non-zero when CodeDen cannot run a session.
 */
export async function doctor(
  home: string,
  opts: { install?: boolean; launch?: LaunchInfo } = {},
): Promise<number> {
  const paths = homePaths(home);
  const installed = opts.install ? await installClaudeSupport(paths.deps) : true;
  const [status, server] = await Promise.all([
    checkSetup({ home }),
    findRunningServer(paths.serverLock),
  ]);
  const runner = readLiveRunnerLock(paths.runnerLock);
  const rows: Array<[string, string, string]> = [
    ["ok", "CodeDen", CODEDEN_VERSION],
    ...versionRows(home, opts.launch),
    [existsSync(home) ? "ok" : "--", "Data directory", home],
    [
      server ? "ok" : "--",
      "Server",
      server ? `running on port ${server.port} (pid ${server.pid})` : "not running",
    ],
    [
      runner ? "ok" : "--",
      "Runner",
      runner ? `running on port ${runner.port} (pid ${runner.pid})` : "not running",
    ],
  ];
  for (const [label, mod, purpose] of NATIVE) {
    const error = loadError(mod);
    rows.push([error ? "xx" : "ok", label, error ? `${purpose} unavailable: ${error}` : mod]);
  }
  for (const check of status.checks) {
    const detail = [check.version, check.message].filter(Boolean).join(" - ");
    rows.push([MARK[check.state], check.label, detail]);
    if (check.id === "claude") {
      const [mark, text] = await claudeSupport(paths.deps);
      rows.push([mark, "Claude Code support", text]);
    }
  }
  for (const [mark, name, detail] of rows) console.log(`${mark}  ${name.padEnd(20)} ${detail}`);

  const fixes = status.checks.filter((c) => c.state !== "ok" && c.fix);
  if (fixes.length > 0) {
    console.log("\nTo fix:");
    for (const check of fixes) {
      const fix = check.fix as NonNullable<SetupCheck["fix"]>;
      console.log(`  ${check.label}: ${fix.command}${fix.url ? ` (${fix.url})` : ""}`);
    }
  }
  for (const warning of status.warnings) console.log(`\nWarning: ${warning.message}`);
  if (!status.ready) {
    console.log(
      "\nInstall and sign in to Claude Code, Codex or OpenCode: at least one agent provider is required.",
    );
  }
  const node = status.checks.find((c) => c.id === "node");
  const git = status.checks.find((c) => c.id === "git");
  return installed && status.ready && node?.state !== "missing" && git?.state !== "missing" ? 0 : 1;
}

/** Self-update rows (§16): the copy you ran, the installed versions and which one starts. */
function versionRows(home: string, launch?: LaunchInfo): Array<[string, string, string]> {
  const rows: Array<[string, string, string]> = [];
  if (launch) {
    const how = launch.kind === "source" ? "source checkout, never switches" : launch.kind;
    rows.push(["ok", "Launched copy", `${launch.binVersion} (${how}) ${launch.binEntry}`]);
    if (launch.warning) rows.push(["!!", "Launcher", launch.warning]);
  }
  const installed = listInstalled(home);
  rows.push([
    "ok",
    "Installed versions",
    installed.length === 0
      ? "none (updates install into <home>/app)"
      : installed
          .map((v) => `${v.version}${v.current ? " (current)" : ""}${v.valid ? "" : " (broken)"}`)
          .join(", "),
  ]);
  const pointer = readPointer(home);
  if (pointer) {
    const problem = installProblem(packageRoot(home, pointer.version), pointer.version);
    rows.push(
      problem
        ? [
            "xx",
            "Current version",
            `${pointer.version} can't start: ${problem}; run \`codeden update\``,
          ]
        : [
            "ok",
            "Current version",
            `${pointer.version} starts on launch (previous: ${pointer.previous ?? "none"})`,
          ],
    );
  }
  return rows;
}

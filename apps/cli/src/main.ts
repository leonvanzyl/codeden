/**
 * `codeden` CLI (§16): start the server (which ensures the runner) and open the browser.
 *   codeden [--port <n>] [--home <dir>] [--no-open]
 *   codeden doctor [--install]
 *   codeden update [--rollback]
 *   codeden stop
 *   codeden password [--generate]
 *   codeden network [on|off]
 *   codeden runner-link [--home <dir>]
 * Loaded by `cli.ts` once the launcher has picked the version to run. Kept light: the server
 * code (`commands.ts`) loads only for the commands that need it, never for `runner-link`.
 */
import { CODEDEN_VERSION, RunnerLinkExit } from "@codeden/contracts";
import { HELP, type ParsedCli, parseCli } from "./args";
import { homeFromArgs } from "./launcher";

/**
 * `codeden runner-link`: splice this process's stdin and stdout to the runner in `home`
 * (`docs/remote-runners.md` §6). Stdout carries only protocol frames; everything else goes to
 * stderr. Exits with a `RunnerLinkExit` code once the link ends.
 */
async function runnerLinkCommand(home: string, extraArgs: boolean): Promise<number> {
  if (extraArgs) {
    console.error("Usage: codeden runner-link [--home <dir>]");
    return RunnerLinkExit.usage;
  }
  const { runRunnerLink } = await import("@codeden/runner/link");
  const code = await runRunnerLink({
    home,
    stdin: process.stdin,
    stdout: process.stdout,
    stderr: process.stderr,
  });
  // Every frame written reaches the server before the process exits.
  await new Promise<void>((resolve) => process.stdout.write("", () => resolve()));
  return code;
}

async function main(): Promise<number> {
  const args = process.argv.slice(2);
  let parsed: ParsedCli;
  try {
    parsed = parseCli(args);
  } catch (error) {
    // A usage error (exit 2), told on stderr: `runner-link`'s stdout is for frames only.
    console.error(`${error instanceof Error ? error.message : String(error)}\n\n${HELP}`);
    return 2;
  }
  const { values, positionals } = parsed;
  if (values.help) {
    console.log(HELP);
    return 0;
  }
  if (values.version) {
    console.log(CODEDEN_VERSION);
    return 0;
  }
  const nodeMajor = Number(process.versions.node.split(".")[0]);
  if (nodeMajor < 24) {
    console.error(`CodeDen needs Node.js 24 or newer (found ${process.versions.node}).`);
    return 1;
  }
  if (positionals[0] === "runner-link") {
    return runnerLinkCommand(homeFromArgs(args), positionals.length > 1);
  }
  const { runCommand } = await import("./commands");
  return runCommand(args, parsed);
}

main().then(
  (code) => process.exit(code),
  (error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  },
);

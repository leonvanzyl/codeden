/**
 * The commands that run on the server code: start CodeDen (the default), `doctor`, `update`,
 * `stop`, `password` and `network`. `main.ts` loads this module only for them, so
 * `runner-link` never loads the server.
 */
import { join } from "node:path";
import { CODEDEN_VERSION } from "@codeden/contracts";
import {
  ensureHome,
  ensureInstallToken,
  type RunningServer,
  resolveHome,
  startServer,
} from "@codeden/server";
import { DEFAULT_PORT, HELP, type ParsedCli } from "./args";
import { doctor } from "./doctor";
import type { LaunchInfo } from "./launcher";
import { networkCommand, passwordCommand } from "./network-command";
import { openBrowser } from "./open-browser";
import { handOver } from "./restart";
import { findRunningServer } from "./running";
import { stop } from "./stop";
import { updateCommand } from "./update-command";

/** What the launcher recorded; a plain workspace run (tests) counts as a source checkout. */
function launchInfo(home: string): LaunchInfo {
  const info = (globalThis as Record<string, unknown>).__CODEDEN_LAUNCH__ as LaunchInfo | undefined;
  return (
    info ?? {
      binEntry: process.argv[1] ?? "",
      binVersion: CODEDEN_VERSION,
      kind: "source",
      source: "source",
      restartCommand: "codeden",
      home,
      warning: null,
    }
  );
}

/** Run the command in `parsed`; resolves with the exit code (never, while a server runs). */
export async function runCommand(args: string[], parsed: ParsedCli): Promise<number> {
  const { values, positionals } = parsed;
  const home = resolveHome(values.home);
  const launch = launchInfo(home);
  const command = positionals[0];
  if (command === "doctor") return doctor(home, { install: values.install, launch });
  if (command === "stop") return stop(home);
  if (command === "update") return updateCommand(home, { rollback: values.rollback, launch });
  if (command === "password") return passwordCommand(home, { generate: values.generate });
  if (command === "network") return networkCommand(home, positionals[1]);
  if (command) {
    console.error(`Unknown command "${command}".\n\n${HELP}`);
    return 2;
  }

  const paths = ensureHome(home);
  const token = ensureInstallToken(paths.token);
  const running = await findRunningServer(paths.serverLock);
  if (running) {
    const url = `http://127.0.0.1:${running.port}/?token=${token}`;
    console.log(`CodeDen is already running: ${url}`);
    if (!values["no-open"]) openBrowser(url);
    return 0;
  }

  const port = values.port ? Number(values.port) : DEFAULT_PORT;
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    console.error(`Invalid port "${values.port}".`);
    return 2;
  }
  let server: RunningServer;
  const shutdown = () => void server.close().then(() => process.exit(0));
  try {
    server = await startServer({
      port,
      dataDir: home,
      token,
      enableFakeProvider: process.env.CODEDEN_FAKE_PROVIDER === "1",
      onShutdownRequest: () => process.exit(0),
      selfUpdate: {
        source: launch.source,
        restartCommand: launch.restartCommand,
        launcherVersion: launch.binVersion,
        warning: launch.warning,
        restart:
          launch.source === "packaged"
            ? (target) => {
                process.off("SIGINT", shutdown);
                process.off("SIGTERM", shutdown);
                void handOver({
                  server,
                  home,
                  args,
                  target,
                  fromVersion: CODEDEN_VERSION,
                  launch,
                  selfEntry: join(import.meta.dirname, "cli.js"),
                }).then((code) => process.exit(code));
              }
            : undefined,
      },
      log: (m) => {
        if (process.env.CODEDEN_DEBUG) console.log(`[codeden] ${m}`);
      },
    });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EADDRINUSE") {
      console.error(`Port ${port} is in use. Try: codeden --port ${port + 1}`);
      return 1;
    }
    throw error;
  }

  console.log(`CodeDen ${CODEDEN_VERSION} is running at ${server.url}`);
  console.log(`Open: ${server.launchUrl}`);
  if (server.network.enabled) {
    console.log("Network access is on. Open CodeDen on your phone or tablet at:");
    for (const a of server.network.addresses()) console.log(`  ${a.label.padEnd(16)} ${a.url}`);
  }
  console.log("Press Ctrl+C to stop the server (agents keep running in the runner).");
  if (!values["no-open"]) openBrowser(server.launchUrl);

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  return new Promise<number>(() => {});
}

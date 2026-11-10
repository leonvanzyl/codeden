/**
 * Start a real CodeDen server (and its runner) with an isolated home for end-to-end tests and
 * screenshots. Prints `CODEDEN_E2E_READY <json>` once listening; stops on SIGINT/SIGTERM or
 * (with `--exit-with-stdin`) when stdin closes, taking the runner down with it.
 *
 *   node --import tsx apps/web/e2e/support/start-server.ts --home <dir> [--user-home <dir>]
 *     [--port 0] [--builtin] [--opencode <fake opencode>] [--exit-with-stdin] [--no-path-refresh]
 */
import { parseArgs } from "node:util";
import { ensureHome, ensureInstallToken, startServer } from "@codeden/server";

const { values } = parseArgs({
  options: {
    home: { type: "string" },
    /** Folder used as the user's home for agent config (`~/.claude`, `~/.codex`). */
    "user-home": { type: "string" },
    port: { type: "string", default: "0" },
    /** Load the real Claude Code and Codex adapters (screenshots); off for tests. */
    builtin: { type: "boolean", default: false },
    /** Run OpenCode from this executable (the fake OpenCode server). */
    opencode: { type: "string" },
    "exit-with-stdin": { type: "boolean", default: false },
    /** Keep the PATH this process was given (no Windows registry refresh on re-checks). */
    "no-path-refresh": { type: "boolean", default: false },
  },
});
if (!values.home) {
  console.error("--home is required");
  process.exit(2);
}

const home = values.home;
const token = ensureInstallToken(ensureHome(home).token);
const server = await startServer({
  port: Number(values.port),
  dataDir: home,
  token,
  enableFakeProvider: true,
  builtinProviders: values.builtin,
  ...(values.opencode ? { openCodeExecutable: values.opencode } : {}),
  waitForRunner: true,
  userHome: values["user-home"],
  ...(values["no-path-refresh"] ? { refreshPath: async () => undefined } : {}),
  log: (m) => console.log(`[codeden] ${m}`),
});
console.log(
  `CODEDEN_E2E_READY ${JSON.stringify({ url: server.url, launchUrl: server.launchUrl, token })}`,
);

let stopping = false;
const stop = () => {
  if (stopping) return;
  stopping = true;
  void server
    .close({ stopRunner: true })
    .catch((error: unknown) => console.error(error))
    .finally(() => process.exit(0));
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
if (values["exit-with-stdin"]) {
  // The test runner holds our stdin; if it dies, stdin closes and we clean up.
  process.stdin.on("end", stop);
  process.stdin.resume();
}

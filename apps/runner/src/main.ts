/**
 * Runner process entry. Started detached by the server:
 *   node main.js --home <dir> [--fake] [--no-builtin] [--replay <fixture.json>] [--mcp-upstream <url>]
 *     [--opencode <path to the opencode executable>] [--backend <local|docker|upstash-box>]
 */
import { parseArgs } from "node:util";
import { RunnerBackendId } from "@codeden/contracts";
import { startRunner } from "./runner";

const { values } = parseArgs({
  options: {
    home: { type: "string" },
    fake: { type: "boolean", default: false },
    /** Skip the real Claude Code / Codex adapters (tests that only use Fake or Replay). */
    "no-builtin": { type: "boolean", default: false },
    /** Serve a recorded fixture as the `replay` provider (repeatable). */
    replay: { type: "string", multiple: true },
    "mcp-upstream": { type: "string" },
    /** Run OpenCode from this executable (an install outside PATH, or the fake in tests). */
    opencode: { type: "string" },
    /** Where this runner runs (a sandbox backend starts it with its own id). Default `local`. */
    backend: { type: "string" },
  },
  allowPositionals: false,
});

const home = values.home ?? process.env.CODEDEN_HOME;
if (!home) {
  console.error("codeden runner: --home or CODEDEN_HOME is required");
  process.exit(2);
}
const backend = RunnerBackendId.safeParse(values.backend ?? "local");
if (!backend.success) {
  console.error(`codeden runner: unknown --backend "${values.backend}"`);
  process.exit(2);
}

const log = (m: string) => console.log(`[${new Date().toISOString()}] ${m}`);

try {
  const runner = await startRunner({
    home,
    backend: backend.data,
    enableFakeProvider: values.fake,
    builtinProviders: !values["no-builtin"],
    replayFixtures: values.replay,
    openCodeExecutable: values.opencode,
    mcpUpstreamUrl: values["mcp-upstream"],
    sweepDescendants: true,
    log,
    onShutdown: () => process.exit(0),
  });
  const stop = () => void runner.close().then(() => process.exit(0));
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP", "SIGBREAK"] as const) {
    process.on(signal, stop);
  }
} catch (error) {
  log(`failed to start: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}

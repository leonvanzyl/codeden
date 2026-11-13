import { join } from "node:path";
import type { ProviderInfo, RunnerCommandName, RunnerCommandOf, Session } from "@codeden/contracts";
import { ImageEngineRegistry } from "@codeden/providers";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ensureHome } from "../src/paths";
import { type AppServices, createServices } from "../src/services/container";
import type { Exec } from "../src/services/exec";
import type { RunnerPort, RunnerRouter } from "../src/services/runner-port";
import { MemorySecretStore } from "../src/services/secrets";
import { SettingsStore } from "../src/settings-store";
import { createGithubEnv, type GithubEnv } from "./support/github-env";

/**
 * Session work reaches the session's own runner through the real service container, when the
 * runners load different providers (`docs/remote-runners.md` §8): runner B has Claude Code,
 * the home runner A has none. Forks, "send now" from the queue and the agent-config view all
 * follow the session to B.
 */

const capabilities: ProviderInfo["capabilities"] = {
  resume: true,
  steer: true,
  interrupt: true,
  approvals: true,
  userQuestions: true,
  subagents: true,
  rollback: false,
  fork: true,
  images: true,
  planMode: false,
  reasoningEffort: true,
  mcp: true,
  skills: true,
};
const CLAUDE: ProviderInfo = { id: "claude", displayName: "Claude Code", capabilities, models: [] };
const PROXY_A = "http://127.0.0.1:41001/mcp";
const PROXY_B = "http://127.0.0.1:41002/mcp";

type Command = RunnerCommandOf<RunnerCommandName>;

const nothingInstalled: Exec = async () => ({
  code: null,
  stdout: "",
  stderr: "",
  notFound: true,
  timedOut: false,
  path: null,
});

let env: GithubEnv;
let calls: string[];
let starts: Command[];
let services: AppServices;

/** A connected runner that records `<tag>:<command>` and answers like a Fake runner. */
function port(tag: string, runnerId: string, providers: ProviderInfo[], proxy: string): RunnerPort {
  return {
    isConnected: () => true,
    runnerId: () => runnerId,
    providers: () => providers,
    mcpProxyUrl: () => proxy,
    waitForConnection: async () => true,
    request: (async (command: Command) => {
      calls.push(`${tag}:${command.name}`);
      switch (command.name) {
        case "checkpoint.list":
          return { checkpoints: [] };
        case "provider.fork":
          return { resumeToken: `${command.resumeToken}:fork` };
        case "workspace.prepare":
          return { cwd: command.path ?? env.dir, branch: command.branch ?? null, created: true };
        case "session.start":
          starts.push(command);
          return { resumeToken: command.options.resumeToken ?? null };
        default:
          return {};
      }
    }) as RunnerPort["request"],
  };
}

beforeEach(() => {
  env = createGithubEnv();
  calls = [];
  starts = [];
  const home = port("A", "r-a", [], PROXY_A);
  const b = port("B", "r-b", [CLAUDE], PROXY_B);
  const runners: RunnerRouter = {
    home: () => home,
    forSession: (id) => (env.repo.find(id)?.session.runnerId === "r-b" ? b : home),
    forRunnerId: (runnerId) => (runnerId === "r-b" ? b : home),
  };
  const paths = ensureHome(join(env.dir, "home"));
  services = createServices({
    db: env.db.db,
    store: env.store,
    settings: new SettingsStore(paths.settings),
    paths,
    runner: home,
    runners,
    secrets: new MemorySecretStore(),
    exec: nothingInstalled,
    imageEngines: new ImageEngineRegistry([]),
    userHome: env.dir,
  });
});

afterEach(() => env.close());

/** A Claude session placed on runner B. */
const onB = (patch: Partial<Session> = {}): Session =>
  env.addSession({ provider: "claude", resumeToken: "claude-b", runnerId: "r-b", ...patch });

describe("session work on its own runner", () => {
  it("forks a session on B and starts the fork on B, where its provider and checkpoint are", async () => {
    const source = onB();
    const { sessionId } = await services.sessions.fork(source.id, {});
    await Promise.all(services.sessions.launching.values());

    expect(calls).toEqual([
      "B:checkpoint.list",
      "B:provider.fork",
      "B:workspace.prepare",
      "B:session.start",
    ]);
    const fork = env.repo.get(sessionId);
    expect(fork.runnerId).toBe("r-b");
    expect(fork.status).toBe("idle");
  });

  it("sends a queued message now through B's providers, not the home runner's", async () => {
    const session = onB({ status: "running" });
    await services.sessions.send(session.id, {
      input: { text: "also check the tests", attachments: [] },
      whenBusy: "queue",
    });
    const [queued] = services.queue.list(session.id);
    if (!queued) throw new Error("not queued");
    await expect(services.queue.sendNow(session.id, queued.id)).resolves.toEqual({
      status: "steered",
    });
    expect(calls).toEqual(["B:session.steer"]);
  });

  it("shows the CodeDen MCP endpoint the session's runner gave its agent", async () => {
    const source = onB();
    const { sessionId } = await services.sessions.fork(source.id, {});
    await Promise.all(services.sessions.launching.values());
    const launched = starts[0];
    if (launched?.name !== "session.start") throw new Error("not started");
    const configured = launched.options.mcpServers.find((s) => s.name === "codeden");
    expect(configured?.transport === "http" && configured.url).toBe(PROXY_B);

    const loaded = services.agentConfig.loaded(sessionId);
    const shown = loaded.mcpServers.find((s) => s.provider === "codeden");
    expect(shown?.spec).toMatchObject({ type: "http", url: PROXY_B });
  });
});

import { join } from "node:path";
import type { RunnerCommandName, RunnerCommandOf } from "@codeden/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { McpTokenStore } from "../src/mcp/tokens";
import { RunnerCommandError } from "../src/runner/client";
import type { ProjectService } from "../src/services/projects/project-service";
import type { RunnerPort } from "../src/services/runner-port";
import { SessionLauncher } from "../src/services/sessions/launcher";
import { createGithubEnv, type GithubEnv } from "./support/github-env";

type Command = RunnerCommandOf<RunnerCommandName>;

let env: GithubEnv;
let tokens: McpTokenStore;
let launcher: SessionLauncher;
/** The MCP token in each `session.start` the runner received. */
let handed: string[];
/** The error code `session.start` fails with; null: it starts the session. */
let refuse: string | null;

beforeEach(() => {
  env = createGithubEnv();
  tokens = new McpTokenStore(env.db.db);
  handed = [];
  refuse = null;
  const runner = {
    isConnected: () => true,
    runnerId: () => "r1",
    providers: () => [],
    mcpProxyUrl: () => "http://127.0.0.1:1/mcp",
    waitForConnection: async () => true,
    request: (async (command: Command) => {
      if (command.name !== "session.start") return {};
      const http = command.options.mcpServers.find((s) => s.transport === "http");
      if (http?.transport === "http") {
        handed.push(http.headers?.Authorization?.replace(/^Bearer /, "") ?? "");
      }
      if (refuse) throw new RunnerCommandError(refuse, `session.start failed: ${refuse}`);
      return { resumeToken: "resume-1" };
    }) as RunnerPort["request"],
  } as unknown as RunnerPort;
  launcher = new SessionLauncher({
    repo: env.repo,
    projects: { get: () => env.githubProject } as unknown as ProjectService,
    runner,
    inbox: env.inbox,
    home: env.dir,
    worktreesDir: join(env.dir, "wt"),
    orchestratorDir: join(env.dir, "orchestrator"),
    tokens,
  });
});

afterEach(() => env.close());

describe("MCP tokens when a session is reopened (#208)", () => {
  it("revokes the earlier tokens once the runner has started the session again", async () => {
    const session = env.addSession({ status: "idle" });
    // The token of the provider process that ended with the runner.
    const old = tokens.mint({ role: "agent", sessionId: session.id, projectId: session.projectId });
    await launcher.resume(session);
    expect(handed).toHaveLength(1);
    expect(tokens.verify(handed[0])).toMatchObject({ sessionId: session.id, role: "agent" });
    expect(tokens.verify(old)).toBeUndefined();
  });

  it("keeps the running agent's token when the runner refuses a second open", async () => {
    const session = env.addSession({ status: "running" });
    await launcher.resume(session);
    const live = handed[0];
    // A second resume racing the first: the runner already hosts (or is opening) the session.
    refuse = "session_exists";
    await expect(launcher.resume(session)).rejects.toThrow(/session_exists/);
    expect(handed).toHaveLength(2);
    expect(tokens.verify(live)).toBeDefined();
    // The refused open's token was never put to use.
    expect(tokens.verify(handed[1])).toBeUndefined();
  });

  it("revokes every token of a session the runner could not open", async () => {
    const session = env.addSession({ status: "idle" });
    const old = tokens.mint({ role: "agent", sessionId: session.id, projectId: session.projectId });
    refuse = "open_failed";
    await expect(launcher.resume(session)).rejects.toThrow(/open_failed/);
    // Nothing of the session runs on the runner, so no process holds any of them.
    expect(tokens.verify(old)).toBeUndefined();
    expect(tokens.verify(handed[0])).toBeUndefined();
  });

  it("revokes nothing when it can't tell whether the session started", async () => {
    const session = env.addSession({ status: "idle" });
    const old = tokens.mint({ role: "agent", sessionId: session.id, projectId: session.projectId });
    // The runner may still open it with the new token after the server gave up waiting.
    refuse = "timeout";
    await expect(launcher.resume(session)).rejects.toThrow(/timeout/);
    expect(tokens.verify(handed[0])).toBeDefined();
    expect(tokens.verify(old)).toBeDefined();
  });
});

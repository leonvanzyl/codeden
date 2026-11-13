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
/** The runner refuses the next `session.start` (it already hosts the session). */
let refuse: boolean;

beforeEach(() => {
  env = createGithubEnv();
  tokens = new McpTokenStore(env.db.db);
  handed = [];
  refuse = false;
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
      if (refuse) {
        throw new RunnerCommandError("session_exists", `Session ${command.sessionId} is running`);
      }
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

  it("leaves the running agent's token alone when the runner refuses a second open", async () => {
    const session = env.addSession({ status: "running" });
    await launcher.resume(session);
    const live = handed[0];
    // A second resume racing the first: the runner already hosts the session.
    refuse = true;
    await expect(launcher.resume(session)).rejects.toThrow(/is running/);
    expect(handed).toHaveLength(2);
    expect(tokens.verify(live)).toBeDefined();
  });
});

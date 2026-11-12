import { join } from "node:path";
import type { RunnerCommandName, RunnerCommandOf } from "@codeden/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { McpTokenStore } from "../src/mcp/tokens";
import type { ProjectService } from "../src/services/projects/project-service";
import type { RunnerPort } from "../src/services/runner-port";
import { SessionLauncher } from "../src/services/sessions/launcher";
import { createGithubEnv, type GithubEnv } from "./support/github-env";

let env: GithubEnv;
let calls: Array<RunnerCommandOf<RunnerCommandName>>;
let launcher: SessionLauncher;

beforeEach(() => {
  env = createGithubEnv();
  calls = [];
  const runner = {
    isConnected: () => true,
    runnerId: () => "r1",
    providers: () => [],
    mcpProxyUrl: () => null,
    waitForConnection: async () => true,
    request: (async (command: RunnerCommandOf<RunnerCommandName>) => {
      calls.push(command);
      if (command.name === "workspace.prepare") {
        return { cwd: command.path ?? env.dir, branch: command.branch ?? null, created: true };
      }
      return { resumeToken: null };
    }) as RunnerPort["request"],
  } as unknown as RunnerPort;
  const projects = {
    get: (id: string) => (id === env.githubProject.id ? env.githubProject : env.localProject),
  } as unknown as ProjectService;
  launcher = new SessionLauncher({
    repo: env.repo,
    projects,
    runner,
    inbox: env.inbox,
    home: env.dir,
    worktreesDir: join(env.dir, "wt"),
    orchestratorDir: join(env.dir, "orchestrator"),
    tokens: { mint: () => "token" } as unknown as McpTokenStore,
  });
});

afterEach(() => env.close());

const prepared = () => {
  const call = calls.find((c) => c.name === "workspace.prepare");
  if (call?.name !== "workspace.prepare") throw new Error("no workspace.prepare");
  return call;
};

describe("new worktrees of a GitHub project", () => {
  it("fetch first, so they can start from the up-to-date default branch", async () => {
    const session = env.addSession({ status: "starting", worktreePath: null, branch: null });
    await launcher.launch(session.id, { workspace: { mode: "worktree" } });
    expect(prepared()).toMatchObject({ baseRef: "main", fetch: true });
    // The pull request still targets the default branch.
    expect(env.repo.get(session.id).baseBranch).toBe("main");
  });

  it("keep an explicit base ref and the caller's fetch choice", async () => {
    const session = env.addSession({ status: "starting", worktreePath: null, branch: null });
    await launcher.launch(session.id, { workspace: { mode: "worktree", baseRef: "release" } });
    expect(prepared()).toMatchObject({ baseRef: "release" });
    expect(prepared().fetch).toBeUndefined();
  });

  it("are not fetched for local-only projects", async () => {
    const session = env.addSession({
      status: "starting",
      projectId: env.localProject.id,
      worktreePath: null,
      branch: null,
    });
    await launcher.launch(session.id, { workspace: { mode: "worktree" } });
    expect(prepared().fetch).toBeUndefined();
  });
});

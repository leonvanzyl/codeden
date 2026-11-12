import type {
  RunnerCommandName,
  RunnerCommandOf,
  Session,
  SessionStatus,
  UserInput,
} from "@codeden/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { McpTokenStore } from "../src/mcp/tokens";
import type { ProjectService } from "../src/services/projects/project-service";
import type { RunnerPort } from "../src/services/runner-port";
import { SessionLifecycle } from "../src/services/sessions/lifecycle";
import { Outbox } from "../src/services/sessions/outbox";
import { SessionService, type SessionServiceDeps } from "../src/services/sessions/session-service";
import type { UtilityService } from "../src/services/utility";
import type { SettingsStore } from "../src/settings-store";
import { createGithubEnv, type GithubEnv } from "./support/github-env";

type Command = RunnerCommandOf<RunnerCommandName>;

let env: GithubEnv;
let calls: Command[];
let tokens: McpTokenStore;
let sessions: SessionService;
let lifecycle: SessionLifecycle;

/**
 * A runner whose `session.stop` changes nothing itself: a session that already finished
 * (completed or failed) has a final status the provider's exit never overwrites.
 */
const runner = {
  isConnected: () => true,
  runnerId: () => "r1",
  providers: () => [],
  mcpProxyUrl: () => null,
  waitForConnection: async () => true,
  request: (async (command: Command) => {
    calls.push(command);
    return {};
  }) as RunnerPort["request"],
} as unknown as RunnerPort;

beforeEach(() => {
  env = createGithubEnv();
  calls = [];
  tokens = new McpTokenStore(env.db.db);
  sessions = new SessionService({
    repo: env.repo,
    projects: { get: () => env.githubProject } as unknown as ProjectService,
    runner,
    inbox: env.inbox,
    launcher: {},
    outbox: new Outbox(env.db.db, env.store),
    artifacts: {
      externalizeAttachments: (i: UserInput) => i,
      resolveAttachments: (i: UserInput) => i,
    },
    tokens,
  } as unknown as SessionServiceDeps);
  // The real lifecycle: it revokes tokens when a session becomes stopped or completed.
  lifecycle = new SessionLifecycle({
    db: env.db.db,
    store: env.store,
    repo: env.repo,
    sessions,
    settings: {} as SettingsStore,
    utility: {} as UtilityService,
    tokens,
  });
  lifecycle.start();
});

afterEach(async () => {
  lifecycle.stop();
  // Let the lifecycle's deferred queue drain run before the database closes.
  await new Promise((resolve) => setImmediate(resolve));
  env.close();
});

const endedAt = "2026-11-11T09:00:00.000Z";
const finished = (status: SessionStatus): Session => env.addSession({ status, endedAt });
const mint = (session: Session) =>
  tokens.mint({ role: "agent", sessionId: session.id, projectId: session.projectId });

describe("stopping a session that already finished (#116)", () => {
  it.each(["completed", "failed"] as const)(
    "keeps a %s session's status and revokes its MCP token",
    async (status) => {
      const session = finished(status);
      const token = mint(session);
      expect(tokens.verify(token)).toBeDefined();

      const result = await sessions.stop(session.id);
      expect(result.status).toBe(status);
      expect(env.repo.get(session.id)).toMatchObject({ status, endedAt });
      // The provider was stopped, so its tools stop working too.
      expect(calls.map((c) => c.name)).toContain("session.stop");
      expect(tokens.verify(token)).toBeUndefined();
    },
  );

  it("still stops a running session and revokes its token", async () => {
    const session = env.addSession({ status: "running" });
    const token = mint(session);
    const result = await sessions.stop(session.id);
    expect(result.status).toBe("stopped");
    expect(tokens.verify(token)).toBeUndefined();
  });

  it("keeps the token of a session whose turn failed but that nobody stopped", () => {
    const session = env.addSession({ status: "running" });
    const token = mint(session);
    // A failed turn leaves the provider process running; its next turn needs the same tools.
    env.repo.update(session.id, (s) => ({ ...s, status: "failed" }));
    expect(env.repo.get(session.id).status).toBe("failed");
    expect(tokens.verify(token)).toBeDefined();
  });
});

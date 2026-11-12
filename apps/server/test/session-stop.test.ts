import type {
  RunnerCommandName,
  RunnerCommandOf,
  Session,
  SessionStatus,
  UserInput,
} from "@codeden/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ProjectService } from "../src/services/projects/project-service";
import type { RunnerPort } from "../src/services/runner-port";
import { Outbox } from "../src/services/sessions/outbox";
import { SessionService, type SessionServiceDeps } from "../src/services/sessions/session-service";
import { createGithubEnv, type GithubEnv } from "./support/github-env";

type Command = RunnerCommandOf<RunnerCommandName>;

let env: GithubEnv;
let calls: Command[];

beforeEach(() => {
  env = createGithubEnv();
  calls = [];
});

afterEach(() => env.close());

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

function service(): SessionService {
  return new SessionService({
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
  } as unknown as SessionServiceDeps);
}

const finished = (status: SessionStatus): Session =>
  env.addSession({ status, endedAt: "2026-11-11T09:00:00.000Z" });

describe("stopping a session that already finished (#116)", () => {
  it.each(["completed", "failed"] as const)("keeps a %s session's status", async (status) => {
    const session = finished(status);
    const result = await service().stop(session.id);
    expect(result.status).toBe(status);
    expect(env.repo.get(session.id).status).toBe(status);
    expect(env.repo.get(session.id).endedAt).toBe("2026-11-11T09:00:00.000Z");
  });

  it("still stops a running session", async () => {
    const session = env.addSession({ status: "running" });
    const result = await service().stop(session.id);
    expect(calls.map((c) => c.name)).toContain("session.stop");
    expect(result.status).toBe("stopped");
  });
});

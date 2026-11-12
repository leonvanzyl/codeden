import { join } from "node:path";
import type {
  ProviderInfo,
  RunnerCommandName,
  RunnerCommandOf,
  Session,
  UserInput,
} from "@codeden/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { McpTokenStore } from "../src/mcp/tokens";
import type { ProjectService } from "../src/services/projects/project-service";
import type { RunnerPort } from "../src/services/runner-port";
import { forkTitle } from "../src/services/sessions/fork";
import { SessionLauncher } from "../src/services/sessions/launcher";
import { SessionService, type SessionServiceDeps } from "../src/services/sessions/session-service";
import { createGithubEnv, type GithubEnv } from "./support/github-env";

const capabilities = (fork: boolean): ProviderInfo["capabilities"] => ({
  resume: true,
  steer: true,
  interrupt: true,
  approvals: true,
  userQuestions: true,
  subagents: true,
  rollback: false,
  fork,
  images: true,
  planMode: false,
  reasoningEffort: true,
  mcp: true,
  skills: true,
});

const PROVIDERS: ProviderInfo[] = [
  { id: "claude", displayName: "Claude Code", capabilities: capabilities(true), models: [] },
  { id: "plain", displayName: "Plain", capabilities: capabilities(false), models: [] },
];

let env: GithubEnv;
let calls: Array<RunnerCommandOf<RunnerCommandName>>;
let sessions: SessionService;

beforeEach(() => {
  env = createGithubEnv();
  calls = [];
  const runner = {
    isConnected: () => true,
    runnerId: () => "r1",
    providers: () => PROVIDERS,
    mcpProxyUrl: () => null,
    waitForConnection: async () => true,
    request: (async (command: RunnerCommandOf<RunnerCommandName>) => {
      calls.push(command);
      if (command.name === "workspace.prepare") {
        return { cwd: command.path ?? env.dir, branch: command.branch ?? null, created: true };
      }
      if (command.name === "session.start") return { resumeToken: "claude-fork-1" };
      return {};
    }) as RunnerPort["request"],
  } as unknown as RunnerPort;
  const projects = {
    get: (id: string) => (id === env.githubProject.id ? env.githubProject : env.localProject),
  } as unknown as ProjectService;
  const launcher = new SessionLauncher({
    repo: env.repo,
    projects,
    runner,
    inbox: env.inbox,
    worktreesDir: join(env.dir, "wt"),
    orchestratorDir: join(env.dir, "orchestrator"),
    tokens: { mint: () => "token" } as unknown as McpTokenStore,
  });
  sessions = new SessionService({
    repo: env.repo,
    projects,
    runner,
    inbox: env.inbox,
    launcher,
    artifacts: {
      externalizeAttachments: (i: UserInput) => i,
      resolveAttachments: (i: UserInput) => i,
    },
  } as unknown as SessionServiceDeps);
});

afterEach(() => env.close());

/** An idle Claude session with a conversation, on its own branch, after `turns` turns. */
function source(patch: Partial<Session> = {}, turns = 2): Session {
  const session = env.addSession({
    provider: "claude",
    model: "opus",
    effort: "high",
    autonomy: "supervised",
    title: "Add login",
    purpose: "Add login",
    workKey: "issue:7",
    issue: { number: 7, title: "Add login", url: "https://github.com/acme/widgets/issues/7" },
    resumeToken: "claude-source",
    branch: "codeden/add-login-s1ab",
    baseBranch: "main",
    ...patch,
  });
  for (let index = 0; index < turns; index += 1) {
    env.store.append([
      {
        type: "checkpoint.created",
        sessionId: session.id,
        payload: {
          checkpoint: {
            sessionId: session.id,
            index,
            ref: `refs/codeden/checkpoints/${session.id}/${index}`,
            commit: `c${index}`,
            turnId: index === 0 ? null : `turn-${index}`,
            createdAt: "2026-11-12T10:00:00.000Z",
          },
        },
      },
    ]);
  }
  return env.repo.get(session.id);
}

const call = <N extends RunnerCommandName>(name: N): RunnerCommandOf<N> => {
  const found = calls.find((c) => c.name === name);
  if (!found) throw new Error(`no ${name}`);
  return found as RunnerCommandOf<N>;
};

async function forked(id: string): Promise<Session> {
  await Promise.all(sessions.launching.values());
  return env.repo.get(id);
}

describe("forking a session", () => {
  it("starts a new session with the same agent, work and permissions, from the latest checkpoint", async () => {
    const src = source();
    const { sessionId } = sessions.fork(src.id, {});
    const fork = await forked(sessionId);

    expect(fork).toMatchObject({
      projectId: src.projectId,
      role: "agent",
      provider: "claude",
      model: "opus",
      effort: "high",
      autonomy: "supervised",
      purpose: "Add login",
      workKey: "issue:7",
      issue: src.issue,
      title: "Add login (fork)",
      startedBy: { kind: "user" },
      parentSessionId: null,
      forkedFrom: { sessionId: src.id, checkpoint: 1 },
      // The provider's own fork, stored as this session's conversation.
      resumeToken: "claude-fork-1",
      status: "idle",
      // The pull request targets the source's base branch, not the source's branch.
      baseBranch: "main",
    });
    expect(fork.branch).toMatch(/^codeden\/add-login-fork-/);

    // The worktree branches from the source branch and starts from its latest checkpoint.
    expect(call("workspace.prepare")).toMatchObject({
      strategy: "worktree",
      baseRef: "codeden/add-login-s1ab",
      restoreCheckpoint: { sessionId: src.id, index: 1 },
    });
    expect(call("workspace.prepare").fetch).toBeUndefined();
    // The provider forks the source's conversation.
    const start = call("session.start");
    expect(start.options).toMatchObject({ forkFrom: "claude-source", autonomy: "supervised" });
    expect(start.options.resumeToken).toBeUndefined();
    expect(start.options.ownBranch).toBe(fork.branch);
  });

  it("leaves the source untouched", async () => {
    const src = source();
    const before = env.events.filter((e) => e.sessionId === src.id).length;
    await forked(sessions.fork(src.id, { title: "Try OAuth instead" }).sessionId);
    expect(env.repo.get(src.id)).toEqual(src);
    expect(env.events.filter((e) => e.sessionId === src.id)).toHaveLength(before);
    expect(calls.every((c) => !("sessionId" in c) || c.sessionId !== src.id)).toBe(true);
  });

  it("uses the given title, and forks from the branch alone when there is no checkpoint", async () => {
    const src = source({}, 0);
    const fork = await forked(sessions.fork(src.id, { title: "Try OAuth instead" }).sessionId);
    expect(fork.title).toBe("Try OAuth instead");
    expect(fork.forkedFrom).toEqual({ sessionId: src.id, checkpoint: null });
    expect(call("workspace.prepare").restoreCheckpoint).toBeUndefined();
  });

  it("asks the provider to fork again when the first start never got a conversation", async () => {
    const src = source();
    const fork = await forked(sessions.fork(src.id, {}).sessionId);
    const failed = env.repo.update(fork.id, (s) => ({ ...s, resumeToken: null }));
    const launcher = (sessions as unknown as { deps: { launcher: SessionLauncher } }).deps.launcher;
    expect(launcher.sessionOptions(failed).forkFrom).toBe("claude-source");
    // Once it has one, it resumes its own conversation and never the source's.
    expect(launcher.sessionOptions({ ...failed, resumeToken: "claude-fork-1" })).toMatchObject({
      resumeToken: "claude-fork-1",
    });
    expect(launcher.sessionOptions({ ...failed, resumeToken: "claude-fork-1" }).forkFrom).toBe(
      undefined,
    );
  });

  it("refuses what it can't fork", () => {
    const refusal = (src: Session) => {
      try {
        sessions.fork(src.id, {});
      } catch (error) {
        const e = error as { status: number; code: string };
        return { status: e.status, code: e.code };
      }
      return null;
    };
    expect(refusal(source({ status: "running" }))).toEqual({ status: 409, code: "turn_running" });
    expect(refusal(source({ status: "waiting" }))).toEqual({ status: 409, code: "turn_running" });
    expect(refusal(source({ status: "starting" }))).toEqual({ status: 409, code: "not_started" });
    expect(refusal(source({ resumeToken: null }))).toEqual({
      status: 409,
      code: "nothing_to_fork",
    });
    expect(refusal(source({ provider: "plain" }))).toEqual({ status: 409, code: "unsupported" });
    expect(refusal(source({ provider: "gone" }))).toEqual({ status: 409, code: "unsupported" });
    expect(refusal(source({ branch: null }))).toEqual({ status: 409, code: "fork_unsupported" });
    expect(refusal(source({ role: "pm" }))).toEqual({ status: 400, code: "fork_unsupported" });
    const idle = source();
    env.githubProject.archivedAt = "2026-11-12T10:00:00.000Z";
    expect(refusal(idle)).toEqual({ status: 400, code: "project_archived" });
    env.githubProject.archivedAt = null;
    expect(sessions.launching.size).toBe(0);
    expect(calls).toEqual([]);
  });

  it("can fork a finished or stopped session", async () => {
    for (const status of ["stopped", "failed", "completed", "interrupted"] as const) {
      const { sessionId } = sessions.fork(source({ status }).id, {});
      expect((await forked(sessionId)).forkedFrom).toBeTruthy();
    }
  });

  it("keeps fork titles within the limit", () => {
    const long = { ...env.addSession(), title: "x".repeat(200) };
    expect(forkTitle(long)).toHaveLength(200);
    expect(forkTitle(long).endsWith("x (fork)")).toBe(true);
    expect(forkTitle({ ...long, title: null, purpose: "Fix it" })).toBe("Fix it (fork)");
  });
});

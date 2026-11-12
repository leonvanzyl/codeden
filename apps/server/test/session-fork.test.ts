import { join } from "node:path";
import {
  agentEventToNewEvent,
  type ProviderInfo,
  type RunnerCommandName,
  type RunnerCommandOf,
  type Session,
  type UserInput,
} from "@codeden/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { McpTokenStore } from "../src/mcp/tokens";
import { RunnerCommandError } from "../src/runner/client";
import type { ProjectService } from "../src/services/projects/project-service";
import type { RunnerPort } from "../src/services/runner-port";
import { forkTitle } from "../src/services/sessions/fork";
import { SessionLauncher } from "../src/services/sessions/launcher";
import { Outbox } from "../src/services/sessions/outbox";
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

type Command = RunnerCommandOf<RunnerCommandName>;

/** What the scripted runner answers; tests change it. */
interface RunnerScript {
  /** Checkpoint indexes on disk per session, once the runner has settled them. */
  checkpoints: Record<string, number[]>;
  /** Fail this many `workspace.prepare` calls (as a restore of a missing checkpoint does). */
  failPrepares: number;
  /** Runs while the provider copies the conversation. */
  duringFork?: () => void;
}

let env: GithubEnv;
let calls: Command[];
let script: RunnerScript;

beforeEach(() => {
  env = createGithubEnv();
  calls = [];
  script = { checkpoints: {}, failPrepares: 0 };
});

afterEach(() => env.close());

const runner = {
  isConnected: () => true,
  runnerId: () => "r1",
  providers: () => PROVIDERS,
  mcpProxyUrl: () => null,
  waitForConnection: async () => true,
  request: (async (command: Command) => {
    calls.push(command);
    switch (command.name) {
      case "checkpoint.list":
        return {
          checkpoints: (script.checkpoints[command.sessionId] ?? []).map((index) => ({
            index,
            ref: `refs/codeden/checkpoints/${command.sessionId}/${index}`,
            commit: `c${index}`,
            createdAt: "2026-11-12T10:00:00.000Z",
          })),
        };
      case "provider.fork":
        script.duringFork?.();
        return { resumeToken: `${command.resumeToken}:fork` };
      case "workspace.prepare":
        if (script.failPrepares > 0) {
          script.failPrepares -= 1;
          throw new RunnerCommandError("unknown_checkpoint", "Checkpoint 1 of s1 not found");
        }
        return { cwd: command.path ?? env.dir, branch: command.branch ?? null, created: true };
      case "session.start":
        return { resumeToken: command.options.resumeToken ?? null };
      case "session.send":
        // The runner never started the fork (its first start failed).
        throw new RunnerCommandError(
          "unknown_session",
          `Session ${command.sessionId} is not running`,
        );
      default:
        return {};
    }
  }) as RunnerPort["request"],
} as unknown as RunnerPort;

/** A session service and launcher over the real repo; built again to model a server restart. */
function services() {
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
  const sessions = new SessionService({
    repo: env.repo,
    projects,
    runner,
    inbox: env.inbox,
    launcher,
    outbox: new Outbox(env.db.db, env.store),
    artifacts: {
      externalizeAttachments: (i: UserInput) => i,
      resolveAttachments: (i: UserInput) => i,
    },
  } as unknown as SessionServiceDeps);
  return { sessions, launcher };
}

/** An idle Claude session with a conversation, on its own branch. */
function source(patch: Partial<Session> = {}): Session {
  return env.addSession({
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
}

const all = <N extends RunnerCommandName>(name: N) =>
  calls.filter((c): c is RunnerCommandOf<N> => c.name === name);
const call = <N extends RunnerCommandName>(name: N): RunnerCommandOf<N> => {
  const found = all(name)[0];
  if (!found) throw new Error(`no ${name}`);
  return found;
};

async function settle(sessions: SessionService): Promise<void> {
  await Promise.all(sessions.launching.values());
}

describe("forking a session", () => {
  it("starts a new session with the same agent, work and permissions, from the latest checkpoint", async () => {
    const { sessions } = services();
    const src = source();
    script.checkpoints[src.id] = [0, 1];
    const { sessionId } = await sessions.fork(src.id, {});
    await settle(sessions);
    const fork = env.repo.get(sessionId);

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
      // Its own copy of the conversation, made when it was forked.
      resumeToken: "claude-source:fork",
      status: "idle",
      // The pull request targets the source's base branch, not the source's branch.
      baseBranch: "main",
    });
    expect(fork.branch).toMatch(/^codeden\/add-login-fork-/);

    // The code: the runner's settled checkpoint list, then the conversation copy.
    expect(calls.map((c) => c.name)).toEqual([
      "checkpoint.list",
      "provider.fork",
      "workspace.prepare",
      "session.start",
    ]);
    expect(call("checkpoint.list")).toMatchObject({ sessionId: src.id, settled: true });
    expect(call("provider.fork")).toMatchObject({
      providerId: "claude",
      resumeToken: "claude-source",
    });
    expect(call("workspace.prepare")).toMatchObject({
      strategy: "worktree",
      baseRef: "codeden/add-login-s1ab",
      restoreCheckpoint: { sessionId: src.id, index: 1 },
    });
    expect(call("workspace.prepare").fetch).toBeUndefined();
    // A plain resume of the copy, in the new worktree.
    const start = call("session.start");
    expect(start.options).toMatchObject({
      resumeToken: "claude-source:fork",
      autonomy: "supervised",
      cwd: fork.worktreePath,
      ownBranch: fork.branch,
    });
  });

  it("takes the checkpoint the runner settled, not one the server has heard of", async () => {
    const { sessions } = services();
    const src = source();
    // The turn that just ended has a checkpoint the server's projection doesn't have yet.
    env.store.append([checkpointEvent(src.id, 0)]);
    script.checkpoints[src.id] = [0, 1];
    const { sessionId } = await sessions.fork(src.id, {});
    await settle(sessions);
    expect(env.repo.get(sessionId).forkedFrom).toEqual({ sessionId: src.id, checkpoint: 1 });
    expect(call("workspace.prepare").restoreCheckpoint).toEqual({ sessionId: src.id, index: 1 });
  });

  it("leaves the source untouched", async () => {
    const { sessions } = services();
    const src = source();
    script.checkpoints[src.id] = [0, 1];
    const row = env.repo.get(src.id);
    const before = env.events.filter((e) => e.sessionId === src.id).length;
    await sessions.fork(src.id, { title: "Try OAuth instead" });
    await settle(sessions);
    expect(env.repo.get(src.id)).toEqual(row);
    expect(env.events.filter((e) => e.sessionId === src.id)).toHaveLength(before);
    // Read only: the checkpoint list and the conversation copy.
    const touching = calls.filter((c) => JSON.stringify(c).includes(src.id));
    expect(touching.map((c) => c.name)).toEqual(["checkpoint.list", "workspace.prepare"]);
    expect(call("workspace.prepare").sessionId).not.toBe(src.id);
  });

  it("uses the given title, and forks from the branch alone when there is no checkpoint", async () => {
    const { sessions } = services();
    const src = source();
    const { sessionId } = await sessions.fork(src.id, { title: "Try OAuth instead" });
    await settle(sessions);
    const fork = env.repo.get(sessionId);
    expect(fork.title).toBe("Try OAuth instead");
    expect(fork.forkedFrom).toEqual({ sessionId: src.id, checkpoint: null });
    expect(call("workspace.prepare").restoreCheckpoint).toBeUndefined();
  });

  it("fails the fork when the source starts a turn while it is being copied", async () => {
    const { sessions } = services();
    const src = source();
    script.duringFork = () => env.repo.update(src.id, (s) => ({ ...s, status: "running" }));
    await expect(sessions.fork(src.id, {})).rejects.toMatchObject({
      status: 409,
      code: "turn_running",
    });
    expect(env.repo.list({ projectId: src.projectId ?? undefined })).toHaveLength(1);
    expect(all("workspace.prepare")).toEqual([]);
  });

  it("fails the fork when a whole source turn runs while it is being copied", async () => {
    const { sessions } = services();
    const src = source({ rootThreadId: "t-root" });
    env.store.append([
      agentEventToNewEvent(src.id, { type: "thread.started", thread: { id: "t-root" } }),
    ]);
    env.repo.update(src.id, (s) => ({ ...s, status: "idle" }));
    script.checkpoints[src.id] = [0, 1];
    // A short turn (a queued message, an auto-retry) starts and ends during the copy: the
    // source is idle again afterwards, but the copy now holds a turn checkpoint 1 doesn't.
    script.duringFork = () => {
      env.store.append([
        agentEventToNewEvent(src.id, { type: "turn.started", threadId: "t-root", turnId: "u2" }),
        agentEventToNewEvent(src.id, { type: "turn.completed", threadId: "t-root", turnId: "u2" }),
      ]);
      script.checkpoints[src.id] = [0, 1, 2];
    };
    await expect(sessions.fork(src.id, {})).rejects.toMatchObject({
      status: 409,
      code: "source_changed",
    });
    expect(env.repo.get(src.id).status).toBe("idle");
    expect(env.repo.list({ projectId: src.projectId ?? undefined })).toHaveLength(1);
    expect(all("workspace.prepare")).toEqual([]);

    // Once nothing runs during the copy, the same source forks with that turn's checkpoint.
    script.duringFork = undefined;
    const { sessionId } = await sessions.fork(src.id, {});
    await settle(sessions);
    expect(env.repo.get(sessionId).forkedFrom).toEqual({ sessionId: src.id, checkpoint: 2 });
  });

  it("refuses what it can't fork, before asking the runner anything", async () => {
    const { sessions } = services();
    const refusal = async (src: Session) => {
      try {
        await sessions.fork(src.id, {});
      } catch (error) {
        const e = error as { status: number; code: string };
        return { status: e.status, code: e.code };
      }
      return null;
    };
    expect(await refusal(source({ status: "running" }))).toEqual({
      status: 409,
      code: "turn_running",
    });
    expect(await refusal(source({ status: "waiting" }))).toEqual({
      status: 409,
      code: "turn_running",
    });
    expect(await refusal(source({ status: "starting" }))).toEqual({
      status: 409,
      code: "not_started",
    });
    expect(await refusal(source({ resumeToken: null }))).toEqual({
      status: 409,
      code: "nothing_to_fork",
    });
    expect(await refusal(source({ provider: "plain" }))).toEqual({
      status: 409,
      code: "unsupported",
    });
    expect(await refusal(source({ provider: "gone" }))).toEqual({
      status: 409,
      code: "unsupported",
    });
    expect(await refusal(source({ branch: null }))).toEqual({
      status: 409,
      code: "fork_unsupported",
    });
    expect(await refusal(source({ role: "pm" }))).toEqual({
      status: 400,
      code: "fork_unsupported",
    });
    const idle = source();
    env.githubProject.archivedAt = "2026-11-12T10:00:00.000Z";
    expect(await refusal(idle)).toEqual({ status: 400, code: "project_archived" });
    env.githubProject.archivedAt = null;
    expect(sessions.launching.size).toBe(0);
    expect(calls).toEqual([]);
  });

  it("can fork a finished or stopped session", async () => {
    const { sessions } = services();
    for (const status of ["stopped", "failed", "completed", "interrupted"] as const) {
      const { sessionId } = await sessions.fork(source({ status }).id, {});
      await settle(sessions);
      expect(env.repo.get(sessionId).forkedFrom).toBeTruthy();
    }
  });

  it("keeps fork titles within the limit", () => {
    const long = { ...env.addSession(), title: "x".repeat(200) };
    expect(forkTitle(long)).toHaveLength(200);
    expect(forkTitle(long).endsWith("x (fork)")).toBe(true);
    expect(forkTitle({ ...long, title: null, purpose: "Fix it" })).toBe("Fix it (fork)");
  });
});

describe("a fork whose worktree could not be made", () => {
  async function failedFork() {
    const first = services();
    const src = source();
    script.checkpoints[src.id] = [0, 1];
    script.failPrepares = 1;
    const { sessionId } = await first.sessions.fork(src.id, {});
    await settle(first.sessions);
    return { src, fork: env.repo.get(sessionId) };
  }

  it("is failed, with no worktree and no provider start", async () => {
    const { fork } = await failedFork();
    expect(fork).toMatchObject({ status: "failed", worktreePath: null, branch: null });
    expect(all("session.start")).toEqual([]);
  });

  it("makes the worktree before anything runs, even after a server restart", async () => {
    const { src, fork } = await failedFork();
    // A new server (no memory of the first launch) gets a message for the failed fork.
    const { sessions } = services();
    calls = [];
    await sessions.send(fork.id, {
      input: { text: "carry on", attachments: [] },
      whenBusy: "queue",
    });

    expect(calls.map((c) => c.name)).toEqual([
      "session.send",
      "workspace.prepare",
      "session.start",
    ]);
    expect(call("workspace.prepare")).toMatchObject({
      strategy: "worktree",
      baseRef: "codeden/add-login-s1ab",
      restoreCheckpoint: { sessionId: src.id, index: 1 },
    });
    const after = env.repo.get(fork.id);
    expect(after.worktreePath).toBeTruthy();
    expect(after.worktreePath).not.toBe(env.githubProject.path);
    expect(after.baseBranch).toBe("main");
    const start = call("session.start");
    expect(start.options.cwd).toBe(after.worktreePath);
    expect(start.options.resumeToken).toBe("claude-source:fork");
    expect(start.input?.text).toBe("carry on");
  });

  it("never runs in the project root when the worktree still can't be made", async () => {
    const { fork } = await failedFork();
    const { sessions } = services();
    script.failPrepares = 1;
    calls = [];
    await expect(
      sessions.send(fork.id, { input: { text: "carry on", attachments: [] }, whenBusy: "queue" }),
    ).rejects.toMatchObject({ code: "unknown_checkpoint" });
    expect(calls.map((c) => c.name)).toEqual(["session.send", "workspace.prepare"]);
    expect(env.repo.get(fork.id)).toMatchObject({ status: "failed", worktreePath: null });
  });
});

function checkpointEvent(sessionId: string, index: number) {
  return {
    type: "checkpoint.created" as const,
    sessionId,
    payload: {
      checkpoint: {
        sessionId,
        index,
        ref: `refs/codeden/checkpoints/${sessionId}/${index}`,
        commit: `c${index}`,
        turnId: index === 0 ? null : `turn-${index}`,
        createdAt: "2026-11-12T10:00:00.000Z",
      },
    },
  };
}

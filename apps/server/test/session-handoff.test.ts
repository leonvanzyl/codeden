import { join } from "node:path";
import {
  agentEventToNewEvent,
  type Item,
  type ProviderInfo,
  type RunnerCommandName,
  type RunnerCommandOf,
  type Session,
  type UserInput,
} from "@codeden/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { McpTokenStore } from "../src/mcp/tokens";
import type { ProjectService } from "../src/services/projects/project-service";
import type { RunnerPort } from "../src/services/runner-port";
import { handoffTitle } from "../src/services/sessions/handoff";
import { SessionLauncher } from "../src/services/sessions/launcher";
import { Outbox } from "../src/services/sessions/outbox";
import { SessionService, type SessionServiceDeps } from "../src/services/sessions/session-service";
import { createGithubEnv, type GithubEnv } from "./support/github-env";

const capabilities = (
  patch: Partial<ProviderInfo["capabilities"]> = {},
): ProviderInfo["capabilities"] => ({
  resume: true,
  steer: true,
  interrupt: true,
  approvals: true,
  userQuestions: true,
  subagents: true,
  rollback: false,
  fork: true,
  images: true,
  planMode: true,
  reasoningEffort: true,
  mcp: true,
  skills: true,
  readOnly: true,
  ...patch,
});

const PROVIDERS: ProviderInfo[] = [
  { id: "claude", displayName: "Claude Code", capabilities: capabilities(), models: [] },
  { id: "codex", displayName: "Codex", capabilities: capabilities(), models: [] },
  // No fork, no plan mode and no native read-only (as for an ACP agent).
  {
    id: "plain",
    displayName: "Plain",
    capabilities: capabilities({ fork: false, planMode: false, readOnly: false }),
    models: [],
  },
];

type Command = RunnerCommandOf<RunnerCommandName>;

let env: GithubEnv;
let calls: Command[];
/** Checkpoint indexes per session, once the runner settled them. */
let checkpoints: Record<string, number[]>;
/** Runs while the utility model writes the summary. */
let duringSummary: (() => void) | undefined;
let summary: string | null;
let transcripts: string[];

beforeEach(() => {
  env = createGithubEnv();
  calls = [];
  checkpoints = {};
  duringSummary = undefined;
  summary = "- Built the login form\n- The redirect test still fails";
  transcripts = [];
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
          checkpoints: (checkpoints[command.sessionId] ?? []).map((index) => ({
            index,
            ref: `refs/codeden/checkpoints/${command.sessionId}/${index}`,
            commit: `c${index}`,
            createdAt: "2026-11-14T10:00:00.000Z",
          })),
        };
      case "workspace.prepare":
        return { cwd: command.path ?? env.dir, branch: command.branch ?? null, created: true };
      case "session.start":
        return { resumeToken: `${command.providerId}-new` };
      default:
        return {};
    }
  }) as RunnerPort["request"],
} as unknown as RunnerPort;

function services() {
  const projects = {
    get: (id: string) => (id === env.githubProject.id ? env.githubProject : env.localProject),
  } as unknown as ProjectService;
  const launcher = new SessionLauncher({
    repo: env.repo,
    projects,
    runner,
    inbox: env.inbox,
    home: env.dir,
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
    utility: {
      handoffSummary: async (transcript: string) => {
        transcripts.push(transcript);
        duringSummary?.();
        return summary;
      },
    },
  } as unknown as SessionServiceDeps);
  return { sessions };
}

/** An idle Claude session with one finished turn on its own branch: a request, edits, a reply. */
function source(patch: Partial<Session> = {}): Session {
  const src = env.addSession({
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
    rootThreadId: "t-root",
    ...patch,
  });
  const item = (it: Item) => [
    agentEventToNewEvent(src.id, {
      type: "item.started",
      threadId: "t-root",
      turnId: "u1",
      item: it,
    }),
    agentEventToNewEvent(src.id, {
      type: "item.completed",
      threadId: "t-root",
      turnId: "u1",
      item: it,
    }),
  ];
  env.store.append([
    agentEventToNewEvent(src.id, { type: "thread.started", thread: { id: "t-root" } }),
    agentEventToNewEvent(src.id, { type: "turn.started", threadId: "t-root", turnId: "u1" }),
    ...item({
      id: `${src.id}-m1`,
      status: "completed",
      kind: "user_message",
      input: { text: "Add a login page", attachments: [] },
    }),
    ...item({
      id: `${src.id}-e1`,
      status: "completed",
      kind: "tool_call",
      toolKind: "file_edit",
      toolName: "Edit",
      changes: [{ path: join(src.worktreePath ?? env.dir, "src", "login.tsx"), change: "add" }],
    }),
    ...item({
      id: `${src.id}-r1`,
      status: "completed",
      kind: "assistant_message",
      text: "The form is in; the redirect test fails.",
    }),
    agentEventToNewEvent(src.id, { type: "turn.completed", threadId: "t-root", turnId: "u1" }),
  ]);
  // The events above move the projection on; put the status the test asked for back.
  return env.repo.update(src.id, (s) => ({ ...s, status: patch.status ?? "idle" }));
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

describe("handing a session off", () => {
  it("continues on another provider with the source's code and a brief as its first message", async () => {
    const { sessions } = services();
    const src = source();
    checkpoints[src.id] = [0, 1];
    const { sessionId } = await sessions.handoff(src.id, {
      provider: "codex",
      model: "gpt-5.5",
      note: "Fix the redirect test first.",
    });
    await settle(sessions);
    const next = env.repo.get(sessionId);

    expect(next).toMatchObject({
      projectId: src.projectId,
      role: "agent",
      provider: "codex",
      model: "gpt-5.5",
      // Efforts belong to a model: another provider starts from its own default.
      effort: null,
      autonomy: "supervised",
      planMode: false,
      purpose: "Add login",
      workKey: "issue:7",
      issue: src.issue,
      title: "Add login (to Codex)",
      startedBy: { kind: "user" },
      parentSessionId: null,
      forkedFrom: { sessionId: src.id, checkpoint: 1, kind: "handoff" },
      resumeToken: "codex-new",
      runnerId: "r1",
      // The brief started a turn.
      status: "running",
      baseBranch: "main",
    });
    expect(next.branch).toMatch(/^codeden\/add-login-to-codex-/);

    // The code: the settled checkpoint list, then a worktree from the source's branch with it.
    expect(calls.map((c) => c.name)).toEqual([
      "checkpoint.list",
      "workspace.prepare",
      "session.start",
    ]);
    expect(call("checkpoint.list")).toMatchObject({ sessionId: src.id, settled: true });
    expect(call("workspace.prepare")).toMatchObject({
      strategy: "worktree",
      baseRef: "codeden/add-login-s1ab",
      restoreCheckpoint: { sessionId: src.id, index: 1 },
    });
    expect(call("workspace.prepare").fetch).toBeUndefined();

    // A new conversation on Codex, opened with the brief from CodeDen.
    const start = call("session.start");
    expect(start.providerId).toBe("codex");
    expect(start.options).toMatchObject({ model: "gpt-5.5", cwd: next.worktreePath });
    expect(start.options.resumeToken).toBeUndefined();
    expect(start.input?.from).toBe("codeden");
    const brief = start.input?.text ?? "";
    expect(brief).toContain('another CodeDen session, "Add login" (Claude Code · opus)');
    expect(brief).toContain("## The task\n\nAdd a login page");
    expect(brief).toContain("- Built the login form\n- The redirect test still fails");
    expect(brief).toContain("## Files it edited\n\n- src/login.tsx");
    expect(brief).toContain("## What to do next (from the user)\n\nFix the redirect test first.");

    // The summary was written from the source's transcript.
    expect(transcripts).toEqual([
      expect.stringContaining(
        "User: Add a login page\nEdited: src/login.tsx\nAgent: The form is in",
      ),
    ]);
  });

  it("leaves the source untouched", async () => {
    const { sessions } = services();
    const src = source();
    checkpoints[src.id] = [0, 1];
    const before = env.events.filter((e) => e.sessionId === src.id).length;
    await sessions.handoff(src.id, { provider: "codex" });
    await settle(sessions);
    expect(env.repo.get(src.id)).toEqual(src);
    expect(env.events.filter((e) => e.sessionId === src.id)).toHaveLength(before);
  });

  it("keeps the model and effort on the same provider, and quotes the last reply without a summary", async () => {
    const { sessions } = services();
    const src = source();
    summary = null;
    const { sessionId } = await sessions.handoff(src.id, {
      provider: "claude",
      title: "Fresh start",
    });
    await settle(sessions);
    expect(env.repo.get(sessionId)).toMatchObject({
      provider: "claude",
      model: "opus",
      effort: "high",
      title: "Fresh start",
      forkedFrom: { sessionId: src.id, checkpoint: null, kind: "handoff" },
    });
    expect(call("workspace.prepare").restoreCheckpoint).toBeUndefined();
    const brief = call("session.start").input?.text ?? "";
    expect(brief).toContain("Its last reply:\n\n> The form is in; the redirect test fails.");
    expect(brief).toContain("## What to do next\n\nContinue the work where it left off.");
  });

  it("hands off sessions that failed, stopped or were interrupted, without needing fork", async () => {
    const { sessions } = services();
    for (const status of ["failed", "stopped", "interrupted", "completed"] as const) {
      const { sessionId } = await sessions.handoff(source({ status, provider: "plain" }).id, {
        provider: "claude",
      });
      await settle(sessions);
      expect(env.repo.get(sessionId).forkedFrom?.kind).toBe("handoff");
    }
  });

  it("refuses what it can't hand off, and creates nothing", async () => {
    const { sessions } = services();
    const refusal = async (src: Session, provider = "codex") => {
      try {
        await sessions.handoff(src.id, { provider });
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
    expect(await refusal(source({ branch: null }))).toEqual({
      status: 400,
      code: "fork_unsupported",
    });
    expect(await refusal(source({ role: "pm" }))).toEqual({
      status: 400,
      code: "fork_unsupported",
    });
    const fresh = env.addSession({ branch: "codeden/fresh", status: "idle" });
    expect(await refusal(fresh)).toEqual({ status: 409, code: "nothing_to_hand_off" });
    expect(await refusal(source(), "gone")).toEqual({ status: 400, code: "unknown_provider" });
    // Permissions the target can't keep are refused, never dropped.
    expect(await refusal(source({ autonomy: "read_only" }), "plain")).toEqual({
      status: 400,
      code: "read_only_unsupported",
    });
    expect(await refusal(source({ planMode: true }), "plain")).toEqual({
      status: 400,
      code: "plan_mode_unsupported",
    });
    const idle = source();
    env.githubProject.archivedAt = "2026-11-14T10:00:00.000Z";
    expect(await refusal(idle)).toEqual({ status: 400, code: "project_archived" });
    env.githubProject.archivedAt = null;

    expect(calls).toEqual([]);
    expect(sessions.launching.size).toBe(0);
    expect(env.repo.list().filter((s) => s.forkedFrom)).toEqual([]);
  });

  it("keeps a planning session planning on a provider that can plan", async () => {
    const { sessions } = services();
    const { sessionId } = await sessions.handoff(source({ planMode: true }).id, {
      provider: "codex",
    });
    await settle(sessions);
    expect(env.repo.get(sessionId).planMode).toBe(true);
    expect(call("session.start").options.planMode).toBe(true);
  });

  it("fails when the source runs a turn while the brief is written", async () => {
    const { sessions } = services();
    const src = source();
    duringSummary = () =>
      env.store.append([
        agentEventToNewEvent(src.id, { type: "turn.started", threadId: "t-root", turnId: "u2" }),
        agentEventToNewEvent(src.id, { type: "turn.completed", threadId: "t-root", turnId: "u2" }),
      ]);
    await expect(sessions.handoff(src.id, { provider: "codex" })).rejects.toMatchObject({
      status: 409,
      code: "source_changed",
    });
    expect(all("workspace.prepare")).toEqual([]);
    expect(env.repo.list().filter((s) => s.forkedFrom)).toEqual([]);
  });

  it("keeps titles within the limit", () => {
    const long = { ...env.addSession(), title: "x".repeat(200) };
    expect(handoffTitle(long, "Codex")).toHaveLength(200);
    expect(handoffTitle(long, "Codex").endsWith("x (to Codex)")).toBe(true);
    expect(handoffTitle({ ...long, title: null, purpose: "Fix it" }, "Codex")).toBe(
      "Fix it (to Codex)",
    );
  });
});

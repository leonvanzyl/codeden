import { describe, expect, it } from "vitest";
import {
  ArchiveSessionRequest,
  ArchiveSessionResponse,
  ConflictRecord,
  EventEnvelope,
  InboxItemKind,
  Notice,
  NoticeBatchData,
  Overview,
  ProjectStatus,
  ProviderCapabilities,
  RoleMessageRequest,
  RunnerCommand,
  Session,
  SessionOptions,
  Settings,
  Snapshot,
  StartWorkResult,
  UpdateSessionRequest,
  type WorkSummary,
  WorktreeCleanupOutcome,
} from "../src";
import { sampleSession, ts } from "./fixtures";

const work: WorkSummary = {
  kind: "session",
  id: "s1",
  sessionId: "s1",
  projectId: "p1",
  startedBy: { kind: "automation", id: "a1" },
  purpose: "Security audit",
  workKey: "automation:security-audit",
  scope: { projectId: "p1" },
  progress: null,
  status: "running",
  startedAt: ts,
};

const notice: Notice = {
  id: "n1",
  type: "conflict",
  projectId: "p1",
  target: "pm",
  sessionId: "s1",
  title: "Conflict: Security audit",
  createdAt: ts,
  deliveredAt: null,
  data: {
    conflictId: "c1",
    workKey: "automation:security-audit",
    purpose: "Security audit",
    requestedBy: { kind: "user" },
    existing: [work],
  },
};

describe("orchestration contracts (§8)", () => {
  it("round-trips typed notices, batches and their events", () => {
    expect(Notice.parse(notice)).toEqual(notice);
    expect(NoticeBatchData.parse({ notices: [notice] })).toEqual({ notices: [notice] });
    const event = { seq: 1, sessionId: null, ts, type: "notice.created", payload: { notice } };
    expect(EventEnvelope.parse(event)).toEqual(event);
    const delivered = {
      seq: 2,
      sessionId: null,
      ts,
      type: "notice.delivered",
      payload: { noticeIds: ["n1"], at: ts },
    };
    expect(EventEnvelope.parse(delivered)).toEqual(delivered);
    const returned = { ...delivered, seq: 3, type: "notice.returned" };
    expect(EventEnvelope.parse(returned)).toEqual(returned);
    expect(Notice.parse({ ...notice, wake: false })).toEqual({ ...notice, wake: false });
    expect(() => Notice.parse({ ...notice, type: "session.failed" })).toThrow();
  });

  it("round-trips a scheduled wake-up (§8.2)", () => {
    const reminder: Notice = {
      id: "reminder:1",
      type: "reminder",
      projectId: "p1",
      target: "pm",
      sessionId: null,
      title: "Wake-up you scheduled",
      createdAt: ts,
      deliveredAt: null,
      wake: true,
      notBefore: "2026-11-10T12:00:00.000Z",
      data: { note: "Check whether the audit finished", requestedBy: "pm-1" },
    };
    expect(Notice.parse(reminder)).toEqual(reminder);
    expect(() => Notice.parse({ ...reminder, notBefore: "tomorrow" })).toThrow();
  });

  it("round-trips the GitHub notices (§8.2, §9)", () => {
    const base = { projectId: "p1", target: "pm", createdAt: ts, deliveredAt: null } as const;
    const pr = { number: 7, url: "https://github.com/o/r/pull/7", state: "open" } as const;
    const list: Notice[] = [
      {
        ...base,
        id: "n2",
        type: "pr.checks_passed",
        sessionId: "s1",
        title: "Checks passed",
        data: { sessionId: "s1", pr },
      },
      {
        ...base,
        id: "n3",
        type: "pr.merged",
        sessionId: null,
        title: "Merged",
        data: { sessionId: null, pr: { ...pr, state: "merged" }, linkedIssues: [3] },
      },
      {
        ...base,
        id: "n4",
        type: "review.submitted",
        sessionId: "s1",
        title: "Review",
        data: { sessionId: "s1", pr, reviewer: "ana", state: "changes_requested", body: "Fix" },
      },
      {
        ...base,
        id: "n5",
        type: "issue.opened",
        sessionId: null,
        title: "Issue #3",
        data: {
          issue: { number: 3, url: "https://github.com/o/r/issues/3", title: "Bug" },
          author: null,
          labels: ["bug"],
        },
      },
      {
        ...base,
        id: "n6",
        type: "review.submitted",
        sessionId: null,
        title: "Review",
        data: {
          sessionId: null,
          pr,
          reviewer: "stranger",
          state: "changes_requested",
          body: "",
          untrusted: true,
        },
      },
    ];
    for (const n of list) expect(Notice.parse(n)).toEqual(n);
    expect(() => Notice.parse({ ...list[3], type: "pr.merged" })).toThrow();
  });

  it("round-trips an orchestrator message held back by the loop guard (§8.2)", () => {
    const held: Notice = {
      id: "orchestrator.message:1",
      type: "orchestrator.message",
      projectId: "p1",
      target: "pm",
      sessionId: "orch1",
      title: "Message from the orchestrator",
      createdAt: ts,
      deliveredAt: null,
      data: { fromSessionId: "orch1", text: "Please take issue #4 next" },
    };
    expect(Notice.parse(JSON.parse(JSON.stringify(held)))).toEqual(held);
    const anonymous = { ...held, data: { fromSessionId: null, text: "Status?" } };
    expect(Notice.parse(anonymous)).toEqual(anonymous);
    expect(NoticeBatchData.parse({ notices: [held] })).toEqual({ notices: [held] });
    expect(() => Notice.parse({ ...held, data: { text: "missing sender" } })).toThrow();
  });

  it("round-trips conflict records and the conflict inbox kind", () => {
    const record: ConflictRecord = {
      id: "conflict:1",
      projectId: "p1",
      request: {
        purpose: "Audit",
        workKey: "automation:security-audit",
        startedBy: { kind: "user" },
      },
      existing: [work],
      start: { projectId: "p1", role: "agent" },
      status: "open",
      resolution: null,
      outcome: null,
      createdAt: ts,
      resolvedAt: null,
    };
    expect(ConflictRecord.parse(record)).toEqual(record);
    expect(InboxItemKind.parse("conflict")).toBe("conflict");
    expect(
      StartWorkResult.parse({ status: "conflict", existing: [work], conflictId: "conflict:1" }),
    ).toMatchObject({ conflictId: "conflict:1" });
  });

  it("round-trips a project status with its autonomy mode", () => {
    const status: ProjectStatus = {
      project: { id: "p1", name: "Shop", kind: "github", mode: "assisted" },
      running: [work],
      queued: [],
      scheduled: [],
      inbox: { open: 0, items: [] },
      recent: [],
      factory: null,
    };
    expect(ProjectStatus.parse(status)).toEqual(status);
    const { mode: _mode, ...noMode } = status.project;
    expect(ProjectStatus.safeParse({ ...status, project: noMode }).success).toBe(false);
    // A status from before the factory line has none; a draining factory round-trips (#286).
    const { factory: _factory, ...old } = status;
    expect(ProjectStatus.parse(old).factory).toBeNull();
    const draining: ProjectStatus = {
      ...status,
      project: { ...status.project, mode: "dark_factory" },
      factory: { loopState: "draining", drainInFlight: 2 },
    };
    expect(ProjectStatus.parse(JSON.parse(JSON.stringify(draining)))).toEqual(draining);
    expect(
      ProjectStatus.safeParse({ ...draining, factory: { loopState: "draining", drainInFlight: -1 } })
        .success,
    ).toBe(false);
  });

  it("defaults role sessions in the snapshot and validates the HTTP shapes", () => {
    const overview: Overview = { generatedAt: ts, projects: [], sharedWork: [], pmMessages: [] };
    expect(Overview.parse(overview)).toEqual(overview);
    expect(Snapshot.shape.roleSessions.parse(undefined)).toBeUndefined();
    expect(RoleMessageRequest.parse({ input: { text: "hi" } })).toEqual({
      input: { text: "hi", attachments: [] },
      whenBusy: "queue",
    });
    expect(UpdateSessionRequest.parse({ model: null })).toEqual({ model: null });
    expect(() => UpdateSessionRequest.parse({})).toThrow();
  });

  it("carries readOnly and session.configure for role sessions", () => {
    const opts = SessionOptions.parse({
      sessionId: "pm1",
      role: "pm",
      cwd: "/r",
      autonomy: "auto",
      readOnly: true,
    });
    expect(opts.readOnly).toBe(true);
    expect(
      RunnerCommand.parse({
        name: "session.configure",
        sessionId: "s1",
        model: "m",
        effort: "high",
      }),
    ).toEqual({ name: "session.configure", sessionId: "s1", model: "m", effort: "high" });
  });
});

describe("autonomy changes on a running session (§11.2)", () => {
  it("round-trips autonomy in PATCH /api/sessions/:id", () => {
    const patch = { autonomy: "full" as const };
    expect(UpdateSessionRequest.parse(patch)).toEqual(patch);
    expect(UpdateSessionRequest.parse(JSON.parse(JSON.stringify(patch)))).toEqual(patch);
    expect(UpdateSessionRequest.parse({ autonomy: "supervised", model: "m" })).toEqual({
      autonomy: "supervised",
      model: "m",
    });
    expect(() => UpdateSessionRequest.parse({ autonomy: "yolo" })).toThrow();
    expect(() => UpdateSessionRequest.parse({ autonomy: null })).toThrow();
  });

  it("round-trips autonomy in the runner's session.configure", () => {
    const command = { name: "session.configure" as const, sessionId: "s1", autonomy: "full" };
    expect(RunnerCommand.parse(command)).toEqual(command);
    expect(RunnerCommand.parse(JSON.parse(JSON.stringify(command)))).toEqual(command);
    expect(() => RunnerCommand.parse({ ...command, autonomy: "never" })).toThrow();
  });

  it("reports whether a provider applies autonomy changes to a running turn", () => {
    const caps = {
      resume: true,
      steer: true,
      interrupt: true,
      approvals: true,
      userQuestions: true,
      subagents: true,
      rollback: false,
      fork: false,
      images: true,
      planMode: true,
      reasoningEffort: true,
      mcp: true,
      skills: true,
    };
    expect(ProviderCapabilities.parse({ ...caps, liveAutonomy: true })).toEqual({
      ...caps,
      liveAutonomy: true,
    });
    // Older runners leave it out: the UI then treats changes as applying from the next turn.
    expect(ProviderCapabilities.parse(caps).liveAutonomy).toBeUndefined();
  });
});

describe("session archive and worktree cleanup (§9)", () => {
  it("round-trips the archive shapes and the cleanup fields on a session", () => {
    expect(ArchiveSessionRequest.parse({})).toEqual({ force: false });
    const archived = {
      ...sampleSession,
      archivedAt: "2026-11-08T10:00:00.000Z",
      worktreeRemovedAt: "2026-11-08T10:00:01.000Z",
    };
    const response = ArchiveSessionResponse.parse({
      session: archived,
      worktree: { status: "kept_changes", message: "Uncommitted changes" },
    });
    expect(ArchiveSessionResponse.parse(JSON.parse(JSON.stringify(response)))).toEqual(response);
    expect(response.session.worktreeRemovedAt).toBe(archived.worktreeRemovedAt);
    // Sessions written before cleanup existed have neither field.
    expect(Session.parse(sampleSession).archivedAt).toBeUndefined();
    expect(() => WorktreeCleanupOutcome.parse({ status: "gone", message: null })).toThrow();
  });

  it("defaults worktree cleanup on, after a week", () => {
    const s = Settings.parse({});
    expect(s.worktrees).toEqual({ cleanup: true, afterDays: 7 });
    expect(() => Settings.parse({ worktrees: { afterDays: 0 } })).toThrow();
  });
});

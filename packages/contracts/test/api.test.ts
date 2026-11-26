import { describe, expect, it } from "vitest";
import {
  ARCHIVED_SESSIONS_DEFAULT_LIMIT,
  ArchivedSessionsPage,
  ArchivedSessionsQuery,
  CreateProjectRequest,
  DismissInboxRequest,
  DismissInboxResponse,
  defaultSettings,
  ForkSessionRequest,
  ForkSessionResponse,
  HANDOFF_NOTE_MAX,
  HandoffSessionRequest,
  HandoffSessionResponse,
  INBOX_BULK_MAX,
  type InboxItem,
  type InboxItemKind,
  InboxSettlement,
  inboxRestorable,
  inboxWaitsOnYou,
  ListSessionsQuery,
  LoginCommandResponse,
  LoginToolId,
  ProjectModelsQuery,
  ProjectModelsResponse,
  REVIEW_FOCUS_MAX,
  RefreshModelsResponse,
  ReorderProjectsRequest,
  RestoreInboxRequest,
  RestoreInboxResponse,
  RetryInboxResponse,
  ReviewSessionRequest,
  ReviewSessionResponse,
  SESSION_LOOKUP_MAX,
  SendMessageRequest,
  SessionSnapshot,
  SessionSnapshotQuery,
  SessionTranscriptExport,
  SetupCheck,
  SetupToolId,
  StartSessionRequest,
  StartSessionResponse,
  ThreadItemsQuery,
  UiClientMessage,
  UiServerMessage,
  UpdateProjectRequest,
} from "../src";
import { sampleInboxItem, sampleSession } from "./fixtures";

function roundTrip<T>(schema: { parse: (v: unknown) => T }, value: unknown): T {
  const first = schema.parse(value);
  const second = schema.parse(JSON.parse(JSON.stringify(first)));
  expect(second).toEqual(first);
  return second;
}

describe("api schemas", () => {
  it("fills start-session defaults", () => {
    const req = roundTrip(StartSessionRequest, { projectId: "p1", input: { text: "hi" } });
    expect(req.role).toBe("agent");
    // No mode: the server picks it from the project (a worktree in a git repository).
    expect(req.workspace).toEqual({});
    expect(req.startedBy).toEqual({ kind: "user" });
    expect(req.input?.attachments).toEqual([]);
    expect(req.replacesConflict).toBeUndefined();
  });

  it("round-trips the inbox retry and bulk dismiss (#275)", () => {
    const res = roundTrip(RetryInboxResponse, { item: sampleInboxItem });
    expect(res.item.attempts).toBe(1);
    expect(roundTrip(DismissInboxRequest, { ids: ["a", "b"] }).ids).toEqual(["a", "b"]);
    expect(DismissInboxRequest.safeParse({ ids: [] }).success).toBe(false);
    // An older server's answer still reads: no ids, nothing kept.
    expect(roundTrip(DismissInboxResponse, { dismissed: 2 })).toEqual({
      dismissed: 2,
      ids: [],
      kept: 0,
    });
  });

  it("takes ids or a filter for a bulk dismiss, and ids for its undo (#407)", () => {
    const byFilter = roundTrip(DismissInboxRequest, {
      filter: { projectId: "p1", kinds: ["run_failed", "message"] },
      note: "clean-up",
    });
    expect(byFilter.filter?.kinds).toEqual(["run_failed", "message"]);
    expect(roundTrip(DismissInboxRequest, { filter: {} }).filter).toEqual({});
    // Exactly one of the two.
    expect(DismissInboxRequest.safeParse({}).success).toBe(false);
    expect(DismissInboxRequest.safeParse({ ids: ["a"], filter: {} }).success).toBe(false);
    expect(DismissInboxRequest.safeParse({ filter: { kinds: [] } }).success).toBe(false);
    expect(DismissInboxRequest.safeParse({ filter: { kinds: ["nope"] } }).success).toBe(false);
    // The cap.
    const ids = (n: number) => Array.from({ length: n }, (_, i) => `inbox:${i}`);
    expect(DismissInboxRequest.safeParse({ ids: ids(INBOX_BULK_MAX) }).success).toBe(true);
    expect(DismissInboxRequest.safeParse({ ids: ids(INBOX_BULK_MAX + 1) }).success).toBe(false);

    const res = roundTrip(DismissInboxResponse, { dismissed: 2, ids: ["a", "b"], kept: 3 });
    expect(res).toEqual({ dismissed: 2, ids: ["a", "b"], kept: 3 });

    expect(roundTrip(RestoreInboxRequest, { ids: ["a", "b"] }).ids).toEqual(["a", "b"]);
    expect(RestoreInboxRequest.safeParse({ ids: [] }).success).toBe(false);
    expect(RestoreInboxRequest.safeParse({ ids: ids(INBOX_BULK_MAX + 1) }).success).toBe(false);
    expect(roundTrip(RestoreInboxResponse, { restored: 1, ids: ["a"] })).toEqual({
      restored: 1,
      ids: ["a"],
    });
  });

  it("holds back from a bulk dismiss only the items that wait on the user (#407)", () => {
    const item = (kind: InboxItemKind, extra: Partial<InboxItem> = {}) => ({
      ...sampleInboxItem,
      kind,
      priority: "normal" as const,
      notify: "factory" as const,
      ...extra,
    });
    for (const kind of [
      "question",
      "approval",
      "spec_approval",
      "setup_change",
      "conflict",
      "triage",
    ] as const) {
      expect(inboxWaitsOnYou(item(kind)), kind).toBe(true);
    }
    for (const kind of [
      "pr_review",
      "run_failed",
      "message",
      "automation_result",
      "spot_check",
      "cleanup_failed",
    ] as const) {
      expect(inboxWaitsOnYou(item(kind)), kind).toBe(false);
      expect(inboxWaitsOnYou(item(kind, { notify: "needs_you" })), kind).toBe(false);
    }
    // High priority for a person: a regression, a paused loop, a decision flagged needsHuman.
    expect(inboxWaitsOnYou(item("run_failed", { priority: "high", notify: "failure" }))).toBe(true);
    expect(inboxWaitsOnYou(item("message", { priority: "high", notify: "needs_you" }))).toBe(true);
    // High priority but the factory's own activity, or low priority for a person: notices.
    expect(inboxWaitsOnYou(item("message", { priority: "high", notify: "factory" }))).toBe(false);
    expect(inboxWaitsOnYou(item("message", { priority: "low", notify: "needs_you" }))).toBe(false);
  });

  it("restores bulk dismissals and the PM's resolutions, nothing else (#673)", () => {
    const closed = (extra: Partial<InboxItem>): InboxItem => ({
      ...sampleInboxItem,
      kind: "message",
      notify: "automation",
      status: "dismissed",
      resolvedAt: sampleInboxItem.createdAt,
      ...extra,
    });
    const pm = roundTrip(InboxSettlement, { by: "pm", note: "Issue #12 was closed upstream" });
    expect(inboxRestorable(closed({ resolution: { bulk: true } }))).toBe(true);
    expect(inboxRestorable(closed({ kind: "triage", status: "resolved", resolution: pm }))).toBe(
      true,
    );
    // Waits on the user: a bulk dismiss never closes it, so it never undoes one either.
    expect(inboxRestorable(closed({ kind: "triage", resolution: { bulk: true } }))).toBe(false);
    // Closed by hand, settled by CodeDen, or open again.
    expect(inboxRestorable(closed({ resolution: { note: "done" } }))).toBe(false);
    expect(inboxRestorable(closed({ resolution: { by: "codeden", note: "Issue closed" } }))).toBe(
      false,
    );
    expect(inboxRestorable(closed({ status: "open", resolution: pm }))).toBe(false);
    expect(InboxSettlement.safeParse({ by: "someone", note: "x" }).success).toBe(false);
  });

  it("names the open conflict a start replaces", () => {
    const req = roundTrip(StartSessionRequest, {
      projectId: "p1",
      input: { text: "Second wording" },
      replacesConflict: "conflict:1",
    });
    expect(req.replacesConflict).toBe("conflict:1");
    expect(StartSessionRequest.safeParse({ projectId: "p1", replacesConflict: "" }).success).toBe(
      false,
    );
  });

  it("round-trips a model refresh response", () => {
    const res = roundTrip(RefreshModelsResponse, {
      providers: [
        {
          id: "claude",
          displayName: "Claude Code",
          capabilities: {
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
          },
          models: [{ id: "fable", resolvedId: "claude-fable-5-2", label: "Fable 5.2" }],
        },
      ],
    });
    expect(res.providers[0]?.models[0]).toMatchObject({ resolvedId: "claude-fable-5-2" });
    expect(RefreshModelsResponse.safeParse({}).success).toBe(false);
  });

  it("round-trips a project's model list and its query", () => {
    const res = roundTrip(ProjectModelsResponse, {
      providerId: "opencode",
      projectId: "p1",
      models: [{ id: "9router/Worker", label: "Worker", description: "9Router" }],
      warnings: ["Skipped .opencode/opencode.json: not valid JSON"],
    });
    expect(res.models[0]?.id).toBe("9router/Worker");
    expect(roundTrip(ProjectModelsQuery, { projectId: "p1", refresh: "1" }).refresh).toBe("1");
    expect(ProjectModelsQuery.safeParse({ projectId: "" }).success).toBe(false);
  });

  it("round-trips Cursor's setup check and sign-in command", () => {
    expect(SetupToolId.options).toContain("cursor");
    const check = roundTrip(SetupCheck, {
      id: "cursor",
      label: "Cursor",
      state: "missing",
      installed: true,
      version: "2026.10.22-abc1234",
      executablePath: "/home/me/.local/bin/agent",
      loggedIn: false,
      authMethod: null,
      account: null,
      loginExpiresAt: null,
      message: "Not signed in to Cursor",
      fix: { kind: "login", command: "'/home/me/.local/bin/agent' login" },
      durationMs: 400,
    });
    expect(check.fix?.kind).toBe("login");
    expect(
      roundTrip(LoginCommandResponse, { tool: "cursor", command: "agent", args: ["login"] }).tool,
    ).toBe("cursor");
  });

  it("round-trips Gemini CLI's setup check and sign-in command", () => {
    expect(SetupToolId.options).toContain("gemini");
    const check = roundTrip(SetupCheck, {
      id: "gemini",
      label: "Gemini CLI",
      state: "ok",
      installed: true,
      version: "0.68.0",
      executablePath: "/usr/local/bin/gemini",
      loggedIn: true,
      authMethod: "oauth-personal",
      account: "dev@example.com",
      loginExpiresAt: null,
      message: "Signed in",
      fix: null,
      durationMs: 120,
    });
    expect(check.authMethod).toBe("oauth-personal");
    // Gemini CLI has no login command: run on its own, it asks how to sign in.
    expect(
      roundTrip(LoginCommandResponse, { tool: "gemini", command: "gemini", args: [] }),
    ).toEqual({ tool: "gemini", command: "gemini", args: [] });
  });

  it("round-trips OpenCode's setup check, sign-in command and provider info", () => {
    expect(SetupToolId.options).toContain("opencode");
    expect(LoginToolId.options).toEqual(["claude", "codex", "opencode", "cursor", "gemini", "gh"]);
    const check = roundTrip(SetupCheck, {
      id: "opencode",
      label: "OpenCode",
      state: "ok",
      installed: true,
      version: "2.2.7",
      executablePath: "C:UsersmeAppDataRoaming\npm\node_modules@opencodecli\binopencode.exe",
      loggedIn: true,
      authMethod: "credentials",
      account: "anthropic, openai",
      loginExpiresAt: null,
      message: "OpenCode 2.2.7, connected to anthropic, openai",
      fix: null,
      durationMs: 900,
    });
    expect(check.id).toBe("opencode");
    expect(
      roundTrip(LoginCommandResponse, {
        tool: "opencode",
        command: "opencode",
        args: ["auth", "login"],
      }).tool,
    ).toBe("opencode");
    expect(LoginCommandResponse.safeParse({ tool: "rm", command: "rm", args: [] }).success).toBe(
      false,
    );
    const info = roundTrip(RefreshModelsResponse, {
      providers: [
        {
          id: "opencode",
          displayName: "OpenCode",
          capabilities: {
            resume: true,
            steer: true,
            interrupt: true,
            approvals: true,
            userQuestions: true,
            subagents: true,
            rollback: false,
            fork: false,
            images: true,
            planMode: false,
            reasoningEffort: true,
            mcp: true,
            skills: false,
            liveAutonomy: true,
            readOnly: true,
          },
          models: [
            {
              id: "lmstudio/openai/gpt-oss-20b",
              label: "GPT OSS 20B",
              description: "LM Studio",
              efforts: ["low", "medium", "high"],
              contextWindow: 131072,
            },
          ],
        },
      ],
    });
    expect(info.providers[0]?.models[0]?.id).toBe("lmstudio/openai/gpt-oss-20b");
  });

  it("accepts every start outcome", () => {
    for (const value of [
      { status: "started", sessionId: "s1" },
      { status: "queued", sessionId: "s1", behind: ["s0"] },
      { status: "skipped" },
      { status: "joined", sessionId: "s0" },
    ]) {
      roundTrip(StartSessionResponse, value);
    }
    expect(() => StartSessionResponse.parse({ status: "conflict", existing: [] })).toThrow();
  });

  it("round-trips fork requests and responses", () => {
    expect(roundTrip(ForkSessionRequest, {})).toEqual({});
    expect(roundTrip(ForkSessionRequest, { title: "  Try OAuth instead " }).title).toBe(
      "Try OAuth instead",
    );
    expect(ForkSessionRequest.safeParse({ title: "" }).success).toBe(false);
    expect(ForkSessionRequest.safeParse({ title: "x".repeat(201) }).success).toBe(false);
    expect(roundTrip(ForkSessionRequest, { turnId: "turn-2" }).turnId).toBe("turn-2");
    expect(ForkSessionRequest.safeParse({ turnId: "" }).success).toBe(false);
    roundTrip(ForkSessionResponse, { sessionId: "s2" });
    expect(ForkSessionResponse.safeParse({}).success).toBe(false);
  });

  it("round-trips a session transcript export", () => {
    const file = { fileName: "fix-login-2026-11-14.md", markdown: "# Fix login\n" };
    expect(roundTrip(SessionTranscriptExport, file)).toEqual(file);
    expect(SessionTranscriptExport.safeParse({ fileName: "", markdown: "" }).success).toBe(false);
    expect(SessionTranscriptExport.safeParse({ fileName: "a.md" }).success).toBe(false);
  });

  it("round-trips handoff requests and responses", () => {
    expect(roundTrip(HandoffSessionRequest, { provider: "codex" })).toEqual({ provider: "codex" });
    const full = roundTrip(HandoffSessionRequest, {
      provider: "claude",
      model: " opus ",
      effort: "high",
      title: " Second opinion ",
      note: "  Review the approach before changing anything. ",
    });
    expect(full).toEqual({
      provider: "claude",
      model: "opus",
      effort: "high",
      title: "Second opinion",
      note: "Review the approach before changing anything.",
    });
    expect(
      roundTrip(HandoffSessionRequest, { provider: "codex", model: null, effort: null }),
    ).toEqual({ provider: "codex", model: null, effort: null });
    expect(HandoffSessionRequest.safeParse({}).success).toBe(false);
    expect(HandoffSessionRequest.safeParse({ provider: "" }).success).toBe(false);
    expect(HandoffSessionRequest.safeParse({ provider: "codex", note: " " }).success).toBe(false);
    expect(
      HandoffSessionRequest.safeParse({ provider: "codex", note: "x".repeat(HANDOFF_NOTE_MAX + 1) })
        .success,
    ).toBe(false);
    expect(HandoffSessionRequest.safeParse({ provider: "codex", effort: "huge" }).success).toBe(
      false,
    );
    roundTrip(HandoffSessionResponse, { sessionId: "s3" });
    expect(HandoffSessionResponse.safeParse({}).success).toBe(false);
  });

  it("round-trips review requests and responses (#356)", () => {
    expect(roundTrip(ReviewSessionRequest, { provider: "codex" })).toEqual({ provider: "codex" });
    expect(
      roundTrip(ReviewSessionRequest, {
        provider: "claude",
        model: " opus ",
        effort: "high",
        title: " Second look ",
        focus: "  The migration and its rollback. ",
      }),
    ).toEqual({
      provider: "claude",
      model: "opus",
      effort: "high",
      title: "Second look",
      focus: "The migration and its rollback.",
    });
    expect(
      roundTrip(ReviewSessionRequest, { provider: "codex", model: null, effort: null }),
    ).toEqual({ provider: "codex", model: null, effort: null });
    expect(ReviewSessionRequest.safeParse({}).success).toBe(false);
    expect(ReviewSessionRequest.safeParse({ provider: "" }).success).toBe(false);
    expect(ReviewSessionRequest.safeParse({ provider: "codex", focus: " " }).success).toBe(false);
    expect(
      ReviewSessionRequest.safeParse({ provider: "codex", focus: "x".repeat(REVIEW_FOCUS_MAX + 1) })
        .success,
    ).toBe(false);
    expect(ReviewSessionRequest.safeParse({ provider: "codex", title: "" }).success).toBe(false);
    roundTrip(ReviewSessionResponse, { sessionId: "s4" });
    expect(ReviewSessionResponse.safeParse({}).success).toBe(false);
  });

  it("defaults the handoff summary job on", () => {
    expect(defaultSettings().utilityModel.jobs.handoffSummaries).toBe(true);
  });

  it("parses project sources", () => {
    roundTrip(CreateProjectRequest, { source: { type: "local", path: "C:\\code\\app" } });
    roundTrip(CreateProjectRequest, { source: { type: "clone", url: "owner/repo" }, name: "App" });
    expect(() => CreateProjectRequest.parse({ source: { type: "ftp" } })).toThrow();
  });

  it("parses project pin and reorder requests", () => {
    expect(roundTrip(UpdateProjectRequest, { pinned: true })).toEqual({ pinned: true });
    expect(() => UpdateProjectRequest.parse({ pinned: "yes" })).toThrow();
    roundTrip(ReorderProjectsRequest, { projectIds: ["p2", "p1"] });
    roundTrip(ReorderProjectsRequest, { projectIds: [] });
    expect(() => ReorderProjectsRequest.parse({ projectIds: [""] })).toThrow();
    expect(() => ReorderProjectsRequest.parse({})).toThrow();
  });

  it("pages a project's archived sessions (#323)", () => {
    expect(ArchivedSessionsQuery.parse({})).toEqual({ limit: ARCHIVED_SESSIONS_DEFAULT_LIMIT });
    expect(roundTrip(ArchivedSessionsQuery, { cursor: "abc", limit: "20" })).toEqual({
      cursor: "abc",
      limit: 20,
    });
    expect(() => ArchivedSessionsQuery.parse({ limit: "0" })).toThrow();
    expect(() => ArchivedSessionsQuery.parse({ limit: "101" })).toThrow();
    expect(() => ArchivedSessionsQuery.parse({ cursor: "" })).toThrow();
    const archived = { ...sampleSession, archivedAt: sampleSession.updatedAt };
    const page = roundTrip(ArchivedSessionsPage, { sessions: [archived], nextCursor: "c1" });
    expect(page.sessions[0]?.archivedAt).toBe(sampleSession.updatedAt);
    expect(roundTrip(ArchivedSessionsPage, { sessions: [], nextCursor: null }).nextCursor).toBe(
      null,
    );
  });

  it("pages a session snapshot by root turns", () => {
    expect(roundTrip(SessionSnapshotQuery, {})).toEqual({});
    expect(SessionSnapshotQuery.parse({ turns: "20" })).toEqual({ turns: 20 });
    expect(roundTrip(SessionSnapshotQuery, { turns: 20, before: "u9" })).toEqual({
      turns: 20,
      before: "u9",
    });
    expect(roundTrip(SessionSnapshotQuery, { turns: 3, item: "i1" })).toEqual({
      turns: 3,
      item: "i1",
    });
    expect(() => SessionSnapshotQuery.parse({ turns: "0" })).toThrow();
    expect(() => SessionSnapshotQuery.parse({ before: "u9" })).toThrow();
    expect(() => SessionSnapshotQuery.parse({ item: "i1" })).toThrow();
    expect(() => SessionSnapshotQuery.parse({ turns: 5, before: "u9", item: "i1" })).toThrow();
    const snapshot = {
      seq: 3,
      session: sampleSession,
      threads: [],
      turns: [],
      items: [],
    };
    // A server from before paging sent no count: it was always the whole session.
    expect(roundTrip(SessionSnapshot, snapshot).earlierTurns).toBe(0);
    expect(roundTrip(SessionSnapshot, { ...snapshot, earlierTurns: 12 }).earlierTurns).toBe(12);
  });

  it("coerces query strings", () => {
    expect(ThreadItemsQuery.parse({ before: "10" })).toEqual({ before: 10, limit: 100 });
    expect(ListSessionsQuery.parse({ status: "running,idle" }).status).toEqual(["running", "idle"]);
    expect(() => ListSessionsQuery.parse({ status: "nope" })).toThrow();
    expect(ListSessionsQuery.parse({ ids: "s-1,s-2" }).ids).toEqual(["s-1", "s-2"]);
    expect(() => ListSessionsQuery.parse({ ids: "s-1,,s-2" })).toThrow();
    const tooMany = Array.from({ length: SESSION_LOOKUP_MAX + 1 }, (_, i) => `s-${i}`).join(",");
    expect(() => ListSessionsQuery.parse({ ids: tooMany })).toThrow();
    expect(SendMessageRequest.parse({ input: { text: "x" } }).whenBusy).toBe("queue");
  });

  it("extends the UI websocket protocol additively", () => {
    const sub = UiClientMessage.parse({ type: "subscribe", fromSeq: 3 });
    expect(sub.type === "subscribe" && sub.agentEvents).toBe(true);
    roundTrip(UiClientMessage, { type: "ping", id: "1" });
    roundTrip(UiClientMessage, { type: "watch_session", sessionId: "s1", fromSeq: 0 });
    roundTrip(UiServerMessage, {
      type: "transcript",
      sessionId: "s1",
      seq: 4,
      threads: [],
      turns: [],
      items: [],
    });
    roundTrip(UiServerMessage, { type: "hello", protocolVersion: 1, serverVersion: "0", seq: 0 });
  });

  it("defaults setup to not completed", () => {
    expect(defaultSettings().setup).toEqual({ completed: false, completedAt: null });
  });
});

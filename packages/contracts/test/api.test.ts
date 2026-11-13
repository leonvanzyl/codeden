import { describe, expect, it } from "vitest";
import {
  CreateProjectRequest,
  defaultSettings,
  ForkSessionRequest,
  ForkSessionResponse,
  ListSessionsQuery,
  LoginCommandResponse,
  LoginToolId,
  RefreshModelsResponse,
  ReorderProjectsRequest,
  SendMessageRequest,
  SetupCheck,
  SetupToolId,
  StartSessionRequest,
  StartSessionResponse,
  ThreadItemsQuery,
  UiClientMessage,
  UiServerMessage,
  UpdateProjectRequest,
} from "../src";

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
    expect(req.workspace.mode).toBe("worktree");
    expect(req.startedBy).toEqual({ kind: "user" });
    expect(req.input?.attachments).toEqual([]);
    expect(req.replacesConflict).toBeUndefined();
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

  it("round-trips OpenCode's setup check, sign-in command and provider info", () => {
    expect(SetupToolId.options).toContain("opencode");
    expect(LoginToolId.options).toEqual(["claude", "codex", "opencode", "gh"]);
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

  it("coerces query strings", () => {
    expect(ThreadItemsQuery.parse({ before: "10" })).toEqual({ before: 10, limit: 100 });
    expect(ListSessionsQuery.parse({ status: "running,idle" }).status).toEqual(["running", "idle"]);
    expect(() => ListSessionsQuery.parse({ status: "nope" })).toThrow();
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

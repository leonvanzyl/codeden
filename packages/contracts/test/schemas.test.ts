import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  AGENT_EVENT_TYPES,
  AgentEvent,
  Automation,
  agentEventToNewEvent,
  ClaudeSdkStatus,
  ClientToServerMessage,
  CODEDEN_VERSION,
  compareProjects,
  defaultSettings,
  ErrorInfo,
  EventEnvelope,
  InboxItem,
  Item,
  isAgentEnvelope,
  Project,
  ProviderStatus,
  RuntimeResponse,
  ServerToClientMessage,
  Session,
  SessionOptions,
  Settings,
  SetupCheck,
  Snapshot,
  SOURCE_VERSION,
  sortProjects,
} from "../src";
import {
  sampleAgentEvents,
  sampleAutomation,
  sampleInboxItem,
  sampleProject,
  sampleSession,
  ts,
} from "./fixtures";

/** Parse, serialize to JSON and parse again; the result must be stable. */
function roundTrip<T>(schema: { parse: (v: unknown) => T }, value: unknown): T {
  const first = schema.parse(value);
  const second = schema.parse(JSON.parse(JSON.stringify(first)));
  expect(second).toEqual(first);
  return second;
}

describe("agent events", () => {
  it("round-trips one of every event type", () => {
    for (const event of sampleAgentEvents) roundTrip(AgentEvent, event);
    const covered = new Set(sampleAgentEvents.map((e) => e.type));
    expect([...covered].sort()).toEqual([...AGENT_EVENT_TYPES].sort());
  });

  it("classifies failed turns, and still reads errors stored before the kind existed", () => {
    expect(ErrorInfo.parse({ message: "boom" })).toEqual({ message: "boom" });
    expect(ErrorInfo.safeParse({ message: "x", kind: "flaky" }).success).toBe(false);
    expect(ErrorInfo.safeParse({ message: "x", retryAt: "tomorrow" }).success).toBe(false);
    for (const kind of ["transient", "usage_limit", "context_full", "auth", "fatal"] as const) {
      roundTrip(ErrorInfo, { message: "x", kind });
    }
  });

  it("narrows tool calls by toolKind", () => {
    const item = Item.parse({
      id: "i1",
      kind: "tool_call",
      toolKind: "command",
      status: "in_progress",
      toolName: "Bash",
      command: "ls",
    });
    expect(item.kind === "tool_call" && item.toolKind === "command" && item.command).toBe("ls");
  });

  it("round-trips the images a tool call generated, by path only", () => {
    const item = roundTrip(Item, {
      id: "ig_1",
      kind: "tool_call",
      toolKind: "other",
      status: "completed",
      toolName: "image_generation",
      generatedImages: [{ path: "/home/u/.codex/generated_images/t/ig_1.png", caption: "A fox" }],
    });
    expect(item.kind === "tool_call" && item.generatedImages).toEqual([
      { path: "/home/u/.codex/generated_images/t/ig_1.png", caption: "A fox" },
    ]);
    expect(Item.safeParse({ ...item, generatedImages: [{ path: "", caption: "x" }] }).success).toBe(
      false,
    );
  });

  it("rejects a tool call missing its kind-specific fields", () => {
    const bad = { id: "i", kind: "tool_call", toolKind: "command", status: "completed" };
    expect(Item.safeParse({ ...bad, toolName: "Bash" }).success).toBe(false);
  });

  it("applies defaults to approvals, questions and inputs", () => {
    const approval = Item.parse({
      id: "a",
      kind: "approval_request",
      status: "in_progress",
      requestId: "r",
      action: "command",
      title: "Run rm -rf build",
    });
    expect(approval.kind === "approval_request" && approval.options).toEqual([
      "allow_once",
      "allow_session",
      "deny",
    ]);
    const msg = Item.parse({
      id: "m",
      kind: "user_message",
      status: "completed",
      input: { text: "hi" },
    });
    expect(msg.kind === "user_message" && msg.input.attachments).toEqual([]);
  });

  it("records who answered a question", () => {
    const answered = {
      id: "q",
      kind: "user_question",
      status: "completed",
      requestId: "r",
      questions: [{ id: "q1", question: "Zod or Valibot?" }],
      answers: { q1: ["Zod"] },
      decidedBy: "pm",
    };
    expect(roundTrip(Item, answered)).toMatchObject({ decidedBy: "pm", answers: { q1: ["Zod"] } });
    expect(Item.safeParse({ ...answered, decidedBy: "policy" }).success).toBe(false);
  });

  it("limits followups to four suggestions", () => {
    const suggestions = Array.from({ length: 5 }, (_, i) => ({ prompt: `p${i}` }));
    const result = Item.safeParse({
      id: "f",
      kind: "followups",
      status: "completed",
      source: "utility",
      suggestions,
    });
    expect(result.success).toBe(false);
  });
});

describe("persisted events", () => {
  it("wraps agent events as agent.<type> envelopes", () => {
    for (const event of sampleAgentEvents) {
      const envelope = roundTrip(EventEnvelope, {
        ...agentEventToNewEvent("s1", event),
        seq: 1,
        ts,
      });
      expect(envelope.type).toBe(`agent.${event.type}`);
      expect(isAgentEnvelope(envelope)).toBe(true);
    }
  });

  it("round-trips domain events", () => {
    const events = [
      { type: "project.created", sessionId: null, payload: { project: sampleProject } },
      {
        type: "project.updated",
        sessionId: null,
        payload: { project: { ...sampleProject, pinned: true, sortOrder: 3 } },
      },
      { type: "projects.reordered", sessionId: null, payload: { projectIds: ["p2", "p1"] } },
      { type: "session.created", sessionId: "s1", payload: { session: sampleSession } },
      { type: "inbox.created", sessionId: "s1", payload: { item: sampleInboxItem } },
      { type: "automation.saved", sessionId: null, payload: { automation: sampleAutomation } },
      {
        type: "automation.updated",
        sessionId: null,
        payload: { automationId: sampleAutomation.id, projectId: null },
      },
      { type: "settings.updated", sessionId: null, payload: { settings: defaultSettings() } },
      {
        type: "runner.connected",
        sessionId: null,
        payload: { runnerId: "r", version: "0.0.0", protocolVersion: 1 },
      },
    ];
    events.forEach((e, i) => {
      const envelope = roundTrip(EventEnvelope, { ...e, seq: i + 1, ts });
      expect(isAgentEnvelope(envelope)).toBe(false);
    });
  });

  it("parses project events written before pinning and ordering existed", () => {
    // A `project.created` payload from an older log: no `pinned`, no `sortOrder`.
    const { pinned: _pinned, sortOrder: _sortOrder, ...old } = sampleProject;
    const envelope = roundTrip(EventEnvelope, {
      type: "project.created",
      sessionId: null,
      payload: { project: old },
      seq: 1,
      ts,
    });
    expect(envelope.type === "project.created" && envelope.payload.project).toMatchObject({
      pinned: false,
      sortOrder: 0,
    });
  });

  it("rejects a reorder without ids", () => {
    const result = EventEnvelope.safeParse({
      type: "projects.reordered",
      sessionId: null,
      payload: {},
      seq: 1,
      ts,
    });
    expect(result.success).toBe(false);
  });

  it("requires a session id on agent events", () => {
    const result = EventEnvelope.safeParse({
      ...agentEventToNewEvent("s1", sampleAgentEvents[0] as AgentEvent),
      sessionId: null,
      seq: 1,
      ts,
    });
    expect(result.success).toBe(false);
  });
});

describe("entities", () => {
  it("round-trips projects, sessions, inbox items and automations", () => {
    roundTrip(Project, sampleProject);
    roundTrip(Project, { ...sampleProject, kind: "local", github: undefined });
    roundTrip(Session, sampleSession);
    roundTrip(Session, { ...sampleSession, forkedFrom: { sessionId: "s0", checkpoint: 2 } });
    roundTrip(Session, { ...sampleSession, forkedFrom: { sessionId: "s0", checkpoint: null } });
    expect(
      Session.safeParse({ ...sampleSession, forkedFrom: { sessionId: "s0", checkpoint: -1 } })
        .success,
    ).toBe(false);
    roundTrip(InboxItem, sampleInboxItem);
    roundTrip(InboxItem, {
      ...sampleInboxItem,
      kind: "cleanup_failed",
      priority: "normal",
      title: "Couldn't remove the worktree",
      body: "A file in the worktree is in use",
      itemId: null,
      requestId: null,
    });
    roundTrip(InboxItem, { ...sampleInboxItem, kind: "message", notify: "factory" });
    roundTrip(Automation, sampleAutomation);
  });

  it("reads inbox items stored without a notify category as needs_you", () => {
    const { notify: _, ...stored } = sampleInboxItem;
    expect(InboxItem.parse(stored).notify).toBe("needs_you");
    expect(InboxItem.safeParse({ ...sampleInboxItem, notify: "noise" }).success).toBe(false);
  });

  it("orders projects pinned first, then by sortOrder, then by name", () => {
    const p = (id: string, name: string, pinned: boolean, sortOrder: number) => ({
      id,
      name,
      pinned,
      sortOrder,
    });
    const list = [
      p("a", "Zeta", false, 0),
      p("b", "Alpha", false, 2),
      p("c", "Beta", true, 5),
      p("d", "Gamma", true, 1),
      p("e", "Delta", false, 0),
      p("f", "Delta", false, 0),
    ];
    expect(sortProjects(list).map((x) => x.id)).toEqual(["d", "c", "e", "f", "a", "b"]);
    expect(list.map((x) => x.id)).toEqual(["a", "b", "c", "d", "e", "f"]);
    const same = p("x", "X", false, 0);
    expect(compareProjects(same, { ...same })).toBe(0);
  });

  it("rejects a negative or fractional sortOrder", () => {
    expect(Project.safeParse({ ...sampleProject, sortOrder: -1 }).success).toBe(false);
    expect(Project.safeParse({ ...sampleProject, sortOrder: 1.5 }).success).toBe(false);
  });

  it("requires github coordinates on github projects", () => {
    const { github: _github, ...rest } = sampleProject as Extract<
      typeof sampleProject,
      { kind: "github" }
    >;
    expect(Project.safeParse(rest).success).toBe(false);
  });

  it("fills automation guard defaults and keeps automations off", () => {
    const { guards: _guards, enabled: _enabled, ...rest } = sampleAutomation;
    const parsed = Automation.parse(rest);
    expect(parsed.enabled).toBe(false);
    expect(parsed.guards).toEqual({
      overlapPolicy: "skip-if-running",
      maxConcurrent: 1,
      maxPerDay: null,
      quietHours: null,
      catchUpMissed: false,
    });
  });
});

describe("settings", () => {
  it("parses an empty object into complete defaults", () => {
    const s = Settings.parse({});
    expect(s.autonomy.default).toBe("auto");
    expect(s.voice.readAloud.enabled).toBe(false);
    expect(s.imageGeneration.engine).toBe("auto");
    expect(s.utilityModel.jobs.followups).toBe(true);
    expect(s.providers.agent.provider).toBe("auto");
    roundTrip(Settings, s);
  });

  it("keeps provided values and fills siblings", () => {
    const s = Settings.parse({ voice: { readAloud: { enabled: true } } });
    expect(s.voice.readAloud.enabled).toBe(true);
    expect(s.voice.readAloud.engine).toBe("browser");
    expect(s.voice.dictation.engine).toBe("browser");
  });
});

describe("provider contracts", () => {
  it("round-trips session options, statuses and responses", () => {
    const opts = roundTrip(SessionOptions, {
      sessionId: "s1",
      role: "agent",
      cwd: "/tmp/x",
      autonomy: "auto",
      mcpServers: [{ transport: "http", name: "codeden", url: "http://127.0.0.1:1234/mcp" }],
    });
    expect(opts.planMode).toBe(false);
    expect(opts.forkFrom).toBeUndefined();
    const fork = roundTrip(SessionOptions, { ...opts, forkFrom: "claude-session-1" });
    expect(fork.forkFrom).toBe("claude-session-1");
    expect(SessionOptions.safeParse({ ...opts, forkFrom: "" }).success).toBe(false);
    roundTrip(ProviderStatus, {
      providerId: "claude",
      installed: true,
      version: "2.1.0",
      executablePath: "/usr/bin/claude",
      loggedIn: false,
      authMethod: null,
      account: null,
      loginExpiresAt: null,
      supported: true,
      issues: [
        {
          code: "not_logged_in",
          message: "Not logged in",
          fix: { kind: "login", command: "claude auth login" },
        },
      ],
      checkedAt: ts,
    });
    const broken = roundTrip(ProviderStatus, {
      providerId: "claude",
      installed: false,
      version: null,
      executablePath: null,
      loggedIn: null,
      authMethod: null,
      account: null,
      loginExpiresAt: null,
      supported: false,
      issues: [{ code: "broken_install", message: "Claude Code is installed but broken" }],
      broken: [
        {
          path: "C:\npmclaude.cmd",
          reason: "points at a missing package",
          target: "C:\npm\node_modules@anthropic-aiclaude-codecli.js",
        },
      ],
      checkedAt: ts,
    });
    expect(broken.broken?.[0]?.reason).toBe("points at a missing package");
    roundTrip(RuntimeResponse, { kind: "approval", decision: "deny", message: "no" });
    roundTrip(RuntimeResponse, {
      kind: "approval",
      decision: "deny",
      message: "Nobody is watching",
      decidedBy: "policy",
    });
    expect(
      RuntimeResponse.safeParse({ kind: "approval", decision: "deny", decidedBy: "bot" }).success,
    ).toBe(false);
    roundTrip(RuntimeResponse, { kind: "answer", answers: { q1: ["SQLite"] } });
  });
});

describe("ui websocket", () => {
  it("round-trips client and server messages", () => {
    roundTrip(ClientToServerMessage, { type: "subscribe", fromSeq: 0 });
    roundTrip(ServerToClientMessage, {
      type: "events",
      events: [{ seq: 1, sessionId: null, type: "future.event", payload: { x: 1 }, ts }],
    });
    roundTrip(ServerToClientMessage, { type: "resync", reason: "gap", seq: 10 });
  });

  it("round-trips a snapshot", () => {
    roundTrip(Snapshot, {
      seq: 3,
      serverVersion: CODEDEN_VERSION,
      generatedAt: ts,
      settings: defaultSettings(),
      projects: [sampleProject],
      sessions: [sampleSession],
      inbox: [sampleInboxItem],
      automations: [sampleAutomation],
      runner: {
        state: "connected",
        runnerId: "r",
        version: "0.0.0",
        providers: [],
        lastError: null,
      },
    });
  });
});

describe("version", () => {
  it("matches the published codeden package version", () => {
    const pkgUrl = new URL("../../../apps/cli/package.json", import.meta.url);
    const pkg = JSON.parse(readFileSync(pkgUrl, "utf8")) as { version: string };
    expect(CODEDEN_VERSION).toBe(pkg.version);
    expect(SOURCE_VERSION).toBe(pkg.version);
  });

  it("matches the desktop app version (installers and the npm package ship together)", () => {
    const desktopUrl = new URL("../../../apps/desktop/package.json", import.meta.url);
    const desktop = JSON.parse(readFileSync(desktopUrl, "utf8")) as { version: string };
    expect(desktop.version).toBe(SOURCE_VERSION);
  });
});

describe("setup checks", () => {
  const check = {
    id: "claude",
    label: "Claude Code",
    state: "missing",
    installed: false,
    version: null,
    executablePath: null,
    loggedIn: null,
    authMethod: null,
    account: null,
    loginExpiresAt: null,
    message: "Claude Code is installed but broken",
    fix: { kind: "install", command: "npm install -g @anthropic-ai/claude-code" },
    durationMs: 12,
  } as const;

  it("round-trips broken copies and the underlying error", () => {
    const parsed = roundTrip(SetupCheck, {
      ...check,
      detail: "exit code 1: boom",
      broken: [{ path: "/usr/local/bin/claude", reason: "points at a missing file", target: "x" }],
    });
    expect(parsed.broken).toHaveLength(1);
    expect(parsed.detail).toBe("exit code 1: boom");
  });

  it("accepts checks from servers without the new fields", () => {
    const parsed = roundTrip(SetupCheck, check);
    expect(parsed.broken).toBeUndefined();
    expect(parsed.detail).toBeUndefined();
  });
});

describe("claude sdk status", () => {
  it("round-trips every state", () => {
    for (const state of ["ready", "missing", "installing", "failed"] as const) {
      const status: ClaudeSdkStatus = {
        state,
        version: "0.3.318",
        source: "deps",
        location: "/home/u/.codeden/deps",
        progress: state === "installing" ? "Downloading from npm" : null,
        error: state === "failed" ? "npm exited with code 1" : null,
      };
      expect(ClaudeSdkStatus.parse(JSON.parse(JSON.stringify(status)))).toEqual(status);
    }
  });

  it("rejects an unknown source", () => {
    expect(
      ClaudeSdkStatus.safeParse({
        state: "ready",
        version: "1",
        source: "global",
        location: null,
        progress: null,
        error: null,
      }).success,
    ).toBe(false);
  });
});

import { describe, expect, it } from "vitest";
import {
  devServerOf,
  ProjectConfigFile,
  RUNNER_PROTOCOL_VERSION,
  RunnerCommand,
  RunnerCommandResults,
  RunnerLock,
  RunnerToServerMessage,
  ServerToRunnerMessage,
} from "../src";
import { sampleAgentEvents, ts } from "./fixtures";

function roundTrip<T>(schema: { parse: (v: unknown) => T }, value: unknown): T {
  const first = schema.parse(value);
  expect(schema.parse(JSON.parse(JSON.stringify(first)))).toEqual(first);
  return first;
}

describe("runner protocol", () => {
  it("round-trips the handshake", () => {
    roundTrip(ServerToRunnerMessage, {
      type: "hello",
      protocolVersion: RUNNER_PROTOCOL_VERSION,
      serverVersion: "0.0.0",
    });
    roundTrip(RunnerToServerMessage, {
      type: "welcome",
      protocolVersion: RUNNER_PROTOCOL_VERSION,
      runnerId: "runner-1",
      runnerVersion: "0.0.0",
      pid: 1234,
      startedAt: ts,
      capabilities: { pty: false, browser: false, git: false, mcpProxy: false },
      providers: [],
      sessions: [],
      journal: { lastSeq: 0, unacked: 0 },
      draining: false,
    });
    roundTrip(ServerToRunnerMessage, { type: "resume", lastAckedSeq: 0 });
    // Where the runner runs: optional, so welcomes from older runners (above) still parse.
    const placed = roundTrip(RunnerToServerMessage, {
      type: "welcome",
      protocolVersion: RUNNER_PROTOCOL_VERSION,
      runnerId: "runner-2",
      runnerVersion: "0.0.0",
      pid: 7,
      startedAt: ts,
      capabilities: { pty: true, browser: true, git: true, mcpProxy: true },
      providers: [],
      sessions: [],
      journal: { lastSeq: 3, unacked: 1 },
      draining: false,
      platform: "linux",
      arch: "arm64",
      home: "/home/codeden/.codeden",
      backend: "docker",
    });
    expect(placed).toMatchObject({ platform: "linux", arch: "arm64", backend: "docker" });
    expect(() => RunnerToServerMessage.parse({ ...placed, backend: "somewhere-else" })).toThrow();
    roundTrip(RunnerToServerMessage, {
      type: "reject",
      reason: "protocol_mismatch",
      message: "unsupported",
      supportedProtocolVersions: [1],
    });
  });

  it("round-trips provider list updates", () => {
    const update = roundTrip(RunnerToServerMessage, {
      type: "providers",
      providers: [
        {
          id: "codex",
          displayName: "Codex",
          capabilities: {
            resume: true,
            steer: true,
            interrupt: true,
            approvals: true,
            userQuestions: true,
            subagents: false,
            rollback: false,
            fork: false,
            images: true,
            planMode: false,
            reasoningEffort: true,
            mcp: true,
            skills: true,
          },
          models: [
            {
              id: "gpt-6.1-sol",
              label: "GPT-6.1-Sol",
              efforts: ["low", "medium", "high", "xhigh", "max"],
              defaultEffort: "low",
              isDefault: true,
            },
            // Older payloads without efforts still parse.
            { id: "gpt-6-luna", label: "GPT-6-Luna" },
          ],
        },
      ],
    });
    expect(update.type === "providers" && update.providers[0]?.models[1]?.efforts).toEqual([]);
    roundTrip(RunnerToServerMessage, { type: "providers", providers: [] });
    expect(RunnerToServerMessage.safeParse({ type: "providers" }).success).toBe(false);
  });

  it("round-trips an alias model with the id it resolves to", () => {
    const update = roundTrip(RunnerToServerMessage, {
      type: "providers",
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
          models: [
            { id: "opus", resolvedId: "claude-opus-5-5", label: "Opus 5.5", efforts: ["high"] },
          ],
        },
      ],
    });
    expect(update.type === "providers" && update.providers[0]?.models[0]?.resolvedId).toBe(
      "claude-opus-5-5",
    );
  });

  it("round-trips a provider.detect that waits for the model lists", () => {
    const detect = roundTrip(RunnerCommand, {
      name: "provider.detect",
      providerId: "claude",
      waitForModels: true,
    });
    expect(detect.name === "provider.detect" && detect.waitForModels).toBe(true);
    // Older servers send neither field.
    roundTrip(RunnerCommand, { name: "provider.detect" });
    // The factory's periodic availability check only detects.
    const quick = roundTrip(RunnerCommand, { name: "provider.detect", refreshModels: false });
    expect(quick.name === "provider.detect" && quick.refreshModels).toBe(false);
    const result = roundTrip(RunnerCommandResults["provider.detect"], {
      statuses: [],
      providers: [],
    });
    expect(result.providers).toEqual([]);
    expect(roundTrip(RunnerCommandResults["provider.detect"], { statuses: [] }).providers).toBe(
      undefined,
    );
  });

  it("round-trips commands and results", () => {
    const start = roundTrip(ServerToRunnerMessage, {
      type: "command",
      id: "req-1",
      command: {
        name: "session.start",
        sessionId: "s1",
        providerId: "fake",
        options: { sessionId: "s1", role: "agent", cwd: "/tmp", autonomy: "auto" },
        input: { text: "hi" },
      },
    });
    expect(start.type === "command" && start.command.name).toBe("session.start");
    roundTrip(RunnerToServerMessage, { type: "result", id: "req-1", ok: true, result: {} });
    roundTrip(RunnerToServerMessage, {
      type: "result",
      id: "req-2",
      ok: false,
      error: { code: "unknown_session", message: "nope" },
    });
  });

  it("has a result schema for every command", () => {
    const names = RunnerCommand.options.map((o) => o.shape.name.value);
    expect(Object.keys(RunnerCommandResults).sort()).toEqual([...names].sort());
  });

  it("round-trips durable events, streams and acks", () => {
    sampleAgentEvents.forEach((event, i) => {
      roundTrip(RunnerToServerMessage, {
        type: "event",
        seq: i + 1,
        ts,
        event: { kind: "agent", sessionId: "s1", event },
      });
    });
    roundTrip(RunnerToServerMessage, {
      type: "event",
      seq: 99,
      ts,
      event: { kind: "session.process", sessionId: "s1", state: "exited", exitCode: 0 },
    });
    roundTrip(RunnerToServerMessage, {
      type: "stream",
      ts,
      stream: { kind: "pty.output", ptyId: "p1", data: "$ ls\r\n" },
    });
    roundTrip(ServerToRunnerMessage, { type: "ack", seq: 99 });
    expect(ServerToRunnerMessage.safeParse({ type: "ack", seq: 0 }).success).toBe(false);
  });

  it("round-trips workspace, git, checkpoint, pty and port commands", () => {
    const commands: unknown[] = [
      { name: "runner.configure", mcpUpstreamUrl: "http://127.0.0.1:4317/mcp" },
      { name: "runner.drain", reason: "upgrade", exitWhenDrained: true, timeoutMs: 1000 },
      {
        name: "workspace.prepare",
        sessionId: "s1",
        repoPath: "/repo",
        strategy: "worktree",
        projectSlug: "demo",
        fetch: true,
      },
      {
        name: "workspace.prepare",
        sessionId: "s2",
        repoPath: "/repo",
        strategy: "worktree",
        baseRef: "codeden/login-ab12",
        restoreCheckpoint: { sessionId: "s1", index: 3 },
      },
      { name: "workspace.remove", repoPath: "/repo", path: "/wt/demo/s1", deleteBranch: "b" },
      { name: "git.branches", cwd: "/repo" },
      { name: "git.commit", cwd: "/repo", message: "feat: x", paths: ["a.ts"] },
      { name: "git.push", cwd: "/repo", setUpstream: true },
      { name: "checkpoint.list", cwd: "/repo", sessionId: "s1" },
      { name: "checkpoint.list", cwd: "/repo", sessionId: "s1", settled: true },
      { name: "provider.fork", providerId: "claude", resumeToken: "claude-1", cwd: "/repo" },
      {
        name: "provider.fork",
        providerId: "codex",
        resumeToken: "thread-1",
        cwd: "/repo",
        upTo: "turn-3",
      },
      { name: "checkpoint.diff", cwd: "/repo", sessionId: "s1", from: 0, to: 2 },
      { name: "checkpoint.restoreFiles", cwd: "/repo", sessionId: "s1", index: 1 },
      { name: "pty.attach", ptyId: "p1" },
      { name: "ports.list", probe: [5173] },
      {
        name: "mcp.test",
        spec: { type: "stdio", command: "npx", args: ["-y", "x"], env: { A: "1" } },
        cwd: "/repo",
        expandEnv: true,
        timeoutMs: 30_000,
      },
      {
        name: "mcp.test",
        spec: { type: "http", url: "https://example.com/mcp", headers: { A: "b" } },
        expandEnv: false,
      },
      {
        name: "mcp.test",
        spec: { type: "stdio", command: "gh-mcp", extra: { env_vars: ["GITHUB_TOKEN"] } },
        expandEnv: false,
        stdioEnv: "allowlist",
      },
    ];
    for (const command of commands) roundTrip(RunnerCommand, command);
    expect(
      RunnerCommand.safeParse({ name: "checkpoint.diff", cwd: "/r", sessionId: "s", from: -1 })
        .success,
    ).toBe(false);
    const mcpTest = { name: "mcp.test", spec: { type: "http", url: "http://x" }, expandEnv: true };
    expect(RunnerCommand.safeParse({ ...mcpTest, timeoutMs: 120_001 }).success).toBe(false);
    expect(RunnerCommand.safeParse({ ...mcpTest, stdioEnv: "none" }).success).toBe(false);
    roundTrip(RunnerCommandResults["mcp.test"], {
      ok: true,
      durationMs: 5,
      server: { name: "s", version: "1" },
      protocolVersion: null,
      toolCount: 0,
      morePages: false,
      tools: [],
    });
    expect(
      RunnerCommand.safeParse({
        name: "workspace.prepare",
        sessionId: "s2",
        repoPath: "/repo",
        strategy: "worktree",
        restoreCheckpoint: { sessionId: "s1", index: -1 },
      }).success,
    ).toBe(false);
    roundTrip(RunnerCommandResults["checkpoint.diff"], {
      diff: "diff --git a/x b/x",
      files: [{ path: "x", status: "modified", additions: 1, deletions: 2, binary: false }],
    });
    roundTrip(RunnerCommandResults["provider.fork"], { resumeToken: "claude-2" });
    expect(RunnerCommandResults["provider.fork"].safeParse({ resumeToken: "" }).success).toBe(
      false,
    );
    expect(
      RunnerCommand.safeParse({ name: "provider.fork", providerId: "claude", cwd: "/repo" })
        .success,
    ).toBe(false);
    expect(
      RunnerCommand.safeParse({
        name: "provider.fork",
        providerId: "claude",
        resumeToken: "c",
        cwd: "/repo",
        upTo: "",
      }).success,
    ).toBe(false);
    roundTrip(RunnerCommandResults["workspace.remove"], { removed: true, discardedChanges: true });
    roundTrip(RunnerCommandResults["workspace.remove"], { removed: true });
    roundTrip(RunnerCommandResults["workspace.prepare"], {
      cwd: "/wt/demo/s1",
      branch: "codeden/demo",
      created: true,
      config: { setup: ["pnpm install"], devServer: { command: "pnpm dev", port: 5173 } },
      setup: [{ command: "pnpm install", exitCode: 0, ok: true }],
    });
    roundTrip(RunnerCommandResults["workspace.prepare"], {
      cwd: "/wt/demo/s1",
      branch: "codeden/demo",
      created: true,
      setup: [{ command: "pnpm install", exitCode: 1, ok: false, outputTail: "ERR_PNPM_NO_LOCK" }],
    });
    expect(
      RunnerCommandResults["workspace.prepare"].safeParse({
        cwd: "/wt",
        branch: null,
        created: true,
        setup: [{ command: "x", exitCode: 1, ok: false, outputTail: "x".repeat(2001) }],
      }).success,
    ).toBe(false);
    roundTrip(RunnerToServerMessage, {
      type: "event",
      seq: 1,
      ts,
      event: { kind: "checkpoint.created", sessionId: "s1", index: 1, ref: "r", commit: "c" },
    });
  });

  it("parses .codeden/project.json", () => {
    const config = ProjectConfigFile.parse({ devServer: "pnpm dev", other: 1 });
    expect(config.setup).toEqual([]);
    expect(devServerOf(config)).toEqual({ command: "pnpm dev" });
    expect(ProjectConfigFile.safeParse({ setup: "pnpm install" }).success).toBe(false);
  });

  it("validates the lock file", () => {
    roundTrip(RunnerLock, {
      pid: 1,
      port: 40000,
      token: "a".repeat(32),
      version: "0.0.0",
      protocolVersion: 1,
      runnerId: "r",
      startedAt: ts,
    });
    expect(RunnerLock.safeParse({ pid: 1, port: 0 }).success).toBe(false);
  });
});

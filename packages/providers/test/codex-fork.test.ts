import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SessionOptions } from "@codeden/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { CodexAdapter } from "../src/codex/adapter";
import { CodexSession } from "../src/codex/session";

const base: SessionOptions = {
  sessionId: "s2",
  role: "agent",
  cwd: tmpdir(),
  autonomy: "auto",
  mcpServers: [],
  additionalDirectories: [],
  planMode: false,
  systemPrompt: "You are the forked session s2.",
};

const fakeCodex = {
  kind: "node-script" as const,
  path: process.execPath,
  script: join(import.meta.dirname, "fixtures", "fake-codex", "app-server.mjs"),
};

type Logged = { method: string; params: Record<string, unknown> };
const requests = (file: string): Logged[] =>
  existsSync(file)
    ? readFileSync(file, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line))
    : [];

function logFile(): string {
  const log = join(mkdtempSync(join(tmpdir(), "codeden-codex-fork-")), "requests.log");
  process.env.FAKE_CODEX_LOG = log;
  return log;
}

const sessions: CodexSession[] = [];
afterEach(async () => {
  await Promise.all(sessions.splice(0).map((s) => s.close()));
  delete process.env.FAKE_CODEX_LOG;
});

describe("Codex fork", () => {
  it("reports the fork capability", () => {
    expect(new CodexAdapter().capabilities().fork).toBe(true);
  });

  it("forks the source thread with this session's cwd, policy and instructions", async () => {
    const log = logFile();
    const session = new CodexSession(
      { ...base, forkFrom: "thread-source" },
      {
        executable: fakeCodex,
      },
    );
    sessions.push(session);
    await session.start();
    expect(session.resumeToken()).toBe("thread-fork-1");
    const methods = requests(log).map((r) => r.method);
    expect(methods).toContain("thread/fork");
    expect(methods).not.toContain("thread/resume");
    expect(methods).not.toContain("thread/start");
    const fork = requests(log).find((r) => r.method === "thread/fork");
    expect(fork?.params).toMatchObject({
      threadId: "thread-source",
      excludeTurns: true,
      cwd: tmpdir(),
      approvalPolicy: "on-request",
      sandbox: "workspace-write",
      developerInstructions: "You are the forked session s2.",
    });
  });

  it("resumes its own thread once forked, never the source", async () => {
    const log = logFile();
    const session = new CodexSession(
      { ...base, forkFrom: "thread-source", resumeToken: "thread-fork-1" },
      { executable: fakeCodex },
    );
    sessions.push(session);
    await session.start();
    const methods = requests(log).map((r) => r.method);
    expect(methods).not.toContain("thread/fork");
    expect(requests(log).find((r) => r.method === "thread/resume")?.params).toMatchObject({
      threadId: "thread-fork-1",
    });
  });

  it("fails the start instead of starting a thread without the history", async () => {
    const log = logFile();
    const session = new CodexSession({ ...base, forkFrom: "missing" }, { executable: fakeCodex });
    sessions.push(session);
    await expect(session.start()).rejects.toThrow(/Could not fork Codex thread missing/);
    expect(requests(log).map((r) => r.method)).not.toContain("thread/start");
  });
});

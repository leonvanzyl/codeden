import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { FORK_POINT_MISSING } from "../src/adapter";
import { CodexAdapter } from "../src/codex/adapter";
import { forkCodexThread } from "../src/codex/fork";

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

afterEach(() => {
  delete process.env.FAKE_CODEX_LOG;
});

describe("Codex fork", () => {
  it("reports the fork capability and can fork", () => {
    const adapter = new CodexAdapter();
    expect(adapter.capabilities().fork).toBe(true);
    expect(typeof adapter.forkConversation).toBe("function");
  });

  it("copies the thread with thread/fork and returns the new thread's id", async () => {
    const log = logFile();
    const cwd = tmpdir();
    await expect(forkCodexThread(fakeCodex, "thread-source", { cwd })).resolves.toBe(
      "thread-fork-1",
    );
    const methods = requests(log).map((r) => r.method);
    expect(methods).toEqual(["initialize", "thread/fork"]);
    expect(requests(log).find((r) => r.method === "thread/fork")?.params).toEqual({
      threadId: "thread-source",
      cwd,
      excludeTurns: true,
    });
  });

  it("confirms the thread holds the turn, then ends the copy with it (lastTurnId)", async () => {
    const log = logFile();
    const cwd = tmpdir();
    const adapter = new CodexAdapter({ executable: fakeCodex });
    // turn-1 is on the second page of the turn list.
    await expect(adapter.forkConversation("thread-source", { cwd, upTo: "turn-1" })).resolves.toBe(
      "thread-fork-1",
    );
    expect(requests(log).map((r) => r.method)).toEqual([
      "initialize",
      "thread/turns/list",
      "thread/turns/list",
      "thread/fork",
    ]);
    expect(requests(log).find((r) => r.method === "thread/fork")?.params).toEqual({
      threadId: "thread-source",
      cwd,
      excludeTurns: true,
      lastTurnId: "turn-1",
    });
  });

  it("refuses a turn the thread no longer holds, without forking", async () => {
    const log = logFile();
    const adapter = new CodexAdapter({ executable: fakeCodex });
    await expect(
      adapter.forkConversation("thread-source", { cwd: tmpdir(), upTo: "turn-gone" }),
    ).rejects.toMatchObject({ code: FORK_POINT_MISSING });
    expect(requests(log).some((r) => r.method === "thread/fork")).toBe(false);
  });

  it("leaves the decision to thread/fork when the turn list can't be read", async () => {
    const log = logFile();
    const cwd = tmpdir();
    const adapter = new CodexAdapter({ executable: fakeCodex });
    await expect(adapter.forkConversation("old-codex", { cwd, upTo: "turn-2" })).resolves.toBe(
      "thread-fork-1",
    );
    expect(requests(log).find((r) => r.method === "thread/fork")?.params).toMatchObject({
      lastTurnId: "turn-2",
    });
  });

  it("forks forkFrom as a session opens, then resumes the copy (never the original)", async () => {
    const log = logFile();
    const adapter = new CodexAdapter({ executable: fakeCodex });
    const session = await adapter.openSession({
      sessionId: "s2",
      role: "agent",
      cwd: tmpdir(),
      autonomy: "auto",
      mcpServers: [],
      additionalDirectories: [],
      planMode: false,
      forkFrom: "thread-source",
    });
    try {
      const threadCalls = requests(log).filter((r) => r.method.startsWith("thread/"));
      expect(threadCalls.map((r) => [r.method, r.params.threadId])).toEqual([
        ["thread/fork", "thread-source"],
        ["thread/resume", "thread-fork-1"],
      ]);
    } finally {
      await session.close();
    }
  });

  it("says which thread could not be copied", async () => {
    logFile();
    await expect(forkCodexThread(fakeCodex, "missing", { cwd: tmpdir() })).rejects.toThrow(
      /Could not fork Codex thread missing: thread not found/,
    );
  });
});

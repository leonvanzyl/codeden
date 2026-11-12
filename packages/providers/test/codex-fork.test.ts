import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
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

  it("says which thread could not be copied", async () => {
    logFile();
    await expect(forkCodexThread(fakeCodex, "missing", { cwd: tmpdir() })).rejects.toThrow(
      /Could not fork Codex thread missing: thread not found/,
    );
  });
});

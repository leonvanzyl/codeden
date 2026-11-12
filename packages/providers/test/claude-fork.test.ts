import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { ClaudeAdapter } from "../src/claude/adapter";
import type { ClaudeSdkModule } from "../src/claude/sdk";
import { FakeProvider } from "../src/fake/adapter";
import type { ResolvedCommand } from "../src/util/exec";

const exe: ResolvedCommand = { kind: "native", path: "/opt/claude/claude" };

/** An SDK stand-in that records `forkSession()` calls; `query()` must not be used to fork. */
function stubSdk(fork: (id: string) => Promise<{ sessionId: string }>) {
  const forks: string[] = [];
  let queries = 0;
  const query = (() => {
    queries += 1;
    throw new Error("query() is not used to fork");
  }) as unknown as ClaudeSdkModule["query"];
  const forkSession = (async (id: string) => {
    forks.push(id);
    return fork(id);
  }) as ClaudeSdkModule["forkSession"];
  return { forks, queries: () => queries, load: async () => ({ query, forkSession }) };
}

describe("ClaudeAdapter fork", () => {
  it("reports the fork capability and can fork", () => {
    const adapter = new ClaudeAdapter({ executable: exe });
    expect(adapter.capabilities().fork).toBe(true);
    expect(typeof adapter.forkConversation).toBe("function");
  });

  it("copies the conversation with forkSession and returns the copy's id", async () => {
    const sdk = stubSdk(async () => ({ sessionId: "claude-fork-1" }));
    const adapter = new ClaudeAdapter({ executable: exe, loadSdk: sdk.load });
    await expect(adapter.forkConversation("claude-source")).resolves.toBe("claude-fork-1");
    expect(sdk.forks).toEqual(["claude-source"]);
    // No CLI is started: the copy is written to disk, nothing runs a turn.
    expect(sdk.queries()).toBe(0);
  });

  it("says which conversation could not be copied", async () => {
    const sdk = stubSdk(async () => {
      throw new Error("session not found");
    });
    const adapter = new ClaudeAdapter({ executable: exe, loadSdk: sdk.load });
    await expect(adapter.forkConversation("missing")).rejects.toThrow(
      /Could not fork the Claude conversation missing: session not found/,
    );
  });
});

describe("FakeProvider fork", () => {
  it("returns a new conversation each time", async () => {
    const fake = new FakeProvider();
    expect(fake.capabilities().fork).toBe(true);
    const first = await fake.forkConversation("fake-s1");
    const second = await fake.forkConversation("fake-s1");
    expect(first).not.toBe("fake-s1");
    expect(second).not.toBe(first);
    // Opening the copy resumes it like any other conversation.
    const session = await fake.openSession({
      sessionId: "s2",
      role: "agent",
      cwd: tmpdir(),
      autonomy: "auto",
      mcpServers: [],
      additionalDirectories: [],
      planMode: false,
      resumeToken: first,
    });
    expect(session.resumeToken()).toBe(first);
    await session.close();
  });
});

import { tmpdir } from "node:os";
import type { ForkSessionOptions, Options, Query } from "@anthropic-ai/claude-agent-sdk";
import type { SessionOptions } from "@codeden/contracts";
import { describe, expect, it } from "vitest";
import { type ProviderAdapter, withFork } from "../src/adapter";
import { ClaudeAdapter } from "../src/claude/adapter";
import type { ClaudeSdkModule } from "../src/claude/sdk";
import { FakeProvider } from "../src/fake/adapter";
import type { ResolvedCommand } from "../src/util/exec";

const exe: ResolvedCommand = { kind: "native", path: "/opt/claude/claude" };

/** An SDK stand-in: records `query()` options (an idle session) and `forkSession()` calls. */
function stubSdk(fork: (id: string, opts?: ForkSessionOptions) => Promise<{ sessionId: string }>) {
  const forks: string[] = [];
  const forkOptions: (ForkSessionOptions | undefined)[] = [];
  const launches: Options[] = [];
  const query = ((params: { options: Options }) => {
    launches.push(params.options);
    const q = {
      [Symbol.asyncIterator]: () => ({
        next: () => new Promise<IteratorResult<unknown>>(() => {}),
      }),
      supportedModels: async () => [],
      supportedCommands: async () => [],
      close: () => {},
    };
    return q as unknown as Query;
  }) as unknown as ClaudeSdkModule["query"];
  const forkSession = (async (id: string, opts?: ForkSessionOptions) => {
    forks.push(id);
    forkOptions.push(opts);
    return fork(id, opts);
  }) as ClaudeSdkModule["forkSession"];
  return { forks, forkOptions, launches, load: async () => ({ query, forkSession }) };
}

function options(extra: Partial<SessionOptions> = {}): SessionOptions {
  return {
    sessionId: "s2",
    role: "agent",
    cwd: tmpdir(),
    autonomy: "auto",
    mcpServers: [],
    additionalDirectories: [],
    planMode: false,
    ...extra,
  };
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
    expect(sdk.launches).toHaveLength(0);
  });

  it("ends the copy at a turn's fork point, and never copies everything when it's gone", async () => {
    // Like the SDK: a message the transcript doesn't hold is refused.
    const sdk = stubSdk(async (_id, opts) => {
      if (opts?.upToMessageId === "gone") throw new Error("Message gone not found in session");
      return { sessionId: "claude-fork-2" };
    });
    const adapter = new ClaudeAdapter({ executable: exe, loadSdk: sdk.load });
    await expect(
      adapter.forkConversation("claude-source", { cwd: tmpdir(), upTo: "msg-7" }),
    ).resolves.toBe("claude-fork-2");
    expect(sdk.forkOptions[0]).toEqual({ upToMessageId: "msg-7" });
    await expect(
      adapter.forkConversation("claude-source", { cwd: tmpdir(), upTo: "gone" }),
    ).rejects.toThrow(
      /Could not fork the Claude conversation claude-source: Message gone not found/,
    );
    // Without a fork point, the whole conversation.
    await adapter.forkConversation("claude-source", { cwd: tmpdir() });
    expect(sdk.forkOptions[2]).toBeUndefined();
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

  it("forks forkFrom as a session opens, then resumes the copy (never the original)", async () => {
    const sdk = stubSdk(async () => ({ sessionId: "claude-fork-1" }));
    const adapter = new ClaudeAdapter({ executable: exe, loadSdk: sdk.load });
    const session = await adapter.openSession(options({ forkFrom: "claude-source" }));
    expect(sdk.forks).toEqual(["claude-source"]);
    expect(session.resumeToken()).toBe("claude-fork-1");
    expect(sdk.launches[0]?.resume).toBe("claude-fork-1");
    await session.close();
  });

  it("lets a resume token win over forkFrom", async () => {
    const sdk = stubSdk(async () => ({ sessionId: "unexpected" }));
    const adapter = new ClaudeAdapter({ executable: exe, loadSdk: sdk.load });
    const session = await adapter.openSession(
      options({ forkFrom: "claude-source", resumeToken: "claude-fork-1" }),
    );
    expect(sdk.forks).toEqual([]);
    expect(sdk.launches[0]?.resume).toBe("claude-fork-1");
    await session.close();
  });

  it("fails to open when forkFrom can't be copied", async () => {
    const sdk = stubSdk(async () => {
      throw new Error("session not found");
    });
    const adapter = new ClaudeAdapter({ executable: exe, loadSdk: sdk.load });
    await expect(adapter.openSession(options({ forkFrom: "missing" }))).rejects.toThrow(
      /Could not fork the Claude conversation missing/,
    );
    expect(sdk.launches).toHaveLength(0);
  });
});

describe("FakeProvider fork", () => {
  it("returns a new conversation each time, and opens forkFrom as a copy", async () => {
    const fake = new FakeProvider();
    expect(fake.capabilities().fork).toBe(true);
    const first = await fake.forkConversation("fake-s1");
    const second = await fake.forkConversation("fake-s1");
    await expect(fake.forkConversation("fake-s1", { cwd: tmpdir(), upTo: "t2" })).resolves.toMatch(
      /^fake-s1:fork-\d+@t2$/,
    );
    expect(first).not.toBe("fake-s1");
    expect(second).not.toBe(first);
    const resumed = await fake.openSession(options({ resumeToken: first, forkFrom: "fake-s1" }));
    expect(resumed.resumeToken()).toBe(first);
    const forked = await fake.openSession(options({ forkFrom: "fake-s1" }));
    expect(forked.resumeToken()).toMatch(/^fake-s1:fork-/);
    expect(forked.resumeToken()).not.toBe(first);
    await Promise.all([resumed.close(), forked.close()]);
  });
});

describe("withFork", () => {
  it("refuses forkFrom on a provider that can't fork, instead of opening an empty conversation", async () => {
    const fake = new FakeProvider();
    const plain: ProviderAdapter = {
      id: "plain",
      displayName: "Plain",
      detect: () => fake.detect(),
      capabilities: () => ({ ...fake.capabilities(), fork: false }),
      models: () => [],
      openSession: (opts) => fake.openSession(opts),
    };
    await expect(withFork(plain, options({ forkFrom: "x" }))).rejects.toMatchObject({
      code: "unsupported",
    });
    // Nothing to fork: the options are used as they are.
    const opts = options({ resumeToken: "r1" });
    await expect(withFork(plain, opts)).resolves.toBe(opts);
  });
});

import { tmpdir } from "node:os";
import type { ForkSessionOptions, Options, Query } from "@anthropic-ai/claude-agent-sdk";
import type { SessionOptions } from "@codeden/contracts";
import { describe, expect, it } from "vitest";
import { FORK_POINT_MISSING, type ProviderAdapter, withFork } from "../src/adapter";
import { ClaudeAdapter } from "../src/claude/adapter";
import type { ClaudeSdkModule } from "../src/claude/sdk";
import { FakeProvider } from "../src/fake/adapter";
import type { ResolvedCommand } from "../src/util/exec";

const exe: ResolvedCommand = { kind: "native", path: "/opt/claude/claude" };

/**
 * A context compaction's boundary in a stub transcript. Like the SDK, `getSessionMessages()`
 * returns only the chain from the latest boundary on (it follows `parentUuid` links back from
 * the newest message, and a boundary has none), while `forkSession()` slices the whole file.
 */
const COMPACTED = "compact-boundary";

/**
 * An SDK stand-in: records `query()` options (an idle session), `forkSession()` calls, and the
 * order of transcript reads and copies (`calls`). `transcript` lists the message uuids a
 * conversation's transcript file holds, oldest first; `forkSession()` refuses an `upToMessageId`
 * the file doesn't hold, as the SDK does.
 */
function stubSdk(
  fork: (id: string, opts?: ForkSessionOptions) => Promise<{ sessionId: string }>,
  transcript: Record<string, string[]> = {},
) {
  const forks: string[] = [];
  const forkOptions: (ForkSessionOptions | undefined)[] = [];
  const launches: Options[] = [];
  const calls: string[] = [];
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
    calls.push(`fork ${id}`);
    forks.push(id);
    forkOptions.push(opts);
    const upTo = opts?.upToMessageId;
    if (upTo && transcript[id] && !transcript[id].includes(upTo)) {
      throw new Error(`Message ${upTo} not found in session ${id}`);
    }
    return fork(id, opts);
  }) as ClaudeSdkModule["forkSession"];
  const getSessionMessages = (async (id: string) => {
    calls.push(`read ${id}`);
    const file = transcript[id] ?? [];
    const chain = file.slice(Math.max(0, file.lastIndexOf(COMPACTED)));
    return chain.map((uuid) => ({
      type: uuid === COMPACTED ? "system" : "assistant",
      uuid,
      session_id: id,
    }));
  }) as unknown as ClaudeSdkModule["getSessionMessages"];
  return {
    forks,
    forkOptions,
    launches,
    calls,
    load: async () => ({ query, forkSession, getSessionMessages }),
  };
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

  it("confirms a turn's fork point in the transcript, then ends the copy there", async () => {
    const sdk = stubSdk(async () => ({ sessionId: "claude-fork-2" }), {
      "claude-source": ["msg-1", "msg-7", "msg-9"],
    });
    const adapter = new ClaudeAdapter({ executable: exe, loadSdk: sdk.load });
    await expect(
      adapter.forkConversation("claude-source", { cwd: tmpdir(), upTo: "msg-7" }),
    ).resolves.toBe("claude-fork-2");
    expect(sdk.calls).toEqual(["read claude-source", "fork claude-source"]);
    expect(sdk.forkOptions[0]).toEqual({ upToMessageId: "msg-7" });
  });

  it("refuses a fork point the transcript no longer holds, without copying anything", async () => {
    const sdk = stubSdk(async () => ({ sessionId: "unexpected" }), {
      "claude-source": ["msg-1", "msg-2"],
    });
    const adapter = new ClaudeAdapter({ executable: exe, loadSdk: sdk.load });
    await expect(
      adapter.forkConversation("claude-source", { cwd: tmpdir(), upTo: "gone" }),
    ).rejects.toMatchObject({ code: FORK_POINT_MISSING });
    // A conversation that was replaced or deleted reads as empty: refused the same way.
    await expect(
      adapter.forkConversation("replaced", { cwd: tmpdir(), upTo: "msg-1" }),
    ).rejects.toMatchObject({ code: FORK_POINT_MISSING });
    expect(sdk.calls).toEqual(["read claude-source", "read replaced"]);
    expect(sdk.forks).toEqual([]);
  });

  it("forks at a turn from before the latest context compaction", async () => {
    // Turn 1 ends at msg-2; the conversation was compacted after it, then went on.
    const sdk = stubSdk(async () => ({ sessionId: "claude-fork-4" }), {
      "claude-source": ["msg-1", "msg-2", COMPACTED, "summary", "msg-5", "msg-6"],
    });
    const adapter = new ClaudeAdapter({ executable: exe, loadSdk: sdk.load });
    await expect(
      adapter.forkConversation("claude-source", { cwd: tmpdir(), upTo: "msg-2" }),
    ).resolves.toBe("claude-fork-4");
    expect(sdk.calls).toEqual(["read claude-source", "fork claude-source"]);
    expect(sdk.forkOptions).toEqual([{ upToMessageId: "msg-2" }]);
  });

  it("forks at a turn after the latest context compaction", async () => {
    const sdk = stubSdk(async () => ({ sessionId: "claude-fork-5" }), {
      "claude-source": ["msg-1", "msg-2", COMPACTED, "summary", "msg-5", "msg-6"],
    });
    const adapter = new ClaudeAdapter({ executable: exe, loadSdk: sdk.load });
    await expect(
      adapter.forkConversation("claude-source", { cwd: tmpdir(), upTo: "msg-5" }),
    ).resolves.toBe("claude-fork-5");
    expect(sdk.forkOptions).toEqual([{ upToMessageId: "msg-5" }]);
  });

  it("refuses a fork point a compacted conversation doesn't hold, never copying it whole", async () => {
    const sdk = stubSdk(async () => ({ sessionId: "unexpected" }), {
      "claude-source": ["msg-1", "msg-2", COMPACTED, "summary", "msg-5"],
    });
    const adapter = new ClaudeAdapter({ executable: exe, loadSdk: sdk.load });
    await expect(
      adapter.forkConversation("claude-source", { cwd: tmpdir(), upTo: "gone" }),
    ).rejects.toMatchObject({ code: FORK_POINT_MISSING });
    // The read can't see before the compaction, so forkSession decides: it was only ever asked
    // for a copy ending at the fork point, and refused it.
    expect(sdk.forkOptions).toEqual([{ upToMessageId: "gone" }]);
  });

  it("keeps other fork failures of a compacted conversation plain errors", async () => {
    const sdk = stubSdk(
      async () => {
        throw new Error("disk full");
      },
      { "claude-source": ["msg-1", COMPACTED, "summary", "msg-4"] },
    );
    const adapter = new ClaudeAdapter({ executable: exe, loadSdk: sdk.load });
    const fork = adapter.forkConversation("claude-source", { cwd: tmpdir(), upTo: "msg-1" });
    await expect(fork).rejects.toThrow(/Could not fork the Claude conversation claude-source/);
    await expect(fork).rejects.not.toMatchObject({ code: FORK_POINT_MISSING });
  });

  it("copies the whole conversation without reading it when no fork point is given", async () => {
    const sdk = stubSdk(async () => ({ sessionId: "claude-fork-3" }));
    const adapter = new ClaudeAdapter({ executable: exe, loadSdk: sdk.load });
    await expect(adapter.forkConversation("claude-source", { cwd: tmpdir() })).resolves.toBe(
      "claude-fork-3",
    );
    expect(sdk.calls).toEqual(["fork claude-source"]);
    expect(sdk.forkOptions[0]).toBeUndefined();
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

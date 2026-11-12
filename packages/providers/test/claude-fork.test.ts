import { tmpdir } from "node:os";
import type { Options, Query } from "@anthropic-ai/claude-agent-sdk";
import type { SessionOptions } from "@codeden/contracts";
import { describe, expect, it } from "vitest";
import { ClaudeAdapter } from "../src/claude/adapter";
import type { ClaudeSdkModule } from "../src/claude/sdk";
import type { ResolvedCommand } from "../src/util/exec";

const exe: ResolvedCommand = { kind: "native", path: "/opt/claude/claude" };

/** An SDK stand-in: records `query()` options and `forkSession()` calls. */
function stubSdk(fork: (id: string) => Promise<{ sessionId: string }>) {
  const launches: Options[] = [];
  const forks: string[] = [];
  const query = ((params: { options: Options }) => {
    launches.push(params.options);
    const q = {
      [Symbol.asyncIterator]: () => ({
        next: () => new Promise<IteratorResult<unknown>>(() => {}),
      }),
      supportedModels: async () => [],
      close: () => {},
    };
    return q as unknown as Query;
  }) as unknown as ClaudeSdkModule["query"];
  const forkSession = (async (id: string) => {
    forks.push(id);
    return fork(id);
  }) as ClaudeSdkModule["forkSession"];
  return { launches, forks, load: async () => ({ query, forkSession }) };
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
  it("reports the fork capability", () => {
    expect(new ClaudeAdapter({ executable: exe }).capabilities().fork).toBe(true);
  });

  it("copies the conversation first, then resumes the copy (never the original)", async () => {
    const sdk = stubSdk(async () => ({ sessionId: "claude-fork-1" }));
    const adapter = new ClaudeAdapter({ executable: exe, loadSdk: sdk.load });
    const session = await adapter.openSession(options({ forkFrom: "claude-source" }));
    expect(sdk.forks).toEqual(["claude-source"]);
    expect(session.resumeToken()).toBe("claude-fork-1");
    expect(sdk.launches[0]?.resume).toBe("claude-fork-1");
    expect(sdk.launches[0]?.forkSession).toBeUndefined();
    await session.close();
  });

  it("does not fork again once the session has its own conversation", async () => {
    const sdk = stubSdk(async () => ({ sessionId: "unexpected" }));
    const adapter = new ClaudeAdapter({ executable: exe, loadSdk: sdk.load });
    const session = await adapter.openSession(
      options({ forkFrom: "claude-source", resumeToken: "claude-fork-1" }),
    );
    expect(sdk.forks).toEqual([]);
    expect(sdk.launches[0]?.resume).toBe("claude-fork-1");
    await session.close();
  });

  it("fails the start when the conversation cannot be copied", async () => {
    const sdk = stubSdk(async () => {
      throw new Error("session not found");
    });
    const adapter = new ClaudeAdapter({ executable: exe, loadSdk: sdk.load });
    await expect(adapter.openSession(options({ forkFrom: "missing" }))).rejects.toThrow(
      /Could not fork the Claude conversation missing: session not found/,
    );
    expect(sdk.launches).toHaveLength(0);
  });
});

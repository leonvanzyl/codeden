import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Options, Query, ModelInfo as SdkModelInfo } from "@anthropic-ai/claude-agent-sdk";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ClaudeAdapter } from "../src/claude/adapter";
import { listClaudeModels, toModelInfos } from "../src/claude/models";
import { type ClaudeSdkModule, claudeSdkReady } from "../src/claude/sdk";
import type { ResolvedCommand } from "../src/util/exec";

const exe: ResolvedCommand = { kind: "native", path: "/opt/claude/claude" };

const SDK_MODELS: SdkModelInfo[] = [
  {
    value: "default",
    resolvedModel: "claude-opus-5",
    displayName: "Default (recommended)",
    description: "Opus 5 for complex work",
    supportedEffortLevels: ["low", "medium", "high", "xhigh", "max"],
  },
  {
    value: "sonnet",
    resolvedModel: "claude-sonnet-5",
    displayName: "Sonnet",
    description: "",
    supportedEffortLevels: ["low"],
  },
  // A full id resolves to itself: no `resolvedId`.
  { value: "haiku", resolvedModel: "haiku", displayName: "", description: "Fastest" },
];

type Behaviour = "list" | "hang" | "fail" | "empty" | "newer";

/** The list after a model release: the `sonnet` alias moved on to a newer model. */
const NEWER_MODELS: SdkModelInfo[] = [
  ...SDK_MODELS.slice(0, 1),
  {
    value: "sonnet",
    resolvedModel: "claude-sonnet-5-5",
    displayName: "Sonnet 5.5",
    description: "",
    supportedEffortLevels: ["low"],
  },
];

/**
 * A stand-in for the SDK's `query()`. It records the options and whether the prompt stream
 * ever produced a user message (it must not: that would start a billable turn).
 */
function stubSdk(initial: Behaviour = "list") {
  const state = {
    behaviour: initial,
    launches: [] as Options[],
    promptMessages: 0,
    closed: 0,
  };
  const query = ((params: { prompt: AsyncIterable<unknown>; options: Options }) => {
    state.launches.push(params.options);
    // The CLI reads the prompt stream; count anything it yields.
    void (async () => {
      for await (const _message of params.prompt) state.promptMessages++;
    })();
    let finish = () => {};
    const done = new Promise<void>((resolve) => {
      finish = resolve;
    });
    params.options.abortController?.signal.addEventListener("abort", () => finish());
    const q = {
      [Symbol.asyncIterator]: () => ({
        next: async () => {
          await done;
          return { done: true as const, value: undefined };
        },
      }),
      supportedModels: async () => {
        if (state.behaviour === "fail") throw new Error("CLI exited");
        if (state.behaviour === "hang") return new Promise<SdkModelInfo[]>(() => {});
        if (state.behaviour === "newer") return NEWER_MODELS;
        return state.behaviour === "empty" ? [] : SDK_MODELS;
      },
      close: () => {
        state.closed++;
        finish();
      },
    };
    return q as unknown as Query;
  }) as unknown as ClaudeSdkModule["query"];
  const forkSession: ClaudeSdkModule["forkSession"] = async () => {
    throw new Error("not used here");
  };
  return { query, state, load: async () => ({ query, forkSession }) };
}

const EXPECTED = [
  {
    id: "default",
    resolvedId: "claude-opus-5",
    label: "Default (recommended)",
    description: "Opus 5 for complex work",
    efforts: ["low", "medium", "high", "xhigh", "max"],
    isDefault: true,
  },
  { id: "sonnet", resolvedId: "claude-sonnet-5", label: "Sonnet", efforts: ["low"] },
  { id: "haiku", label: "haiku", description: "Fastest", efforts: [] },
];

describe("listClaudeModels", () => {
  it("maps the SDK's model rows; the first one is the default", () => {
    expect(toModelInfos(SDK_MODELS)).toEqual(EXPECTED);
  });

  it("starts the CLI without a turn, reads supportedModels and closes it", async () => {
    const sdk = stubSdk();
    await expect(listClaudeModels(sdk.query, exe, { timeoutMs: 1_000 })).resolves.toEqual(EXPECTED);
    const [options] = sdk.state.launches;
    expect(options).toMatchObject({
      pathToClaudeCodeExecutable: exe.path,
      cwd: tmpdir(),
      settingSources: [],
      persistSession: false,
      tools: [],
      mcpServers: {},
      strictMcpConfig: true,
    });
    expect(options?.abortController?.signal.aborted).toBe(true);
    expect(sdk.state.closed).toBe(1);
    await new Promise((r) => setTimeout(r, 10));
    expect(sdk.state.promptMessages).toBe(0);
  });

  it("gives up on a CLI that never answers, and still closes it", async () => {
    const sdk = stubSdk("hang");
    const started = Date.now();
    await expect(listClaudeModels(sdk.query, exe, { timeoutMs: 200 })).rejects.toThrow(
      /within 200ms/,
    );
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(sdk.state.closed).toBe(1);
  });
});

describe("ClaudeAdapter model discovery", () => {
  it("replaces the alias fallback with the CLI's list and reports the change once", async () => {
    const sdk = stubSdk();
    const adapter = new ClaudeAdapter({ executable: exe, loadSdk: sdk.load });
    expect(adapter.models().map((m) => m.id)).toEqual(["default", "opus", "sonnet", "haiku"]);
    let changes = 0;
    adapter.onModelsChanged(() => changes++);

    // Concurrent refreshes share one CLI.
    await Promise.all([adapter.refreshModels(), adapter.refreshModels()]);
    expect(adapter.models()).toEqual(EXPECTED);
    expect(changes).toBe(1);
    expect(sdk.state.launches).toHaveLength(1);

    // The same list again is not a change.
    await adapter.refreshModels();
    expect(changes).toBe(1);
    expect(sdk.state.launches).toHaveLength(2);
  });

  it("keeps the last list when discovery fails, times out or lists nothing, and never throws", async () => {
    const sdk = stubSdk("fail");
    const adapter = new ClaudeAdapter({
      executable: exe,
      loadSdk: sdk.load,
      modelListTimeoutMs: 100,
    });
    await expect(adapter.refreshModels()).resolves.toBeUndefined();
    expect(adapter.models().map((m) => m.id)).toEqual(["default", "opus", "sonnet", "haiku"]);

    sdk.state.behaviour = "list";
    await adapter.refreshModels();
    for (const behaviour of ["fail", "hang", "empty"] as const) {
      sdk.state.behaviour = behaviour;
      await expect(adapter.refreshModels()).resolves.toBeUndefined();
      expect(adapter.models()).toEqual(EXPECTED);
    }

    const broken = new ClaudeAdapter({
      executable: exe,
      loadSdk: async () => {
        throw new Error("install failed");
      },
    });
    await expect(broken.refreshModels()).resolves.toBeUndefined();
  });

  it("skips a refresh with maxAgeMs while the list is recent, then asks again", async () => {
    const sdk = stubSdk();
    const adapter = new ClaudeAdapter({ executable: exe, loadSdk: sdk.load });
    // Never confirmed yet: even a long max age asks the CLI.
    await adapter.refreshModels({ maxAgeMs: 60_000 });
    expect(sdk.state.launches).toHaveLength(1);
    await adapter.refreshModels({ maxAgeMs: 60_000 });
    expect(sdk.state.launches).toHaveLength(1);
    // A model release later: an expired max age (or none) asks again and sees the new list.
    sdk.state.behaviour = "newer";
    await adapter.refreshModels({ maxAgeMs: 0 });
    expect(sdk.state.launches).toHaveLength(2);
    expect(adapter.models().find((m) => m.id === "sonnet")).toMatchObject({
      label: "Sonnet 5.5",
      resolvedId: "claude-sonnet-5-5",
    });
  });

  it("finds claude again after an update, and refreshes a recent list from the new one", async () => {
    const sdk = stubSdk();
    const name = process.platform === "win32" ? "claude.exe" : "claude";
    const oldDir = mkdtempSync(join(tmpdir(), "codeden-claude-old-"));
    const newDir = mkdtempSync(join(tmpdir(), "codeden-claude-new-"));
    // Executable, as installs are: a file without the bit is not a command on macOS and Linux.
    writeFileSync(join(oldDir, name), "old build", { mode: 0o755 });
    writeFileSync(join(newDir, name), "new build", { mode: 0o755 });
    const saved = { PATH: process.env.PATH, Path: process.env.Path };
    const setPath = (dir: string) => {
      process.env.PATH = dir;
      if (process.platform === "win32") process.env.Path = dir;
    };
    try {
      setPath(oldDir);
      const adapter = new ClaudeAdapter({ loadSdk: sdk.load });
      await adapter.refreshModels();
      expect(sdk.state.launches.at(-1)?.pathToClaudeCodeExecutable).toBe(join(oldDir, name));

      // Rewritten in place (the Windows native installer): the same path, a new file.
      writeFileSync(join(oldDir, name), "old build, updated");
      sdk.state.behaviour = "newer";
      await adapter.refreshModels({ maxAgeMs: 60 * 60_000 });
      expect(sdk.state.launches).toHaveLength(2);
      expect(adapter.models().find((m) => m.id === "sonnet")?.label).toBe("Sonnet 5.5");

      // Unchanged since: the recent list is kept without starting the CLI.
      await adapter.refreshModels({ maxAgeMs: 60 * 60_000 });
      expect(sdk.state.launches).toHaveLength(2);

      // Installed somewhere else (PATH now finds another claude): looked up again, not cached.
      setPath(newDir);
      await adapter.refreshModels({ maxAgeMs: 60 * 60_000 });
      expect(sdk.state.launches).toHaveLength(3);
      expect(sdk.state.launches.at(-1)?.pathToClaudeCodeExecutable).toBe(join(newDir, name));
      await expect(adapter.detect()).resolves.toBeDefined();
    } finally {
      process.env.PATH = saved.PATH;
      if (process.platform === "win32") process.env.Path = saved.Path;
    }
  });

  it("takes a session's list as the newest, and counts it as a refresh", async () => {
    const sdk = stubSdk();
    const adapter = new ClaudeAdapter({ executable: exe, loadSdk: sdk.load });
    await adapter.refreshModels();
    let changes = 0;
    adapter.onModelsChanged(() => changes++);
    // A session started after a model release reports the new list as it starts.
    sdk.state.behaviour = "newer";
    const session = await adapter.openSession({
      sessionId: "s1",
      role: "agent",
      cwd: tmpdir(),
      autonomy: "auto",
      additionalDirectories: [],
      mcpServers: [],
    } as unknown as Parameters<ClaudeAdapter["openSession"]>[0]);
    await vi.waitFor(() => expect(changes).toBe(1));
    expect(adapter.models().find((m) => m.id === "sonnet")?.label).toBe("Sonnet 5.5");
    expect(sdk.state.launches).toHaveLength(2);
    // That was a refresh: a reconnect right after starts no extra CLI.
    await adapter.refreshModels({ maxAgeMs: 60_000 });
    expect(sdk.state.launches).toHaveLength(2);
    await session.close();
  });

  it("skips discovery when Claude Code is not installed", async () => {
    const sdk = stubSdk();
    const keys = ["PATH", "Path", "HOME", "USERPROFILE"] as const;
    const saved = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
    const empty = mkdtempSync(join(tmpdir(), "codeden-empty-path-"));
    process.env.PATH = empty;
    if (process.platform === "win32") process.env.Path = empty;
    // Known install locations (`~/.local/bin`) are looked at too: an empty home has none.
    process.env.HOME = empty;
    process.env.USERPROFILE = empty;
    try {
      const adapter = new ClaudeAdapter({ loadSdk: sdk.load });
      await adapter.refreshModels();
      expect(sdk.state.launches).toHaveLength(0);
      expect(adapter.models().map((m) => m.id)).toEqual(["default", "opus", "sonnet", "haiku"]);
    } finally {
      for (const key of keys) {
        if (saved[key] === undefined) delete process.env[key];
        else process.env[key] = saved[key];
      }
    }
  });
});

describe("claudeSdkReady", () => {
  const saved = process.env.CODEDEN_CLAUDE_SDK;
  afterEach(() => {
    if (saved === undefined) delete process.env.CODEDEN_CLAUDE_SDK;
    else process.env.CODEDEN_CLAUDE_SDK = saved;
  });

  it("never asks discovery to install the SDK", async () => {
    process.env.CODEDEN_CLAUDE_SDK = "workspace";
    expect(claudeSdkReady()).toBe(true);
    // The published bundle with nothing installed yet: discovery waits for a session to
    // install the SDK.
    process.env.CODEDEN_CLAUDE_SDK = "deps";
    const { configureClaudeSdk } = await import("../src/claude/sdk");
    configureClaudeSdk({ depsDir: mkdtempSync(join(tmpdir(), "codeden-deps-")) });
    expect(claudeSdkReady()).toBe(false);
    const adapter = new ClaudeAdapter({ executable: exe });
    await expect(adapter.refreshModels()).resolves.toBeUndefined();
    expect(adapter.models().map((m) => m.id)).toEqual(["default", "opus", "sonnet", "haiku"]);
  });
});

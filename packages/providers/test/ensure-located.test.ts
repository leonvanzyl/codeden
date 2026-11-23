import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Options, Query } from "@anthropic-ai/claude-agent-sdk";
import type { SessionOptions } from "@codeden/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProviderSession } from "../src/adapter";
import { ClaudeAdapter } from "../src/claude/adapter";
import type { ClaudeSdkModule } from "../src/claude/sdk";
import { CodexAdapter } from "../src/codex/adapter";
import { OpenCodeAdapter } from "../src/opencode/adapter";
import { clearExecutableCache, ensureLocated, quickLocate } from "../src/util/locate";

const fixture = (...parts: string[]) => path.join(import.meta.dirname, "fixtures", ...parts);

const ENV_KEYS = ["PATH", "HOME", "CODEX_HOME"] as const;
let saved: Record<string, string | undefined>;
let dir: string;
let home: string;
let pathDir: string;
const sessions: ProviderSession[] = [];

beforeEach(() => {
  saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  dir = mkdtempSync(path.join(tmpdir(), "cd-ensure-located-"));
  home = path.join(dir, "home");
  pathDir = path.join(dir, "usr-local-bin");
  // As a runner that has just started: the old copy is first on PATH, the supported one is
  // where the tool's installer puts it (under the home), and nothing was checked yet.
  process.env.PATH = pathDir;
  process.env.HOME = home;
  delete process.env.CODEX_HOME;
  clearExecutableCache();
});

afterEach(async () => {
  await Promise.all(sessions.splice(0).map((s) => s.close()));
  for (const key of ENV_KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
  delete process.env.FAKE_OPENCODE_STATE;
  rmSync(dir, { recursive: true, force: true });
});

const ranLog = () => path.join(dir, "ran.log");
/** Which copies were started for anything but `--version`, in order. */
const ran = (): string[] =>
  existsSync(ranLog()) ? readFileSync(ranLog(), "utf8").trim().split("\n") : [];

/**
 * A copy of a CLI: prints `version` for `--version`; for anything else it notes `label` in
 * the log and, with `script`, becomes that fake (a Node script).
 */
function fakeCli(file: string, version: string, label: string, script?: string): string {
  mkdirSync(path.dirname(file), { recursive: true });
  const rest = script ? `exec '${process.execPath}' '${script}' "$@"` : "exit 0";
  writeFileSync(
    file,
    `#!/bin/sh\nif [ "$1" = "--version" ]; then echo '${version}'; exit 0; fi\necho ${label} >> '${ranLog()}'\n${rest}\n`,
  );
  chmodSync(file, 0o755);
  return file;
}

const sessionOptions = (): SessionOptions => ({
  sessionId: "s1",
  role: "agent",
  cwd: dir,
  autonomy: "auto",
  mcpServers: [],
  additionalDirectories: [],
  planMode: false,
});

/** A stand-in for the SDK's `query()` that records the options of every CLI it would start. */
function stubSdk() {
  const launches: Options[] = [];
  const query = ((params: { options: Options }) => {
    launches.push(params.options);
    let finish = () => {};
    const done = new Promise<void>((resolve) => {
      finish = resolve;
    });
    params.options.abortController?.signal.addEventListener("abort", () => finish());
    return {
      [Symbol.asyncIterator]: () => ({
        next: async () => {
          await done;
          return { done: true as const, value: undefined };
        },
      }),
      supportedModels: async () => [],
      supportedCommands: async () => [],
      close: () => finish(),
    } as unknown as Query;
  }) as unknown as ClaudeSdkModule["query"];
  const forkSession: ClaudeSdkModule["forkSession"] = async () => {
    throw new Error("not used here");
  };
  const getSessionMessages: ClaudeSdkModule["getSessionMessages"] = async () => [];
  return { launches, load: async () => ({ query, forkSession, getSessionMessages }) };
}

// The known install locations on Windows are `.exe` files, which a script cannot stand in for.
describe.skipIf(process.platform === "win32")("a runner's first session and model list", () => {
  it("ensureLocated checks the copies once per process", async () => {
    const old = fakeCli(path.join(pathDir, "claude"), "2.0.8 (Claude Code)", "old");
    const current = fakeCli(
      path.join(home, ".local", "bin", "claude"),
      "2.1.327 (Claude Code)",
      "supported",
    );
    expect(quickLocate("claude")?.path).toBe(old);
    const first = ensureLocated("claude", "2.1.250");
    expect(ensureLocated("claude", "2.1.250")).toBe(first);
    await first;
    expect(quickLocate("claude")?.path).toBe(current);
    clearExecutableCache();
    expect(ensureLocated("claude", "2.1.250")).not.toBe(first);
  });

  it("Claude Code: both start the supported copy with no detection before", async () => {
    fakeCli(path.join(pathDir, "claude"), "2.0.8 (Claude Code)", "old");
    const current = fakeCli(
      path.join(home, ".local", "bin", "claude"),
      "2.1.327 (Claude Code)",
      "supported",
    );
    const sdk = stubSdk();
    sessions.push(await new ClaudeAdapter({ loadSdk: sdk.load }).openSession(sessionOptions()));
    await vi.waitFor(() => expect(sdk.launches).toHaveLength(1));
    expect(sdk.launches[0]?.pathToClaudeCodeExecutable).toBe(current);

    clearExecutableCache();
    const listing = stubSdk();
    await new ClaudeAdapter({ loadSdk: listing.load }).refreshModels();
    expect(listing.launches.map((o) => o.pathToClaudeCodeExecutable)).toEqual([current]);
  });

  it("Codex: both start the supported copy with no detection before", async () => {
    const appServer = fixture("fake-codex", "app-server.mjs");
    fakeCli(path.join(pathDir, "codex"), "codex-cli 0.42.0", "old", appServer);
    fakeCli(path.join(home, ".local", "bin", "codex"), "codex-cli 0.167.0", "supported", appServer);
    sessions.push(await new CodexAdapter().openSession(sessionOptions()));
    expect(ran()).toEqual(["supported"]);

    clearExecutableCache();
    const adapter = new CodexAdapter();
    await adapter.refreshModels();
    expect(ran()).toEqual(["supported", "supported"]);
    expect(adapter.models().map((m) => m.id)).not.toEqual(["default"]);
  });

  it("OpenCode: both start the supported copy with no detection before", async () => {
    const opencode = fixture("fake-opencode", "opencode.mjs");
    process.env.FAKE_OPENCODE_STATE = path.join(dir, "state.json");
    fakeCli(path.join(pathDir, "opencode"), "1.19.5", "old", opencode);
    fakeCli(
      path.join(home, ".opencode", "bin", "opencode"),
      "opencode v2.2.7",
      "supported",
      opencode,
    );
    const options = { noGuardPlugin: true };
    sessions.push(await new OpenCodeAdapter(options).openSession(sessionOptions()));
    expect(ran()).toEqual(["supported"]);

    clearExecutableCache();
    await new OpenCodeAdapter(options).refreshModels();
    expect(ran()).toEqual(["supported", "supported"]);
  });
});

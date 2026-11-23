import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CursorAdapter } from "../src/cursor/adapter";
import {
  cursorInstallCommand,
  cursorLoginMessage,
  detectCursor,
  parseCursorStatus,
} from "../src/cursor/detect";
import { isCursorVersion } from "../src/cursor/locate";
import { parseModelList } from "../src/cursor/models";
import { probeCursor } from "../src/cursor/probe";
import type { ResolvedCommand } from "../src/util/exec";
import { clearExecutableCache } from "../src/util/locate";

const fakeAgent = {
  kind: "node-script" as const,
  path: process.execPath,
  script: join(import.meta.dirname, "fixtures", "fake-acp", "agent.mjs"),
};

afterEach(() => {
  for (const key of [
    "FAKE_ACP_STATUS",
    "FAKE_ACP_NO_ACP",
    "FAKE_ACP_VERSION",
    "FAKE_ACP_SUBAGENTS",
    "FAKE_ACP_LIST_MODELS",
    "FAKE_ACP_LOG",
  ]) {
    delete process.env[key];
  }
  clearExecutableCache();
});

describe("parseCursorStatus", () => {
  it("reads the login and the account, ANSI colours included", () => {
    expect(parseCursorStatus("\u001b[32m✓\u001b[0m Logged in as dev@example.com", 0)).toEqual({
      loggedIn: true,
      authMethod: "cursor",
      account: "dev@example.com",
    });
    expect(parseCursorStatus("Not logged in. Run `agent login`.", 1)).toEqual({
      loggedIn: false,
      authMethod: null,
      account: null,
    });
    expect(parseCursorStatus("", null)).toEqual({
      loggedIn: null,
      authMethod: null,
      account: null,
    });
  });

  it("counts an API key in the environment as signed in, without reading it", () => {
    expect(parseCursorStatus("Not logged in", 1, { CURSOR_API_KEY: "secret" })).toEqual({
      loggedIn: true,
      authMethod: "cursor_key",
      account: null,
    });
  });
});

describe("Cursor versions and model lists", () => {
  it("recognises Cursor's dated versions only", () => {
    expect(isCursorVersion("2026.10.22-abc1234")).toBe(true);
    expect(isCursorVersion("2026.9.5")).toBe(true);
    expect(isCursorVersion("1.4.2")).toBe(false);
    expect(isCursorVersion(null)).toBe(false);
  });

  it("parses the CLI's model list", () => {
    expect(
      parseModelList(
        "Available models\n\nauto - Auto (current)\ngpt-5 - GPT-5\n\u001b[2mTip\u001b[0m",
      ),
    ).toEqual({
      models: [
        { id: "auto", name: "Auto" },
        { id: "gpt-5", name: "GPT-5" },
      ],
      current: "auto",
    });
  });
});

describe("detectCursor", () => {
  const probe = (exe: ResolvedCommand, signedIn: boolean) =>
    probeCursor(exe, { signedIn, timeoutMs: 10_000 });

  it("reports the version and the login of a working CLI", async () => {
    const status = await detectCursor({ executable: fakeAgent, probe });
    expect(status).toMatchObject({
      providerId: "cursor",
      installed: true,
      version: "2026.10.22-abc1234",
      loggedIn: true,
      account: "dev@example.com",
      supported: true,
      issues: [],
    });
  });

  it("asks for `agent update` when the CLI has no ACP server, and `agent login` when signed out", async () => {
    process.env.FAKE_ACP_NO_ACP = "1";
    process.env.FAKE_ACP_STATUS = "Not logged in";
    const status = await detectCursor({ executable: fakeAgent, probe });
    expect(status.supported).toBe(false);
    expect(status.issues).toEqual([
      expect.objectContaining({
        code: "version_unsupported",
        fix: { kind: "upgrade", command: "agent update" },
      }),
      expect.objectContaining({
        code: "not_logged_in",
        fix: { kind: "login", command: "agent login" },
      }),
    ]);
  });

  it("reports the installer when nothing is installed", async () => {
    const status = await detectCursor({
      locate: { pathEnv: "", knownLocations: [], platform: "linux" },
    });
    expect(status.installed).toBe(false);
    expect(status.issues[0]).toMatchObject({
      code: "not_installed",
      fix: { kind: "install", command: cursorInstallCommand() },
    });
  });

  it("lists the account's models and reads the capabilities from a short-lived ACP server", async () => {
    const adapter = new CursorAdapter({ executable: fakeAgent });
    expect(adapter.capabilities().subagents).toBe(false);
    await adapter.refreshModels();
    expect(adapter.models().map((m) => m.id)).toEqual(["default", "auto", "gpt-5", "sonnet-4.5"]);
    // What the CLI reported in `initialize` refines the flags; the probe opts into subagents
    // as sessions do, so it learns whether they run as child sessions.
    expect(adapter.capabilities()).toMatchObject({
      images: true,
      mcp: true,
      planMode: true,
      resume: true,
      userQuestions: true,
      subagents: true,
      fork: false,
      steer: false,
    });
  });

  it("reports no subagents for a CLI that doesn't run them as child sessions", async () => {
    process.env.FAKE_ACP_SUBAGENTS = "0";
    const adapter = new CursorAdapter({ executable: fakeAgent });
    await adapter.refreshModels();
    expect(adapter.capabilities().subagents).toBe(false);
  });
});

describe("Cursor logins are never started in the background", () => {
  const logged = (file: string) =>
    existsSync(file)
      ? readFileSync(file, "utf8")
          .trim()
          .split("\n")
          .map((line) => (JSON.parse(line) as { method: string }).method)
      : [];

  it("never sends `authenticate` from detection or model refreshes, however often they run", async () => {
    const log = join(mkdtempSync(join(tmpdir(), "codeden-cursor-probe-")), "acp.log");
    process.env.FAKE_ACP_LOG = log;
    const adapter = new CursorAdapter({ executable: fakeAgent, probeTimeoutMs: 10_000 });
    for (let i = 0; i < 3; i += 1) {
      await adapter.detect();
      await adapter.refreshModels();
    }
    const methods = logged(log);
    expect(methods.filter((m) => m === "initialize").length).toBeGreaterThanOrEqual(3);
    expect(methods).not.toContain("authenticate");
    // Signed in: the models still come from the CLI's own list.
    expect(adapter.models().map((m) => m.id)).toContain("gpt-5");
  });

  it("reports a login that `agent status` calls signed in but the CLI can't use", async () => {
    process.env.FAKE_ACP_LIST_MODELS = "auth";
    const probe = (exe: ResolvedCommand, signedIn: boolean) =>
      probeCursor(exe, { signedIn, timeoutMs: 10_000 });
    const status = await detectCursor({ executable: fakeAgent, probe });
    expect(status.loggedIn).toBe(false);
    expect(status.issues).toEqual([
      expect.objectContaining({
        code: "not_logged_in",
        message: cursorLoginMessage("agent"),
        fix: { kind: "login", command: "agent login" },
      }),
    ]);
  });

  it("fails a session as 'sign in again' instead of letting the CLI open its browser login", async () => {
    const dir = mkdtempSync(join(tmpdir(), "codeden-cursor-guard-"));
    const log = join(dir, "acp.log");
    process.env.FAKE_ACP_LIST_MODELS = "auth";
    const adapter = new CursorAdapter({ executable: fakeAgent });
    const options = {
      sessionId: "s1",
      role: "agent" as const,
      cwd: dir,
      autonomy: "auto" as const,
      mcpServers: [],
      additionalDirectories: [],
      planMode: false,
      env: { FAKE_ACP_LOG: log },
    };
    await expect(adapter.openSession(options)).rejects.toThrow(cursorLoginMessage("agent"));
    expect(logged(log)).toContain("initialize");
    expect(logged(log)).not.toContain("authenticate");

    // With a usable login the session authenticates as before (reusing it).
    delete process.env.FAKE_ACP_LIST_MODELS;
    const session = await adapter.openSession(options);
    try {
      expect(logged(log)).toContain("authenticate");
    } finally {
      await session.close();
    }
  });
});

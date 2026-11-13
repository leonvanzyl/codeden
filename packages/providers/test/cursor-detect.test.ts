import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CursorAdapter } from "../src/cursor/adapter";
import { cursorInstallCommand, detectCursor, parseCursorStatus } from "../src/cursor/detect";
import { isCursorVersion } from "../src/cursor/locate";
import { modelsFromListing, parseModelList } from "../src/cursor/models";
import { probeCursor } from "../src/cursor/probe";
import type { ResolvedCommand } from "../src/util/exec";
import { clearExecutableCache } from "../src/util/locate";

const fakeAgent = {
  kind: "node-script" as const,
  path: process.execPath,
  script: join(import.meta.dirname, "fixtures", "fake-acp", "agent.mjs"),
};

afterEach(() => {
  for (const key of ["FAKE_ACP_STATUS", "FAKE_ACP_NO_ACP", "FAKE_ACP_VERSION"]) {
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
      authMethod: "api_key",
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

  it("parses the CLI's model list and Cursor's listing request", () => {
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
    expect(
      modelsFromListing({ models: [{ modelId: "gpt-5", displayName: "GPT-5" }, "sonnet"] }),
    ).toEqual({
      models: [{ id: "gpt-5", name: "GPT-5" }, { id: "sonnet" }],
    });
    expect(modelsFromListing("nonsense")).toEqual({ models: [] });
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

  it("lists the account's models through a short-lived ACP server, without a session", async () => {
    const adapter = new CursorAdapter({ executable: fakeAgent });
    await adapter.refreshModels();
    expect(adapter.models().map((m) => m.id)).toEqual(["default", "gpt-5", "sonnet-4.5"]);
    expect(adapter.capabilities()).toMatchObject({
      planMode: true,
      resume: true,
      userQuestions: true,
      subagents: false,
      fork: false,
      steer: false,
    });
  });
});

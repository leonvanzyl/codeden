import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { GeminiAdapter } from "../src/gemini/adapter";
import { parseGeminiAuth, readGeminiAuth } from "../src/gemini/auth";
import {
  detectGemini,
  GEMINI_INSTALL_COMMAND,
  GEMINI_UPGRADE_COMMAND,
  isSupportedGeminiVersion,
} from "../src/gemini/detect";
import { geminiToolFacts, readPlan } from "../src/gemini/extensions";
import { fallbackGeminiModels } from "../src/gemini/models";
import { probeGemini } from "../src/gemini/probe";
import type { ResolvedCommand } from "../src/util/exec";
import { parseJsonc } from "../src/util/jsonc";
import { clearExecutableCache } from "../src/util/locate";

const fakeGemini = {
  kind: "node-script" as const,
  path: process.execPath,
  script: join(import.meta.dirname, "fixtures", "fake-gemini", "gemini.mjs"),
};

afterEach(() => {
  for (const key of ["FAKE_GEMINI_VERSION", "FAKE_GEMINI_NO_ACP"]) delete process.env[key];
  clearExecutableCache();
});

describe("parseGeminiAuth", () => {
  it("reads a Google login from the account file, else the OAuth file's presence", () => {
    expect(
      parseGeminiAuth({ selectedType: "oauth-personal", activeAccount: "dev@example.com" }),
    ).toEqual({ loggedIn: true, authMethod: "oauth-personal", account: "dev@example.com" });
    expect(parseGeminiAuth({ selectedType: "oauth-personal", oauthFile: true })).toEqual({
      loggedIn: true,
      authMethod: "oauth-personal",
      account: null,
    });
    // The login may be in the system keychain: unknown, not signed out.
    expect(parseGeminiAuth({ selectedType: "oauth-personal" })).toMatchObject({
      loggedIn: null,
      authMethod: "oauth-personal",
      note: expect.stringMatching(/keychain/),
    });
  });

  it("counts API keys and Vertex AI by the variables' presence only", () => {
    const key = { GEMINI_API_KEY: "secret" };
    expect(parseGeminiAuth({ selectedType: "gemini-api-key", env: key })).toEqual({
      loggedIn: true,
      authMethod: "gemini-api-key",
      account: null,
    });
    expect(parseGeminiAuth({ selectedType: "gemini-api-key", env: {} })).toMatchObject({
      loggedIn: null,
      note: expect.stringMatching(/GEMINI_API_KEY/),
    });
    expect(
      parseGeminiAuth({
        selectedType: "vertex-ai",
        env: { GOOGLE_CLOUD_PROJECT: "p", GOOGLE_CLOUD_LOCATION: "us-central1" },
      }),
    ).toMatchObject({ loggedIn: true, authMethod: "vertex-ai" });
    expect(
      parseGeminiAuth({ selectedType: "vertex-ai", env: { GOOGLE_API_KEY: "k" } }).loggedIn,
    ).toBe(true);
    expect(
      parseGeminiAuth({ selectedType: "vertex-ai", env: { GOOGLE_CLOUD_PROJECT: "p" } }).loggedIn,
    ).toBe(null);
    for (const type of ["compute-default-credentials", "cloud-shell", "gateway"]) {
      expect(parseGeminiAuth({ selectedType: type })).toMatchObject({
        loggedIn: true,
        authMethod: type,
      });
    }
    expect(parseGeminiAuth({ selectedType: "something-new" }).loggedIn).toBeNull();
    expect(
      JSON.stringify(parseGeminiAuth({ selectedType: "gemini-api-key", env: key })),
    ).not.toContain("secret");
  });

  it("falls back to the environment when no method is selected, as Gemini CLI's ACP server does", () => {
    expect(parseGeminiAuth({ env: { GEMINI_API_KEY: "k" } })).toMatchObject({
      loggedIn: true,
      authMethod: "gemini-api-key",
    });
    expect(parseGeminiAuth({ env: { GOOGLE_GEMINI_BASE_URL: "https://gw" } })).toMatchObject({
      loggedIn: true,
      authMethod: "gateway",
    });
    expect(parseGeminiAuth({ env: {} })).toEqual({
      loggedIn: false,
      authMethod: null,
      account: null,
    });
  });
});

describe("readGeminiAuth", () => {
  const home = () => mkdtempSync(join(tmpdir(), "codeden-gemini-home-"));

  it("reads the selected method (with comments, or the older key) and the account, never the credentials", () => {
    const dir = home();
    mkdirSync(join(dir, ".gemini"));
    writeFileSync(
      join(dir, ".gemini", "settings.json"),
      '{\n  // signed in with Google\n  "security": { "auth": { "selectedType": "oauth-personal", }, },\n}',
    );
    writeFileSync(
      join(dir, ".gemini", "google_accounts.json"),
      JSON.stringify({ active: "dev@example.com", old: [] }),
    );
    writeFileSync(join(dir, ".gemini", "oauth_creds.json"), '{"access_token":"secret-token"}');
    const auth = readGeminiAuth({ home: dir, env: {} });
    expect(auth).toEqual({
      loggedIn: true,
      authMethod: "oauth-personal",
      account: "dev@example.com",
    });
    expect(JSON.stringify(auth)).not.toContain("secret");

    const legacy = home();
    mkdirSync(join(legacy, ".gemini"));
    writeFileSync(
      join(legacy, ".gemini", "settings.json"),
      JSON.stringify({ selectedAuthType: "gemini-api-key" }),
    );
    expect(readGeminiAuth({ home: legacy, env: { GEMINI_API_KEY: "k" } })).toMatchObject({
      loggedIn: true,
      authMethod: "gemini-api-key",
    });
  });

  it("honours GEMINI_CLI_HOME, and reports a missing folder as signed out", () => {
    const other = home();
    mkdirSync(join(other, ".gemini"));
    writeFileSync(join(other, ".gemini", "oauth_creds.json"), "{}");
    writeFileSync(
      join(other, ".gemini", "settings.json"),
      JSON.stringify({ security: { auth: { selectedType: "oauth-personal" } } }),
    );
    expect(readGeminiAuth({ home: home(), env: { GEMINI_CLI_HOME: other } }).loggedIn).toBe(true);
    expect(readGeminiAuth({ home: home(), env: {} }).loggedIn).toBe(false);
  });

  it("parses JSON with comments and trailing commas, leaving strings alone", () => {
    expect(parseJsonc('{ "a": "x // not a comment, }", /* gone */ "b": [1, 2,], }')).toEqual({
      a: "x // not a comment, }",
      b: [1, 2],
    });
    expect(parseJsonc("{ nope")).toBeUndefined();
  });
});

describe("Gemini CLI versions, tool facts and plans", () => {
  it("supports 0.68.0 and later, preview and nightly builds by their number", () => {
    expect(isSupportedGeminiVersion("0.68.0")).toBe(true);
    expect(isSupportedGeminiVersion("0.69.0-preview.1")).toBe(true);
    expect(isSupportedGeminiVersion("0.68.0-nightly.20261110.abc123")).toBe(true);
    expect(isSupportedGeminiVersion("0.67.9")).toBe(false);
    expect(isSupportedGeminiVersion("0.36.0")).toBe(false);
    expect(isSupportedGeminiVersion(null)).toBe(false);
  });

  it("reads the MCP server and tool from Gemini CLI's own fields, and a command's folder", () => {
    expect(
      geminiToolFacts({
        toolCallId: "c1",
        kind: "other",
        title: "report_progress",
        _meta: { "gemini-cli": { mcp: { server_name: "codeden", tool_name: "report_progress" } } },
      }),
    ).toEqual({ mcp: { server: "codeden", tool: "report_progress" } });
    expect(
      geminiToolFacts({
        toolCallId: "c2",
        kind: "execute",
        title: "pnpm test",
        content: [
          { type: "content", content: { type: "text", text: "[in packages/web] (run the tests)" } },
        ],
      }),
    ).toEqual({ cwd: "packages/web" });
    expect(geminiToolFacts({ toolCallId: "c3", kind: "edit", title: "Edit a.ts" })).toBeUndefined();
  });

  it("reads a plan only from a markdown file in the worktree or Gemini CLI's folder", () => {
    const dir = mkdtempSync(join(tmpdir(), "codeden-gemini-plan-"));
    writeFileSync(join(dir, "plan.md"), "# Add login\n\n1. Form");
    writeFileSync(join(dir, "notes.txt"), "secret");
    expect(readPlan(join(dir, "plan.md"), dir)).toBe("# Add login\n\n1. Form");
    expect(readPlan(join(dir, "notes.txt"), dir)).toMatch(/^Gemini CLI's plan is in/);
    const outside = mkdtempSync(join(tmpdir(), "codeden-gemini-out-"));
    writeFileSync(join(outside, "x.md"), "secret");
    expect(readPlan(join(outside, "x.md"), dir)).not.toContain("secret");
  });

  it("lists Default and Gemini CLI's aliases before any session", () => {
    expect(fallbackGeminiModels().map((m) => m.id)).toEqual([
      "default",
      "auto",
      "pro",
      "flash",
      "flash-lite",
    ]);
  });
});

describe("detectGemini", () => {
  const signedIn = () => ({
    loggedIn: true,
    authMethod: "oauth-personal",
    account: "dev@example.com",
  });
  const probe = (exe: ResolvedCommand) => probeGemini(exe, { timeoutMs: 10_000 });

  it("reports the version, the login and ACP support of a working CLI", async () => {
    const status = await detectGemini({ executable: fakeGemini, probe, auth: signedIn });
    expect(status).toMatchObject({
      providerId: "gemini",
      installed: true,
      version: "0.68.0",
      loggedIn: true,
      authMethod: "oauth-personal",
      account: "dev@example.com",
      supported: true,
      issues: [],
    });
  });

  it("asks for an update below 0.68.0 without starting the CLI's ACP server", async () => {
    process.env.FAKE_GEMINI_VERSION = "0.67.0";
    let probed = false;
    const status = await detectGemini({
      executable: fakeGemini,
      probe: async () => {
        probed = true;
        return { acp: true };
      },
      auth: signedIn,
    });
    expect(probed).toBe(false);
    expect(status.supported).toBe(false);
    expect(status.issues).toEqual([
      expect.objectContaining({
        code: "version_unsupported",
        fix: { kind: "upgrade", command: GEMINI_UPGRADE_COMMAND },
      }),
    ]);
  });

  it("flags a CLI whose ACP server doesn't answer, and a signed-out CLI", async () => {
    process.env.FAKE_GEMINI_NO_ACP = "1";
    const status = await detectGemini({
      executable: fakeGemini,
      probe,
      auth: () => ({ loggedIn: false, authMethod: null, account: null }),
    });
    expect(status.supported).toBe(false);
    expect(status.issues).toEqual([
      expect.objectContaining({ code: "version_unsupported" }),
      expect.objectContaining({ code: "not_logged_in", fix: { kind: "login", command: "gemini" } }),
    ]);
  });

  it("reports the installer when nothing is installed", async () => {
    const status = await detectGemini({
      locate: { pathEnv: "", knownLocations: [], platform: "linux" },
    });
    expect(status.installed).toBe(false);
    expect(status.issues[0]).toMatchObject({
      code: "not_installed",
      fix: { kind: "install", command: GEMINI_INSTALL_COMMAND },
    });
  });

  it("refines its flags from the CLI's `initialize` answer", async () => {
    const adapter = new GeminiAdapter({ executable: fakeGemini });
    await adapter.detect();
    expect(adapter.capabilities()).toMatchObject({
      resume: true,
      images: true,
      mcp: true,
      planMode: true,
      approvals: true,
      readOnly: true,
      liveAutonomy: true,
      userQuestions: false,
      subagents: false,
      steer: false,
      fork: false,
      reasoningEffort: false,
    });
  });
});

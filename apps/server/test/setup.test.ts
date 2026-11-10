import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import type { ExecutableLookup } from "@codeden/providers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Exec, ExecResult } from "../src/services/exec";
import {
  expiresWithin,
  parseClaudeAuth,
  parseCodexLogin,
  parseGhAuthJson,
  parseGhAuthText,
  parseOpenCodeAuth,
  parseVersion,
} from "../src/services/setup/parse";
import { SetupService, type SetupServiceDeps } from "../src/services/setup/setup-service";
import { execLocate } from "../src/services/setup/tool-lookup";
import { SettingsStore } from "../src/settings-store";

const NOW = Date.parse("2026-11-07T10:00:00.000Z");

describe("detection parsers", () => {
  it("reads versions", () => {
    expect(parseVersion("2.1.318 (Claude Code)")).toBe("2.1.318");
    expect(parseVersion("codex-cli 0.160.1")).toBe("0.160.1");
    expect(parseVersion("gh version 2.81.0 (2025-10-01)")).toBe("2.81.0");
    expect(parseVersion("nothing")).toBeNull();
  });

  it("reads claude auth status JSON", () => {
    const auth = parseClaudeAuth(
      JSON.stringify({
        loggedIn: true,
        authMethod: "claude.ai",
        loginExpiresAt: "2026-11-09T00:00:00Z",
        email: "a@b.c",
      }),
    );
    expect(auth).toEqual({
      loggedIn: true,
      authMethod: "claude.ai",
      account: "a@b.c",
      loginExpiresAt: "2026-11-09T00:00:00.000Z",
    });
    expect(parseClaudeAuth("not json")).toBeNull();
    expect(expiresWithin(auth?.loginExpiresAt ?? null, 3, NOW)).toBe(true);
    expect(expiresWithin("2026-12-01T00:00:00Z", 3, NOW)).toBe(false);
  });

  it("reads OpenCode's connected providers", () => {
    expect(parseVersion("opencode v2.2.7")).toBe("2.2.7");
    expect(
      parseOpenCodeAuth(
        JSON.stringify([
          { id: "anthropic", name: "Anthropic", connections: [{ type: "key", label: "API key" }] },
          { id: "google", name: "Google", connections: [{ type: "env", name: "GEMINI_API_KEY" }] },
          { id: "zai", name: "Z.AI", connections: [] },
        ]),
      ),
    ).toEqual({ providers: ["Anthropic", "Google"], authMethod: "api key, environment" });
    expect(parseOpenCodeAuth("[]")).toEqual({ providers: [], authMethod: null });
    expect(parseOpenCodeAuth("not json")).toBeNull();
  });

  it("reads codex and gh login state without capturing tokens", () => {
    expect(parseCodexLogin(0, "Logged in using ChatGPT")).toEqual({
      loggedIn: true,
      authMethod: "ChatGPT",
    });
    expect(parseCodexLogin(1, "Not logged in")).toEqual({ loggedIn: false, authMethod: null });
    expect(
      parseGhAuthJson(
        '{"hosts":{"github.com":[{"state":"success","active":true,"login":"octo","tokenSource":"keyring"}]}}',
      ),
    ).toEqual({ loggedIn: true, account: "octo" });
    const text =
      "github.com\n  ✓ Logged in to github.com account octo (keyring)\n  - Token: gho_****";
    const parsed = parseGhAuthText(0, text);
    expect(parsed).toEqual({ loggedIn: true, account: "octo" });
    expect(JSON.stringify(parsed)).not.toContain("gho_");
  });
});

/** Fake CLIs: a map from "command args" to a result (commands match by file name). */
function fakeExec(table: Record<string, Partial<ExecResult>>, calls: string[] = []): Exec {
  return async (command, args) => {
    const key = [basename(command), ...args].join(" ");
    calls.push(key);
    const hit = table[key];
    if (!hit)
      return { code: null, stdout: "", stderr: "", notFound: true, timedOut: false, path: null };
    return {
      code: 0,
      stdout: "",
      stderr: "",
      notFound: false,
      timedOut: false,
      path: `/bin/${command}`,
      ...hit,
    };
  };
}

/** Fake look-up: a tool is found at `/bin/<name>` when the table answers its `--version`. */
function fakeLocate(
  table: Record<string, Partial<ExecResult>>,
  overrides: Record<string, ExecutableLookup> = {},
): (name: string) => Promise<ExecutableLookup> {
  return async (name) => {
    const override = overrides[name];
    if (override) return override;
    const hit = table[`${name} --version`];
    if (!hit || (hit.code ?? 0) !== 0) return { version: null, broken: [] };
    const version = /\d+\.\d+\.\d+/.exec(hit.stdout ?? "")?.[0] ?? null;
    return { command: { kind: "native", path: `/bin/${name}` }, version, broken: [] };
  };
}

/** A service over fake CLIs, with no PATH refresh and a bash setup terminal. */
function service(
  table: Record<string, Partial<ExecResult>>,
  deps: Partial<SetupServiceDeps> & { calls?: string[] } = {},
): SetupService {
  const { calls, ...rest } = deps;
  return new SetupService({
    exec: fakeExec(table, calls),
    locate: fakeLocate(table),
    refreshPath: async () => undefined,
    shell: "/bin/bash",
    settings,
    platform: "linux",
    ...rest,
  });
}

let dir: string;
let settings: SettingsStore;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "codeden-setup-"));
  settings = new SettingsStore(join(dir, "settings.json"));
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

const happy: Record<string, Partial<ExecResult>> = {
  "claude --version": { stdout: "2.1.318 (Claude Code)" },
  "claude auth status": {
    stdout: JSON.stringify({
      loggedIn: true,
      authMethod: "claude.ai",
      loginExpiresAt: "2026-11-08T00:00:00Z",
    }),
  },
  "codex --version": { stdout: "codex-cli 0.160.1" },
  "codex login status": { code: 1, stdout: "Not logged in" },
  "git --version": { stdout: "git version 2.50.1" },
  "git config --get user.name": { stdout: "Ada" },
  "git config --get user.email": { stdout: "ada@example.com" },
};

describe("SetupService", () => {
  it("runs every check, flags an expiring Claude login and reports readiness", async () => {
    const setup = service(happy, {
      nodeVersion: "v24.16.0",
      now: () => NOW,
      browserProbe: { exists: () => false },
    });
    const status = await setup.status();
    const by = Object.fromEntries(status.checks.map((c) => [c.id, c]));
    expect(by.claude).toMatchObject({ state: "warning", loggedIn: true, version: "2.1.318" });
    // Sign in runs the copy that was found, by its full path.
    expect(by.claude?.fix?.command).toBe("/bin/claude auth login");
    expect(by.codex).toMatchObject({ state: "missing", installed: true, loggedIn: false });
    expect(by.gh).toMatchObject({ state: "missing", installed: false });
    expect(by.git).toMatchObject({ state: "ok", account: "Ada <ada@example.com>" });
    expect(by.node).toMatchObject({ state: "ok", version: "24.16.0" });
    expect(by.browser?.state).toBe("warning");
    expect(status.ready).toBe(true);
    expect(status.warnings.map((w) => w.id)).toContain("claude");
    expect(status.setupCompleted).toBe(false);
  });

  it("caches results and re-checks on refresh", async () => {
    const calls: string[] = [];
    const setup = service(happy, { calls });
    await setup.status();
    const first = calls.length;
    await setup.status();
    expect(calls.length).toBe(first);
    await setup.status({ refresh: true });
    expect(calls.length).toBe(first * 2);
  });

  it("reports every completed check, but not cached results", async () => {
    const checked: string[] = [];
    const setup = service(happy, {
      onChecked: (status) => {
        checked.push(status.checkedAt);
        throw new Error("a failing listener does not fail the check");
      },
    });
    await setup.status();
    await setup.status();
    expect(checked).toHaveLength(1);
    await expect(setup.status({ refresh: true })).resolves.toMatchObject({ ready: true });
    expect(checked).toHaveLength(2);
  });

  it("times out slow checks instead of hanging", async () => {
    const slow: Exec = (command, args) =>
      basename(command) === "claude" ? new Promise(() => {}) : fakeExec(happy)(command, args);
    const setup = service(happy, { exec: slow, checkTimeoutMs: 50 });
    const status = await setup.status();
    expect(status.checks.find((c) => c.id === "claude")).toMatchObject({ state: "error" });
    expect(status.ready).toBe(false);
  });

  it("checks OpenCode: version, providers, the free tier and OpenCode 1", async () => {
    const run = async (extra: Record<string, Partial<ExecResult>>) => {
      const calls: string[] = [];
      const status = await service({ ...extra }, { calls }).status();
      return { status, check: status.checks.find((c) => c.id === "opencode"), calls };
    };
    const connected = await run({
      "opencode --version": { stdout: "opencode v2.2.7" },
      "opencode auth list --standalone --format json": {
        stdout: JSON.stringify([
          { id: "openai", name: "OpenAI", connections: [{ type: "oauth", label: "OAuth" }] },
        ]),
      },
    });
    expect(connected.check).toMatchObject({
      label: "OpenCode",
      state: "ok",
      installed: true,
      version: "2.2.7",
      loggedIn: true,
      authMethod: "oauth",
      account: "OpenAI",
    });
    // Ready with only OpenCode signed in; detection never uses the user's background service.
    expect(connected.status.ready).toBe(true);
    expect(connected.calls).toContain("opencode auth list --standalone --format json");

    const free = await run({
      "opencode --version": { stdout: "opencode v2.2.7" },
      "opencode auth list --standalone --format json": { stdout: "[]" },
    });
    expect(free.check).toMatchObject({ state: "warning", loggedIn: true, authMethod: "free" });
    // Sign in runs the copy that was found, by its full path.
    expect(free.check?.fix?.command).toBe("/bin/opencode auth login");

    const v1 = await run({ "opencode --version": { stdout: "1.19.5" } });
    expect(v1.check).toMatchObject({ state: "missing", installed: true, version: "1.19.5" });
    expect(v1.check?.fix?.command).toBe("npm install -g @opencode/cli");

    const missing = await run({});
    expect(missing.check).toMatchObject({ state: "missing", installed: false });
    expect(missing.check?.fix?.command).toBe("npm install -g @opencode/cli");
  });

  it("persists completion in settings and hands out login commands", () => {
    const setup = service({});
    setup.complete();
    expect(new SettingsStore(join(dir, "settings.json")).get().setup.completed).toBe(true);
    // Before a check found gh, the bare command is all there is.
    expect(setup.loginCommand("gh")).toMatchObject({
      command: "gh auth login --web --git-protocol https",
    });
    expect(setup.loginCommand("opencode")).toEqual({
      tool: "opencode",
      command: "opencode auth login",
      args: ["auth", "login"],
    });
  });
});

const BROKEN_SHIM = "C:\\Users\\Ada\\AppData\\Roaming\\npm\\claude.cmd";

describe("installed but broken, and the resolved sign-in command", () => {
  it("reports a broken install with its paths instead of a login error", async () => {
    const broken: ExecutableLookup = {
      version: null,
      broken: [
        {
          path: BROKEN_SHIM,
          reason: "points at a missing package",
          target:
            "C:\\Users\\Ada\\AppData\\Roaming\\npm\\node_modules\\@anthropic-ai\\claude-code\\cli.js",
        },
        { path: BROKEN_SHIM.replace(".cmd", ".ps1"), reason: "points at a missing package" },
      ],
    };
    const calls: string[] = [];
    const setup = service(happy, { calls, locate: fakeLocate(happy, { claude: broken }) });
    const claude = (await setup.status()).checks.find((c) => c.id === "claude");
    expect(claude).toMatchObject({ state: "missing", installed: false, loggedIn: null });
    expect(claude?.message).toBe(
      `Claude Code is installed but broken: \`${BROKEN_SHIM}\` points at a missing package (and 1 more). Reinstall it, or remove the leftover shim.`,
    );
    expect(claude?.broken).toHaveLength(2);
    expect(claude?.fix?.kind).toBe("install");
    // A broken copy is never asked for its login state.
    expect(calls.some((c) => c.startsWith("claude auth"))).toBe(false);
  });

  it("keeps not installed for a tool that is nowhere", async () => {
    const setup = service({ ...happy, "claude --version": { code: 1 } });
    const claude = (await setup.status()).checks.find((c) => c.id === "claude");
    expect(claude).toMatchObject({ state: "missing", message: "Claude Code is not installed" });
    expect(claude?.broken).toBeUndefined();
  });

  it("explains an unreadable login state with the underlying error", async () => {
    const setup = service({
      ...happy,
      "claude auth status": { code: 1, stderr: "Error: config is corrupt" },
    });
    const claude = (await setup.status()).checks.find((c) => c.id === "claude");
    expect(claude).toMatchObject({
      state: "warning",
      installed: true,
      message: "Could not read the Claude login state",
    });
    expect(claude?.detail).toContain("exited with code 1");
    expect(claude?.detail).toContain("Error: config is corrupt");
  });

  it("signs in with the resolved copy, quoted for the terminal's shell", async () => {
    const native = "C:\\Users\\Ada Lovelace\\.local\\bin\\claude.exe";
    const found: ExecutableLookup = {
      command: { kind: "native", path: native },
      version: "2.1.319",
      broken: [{ path: BROKEN_SHIM, reason: "points at a missing package" }],
    };
    const setup = service(happy, {
      locate: fakeLocate(happy, { claude: found }),
      shell: "powershell.exe",
    });
    const claude = (await setup.status()).checks.find((c) => c.id === "claude");
    // The working native copy wins over the broken shim, which is still reported.
    expect(claude).toMatchObject({ installed: true, version: "2.1.319", executablePath: native });
    expect(claude?.broken).toHaveLength(1);
    expect(claude?.fix?.command).toBe(`& '${native}' auth login`);
    expect(setup.loginCommand("claude")).toEqual({
      tool: "claude",
      command: `& '${native}' auth login`,
      args: ["auth", "login"],
    });
    expect(setup.loginCommand("codex").command).toBe("& '/bin/codex' login");
  });

  it("looks tools up through an injected exec, so fake CLIs never reach real ones", async () => {
    const calls: string[] = [];
    const locate = execLocate(fakeExec(happy, calls));
    expect(await locate("claude")).toEqual({
      command: { kind: "native", path: "/bin/claude" },
      version: "2.1.318",
      broken: [],
    });
    expect(await locate("gh")).toEqual({ version: null, broken: [] });
    expect(calls).toEqual(["claude --version", "gh --version"]);
  });

  it("picks up a PATH change on re-check, without a restart", async () => {
    let path = ["/usr/bin"];
    const refreshPath = vi.fn(async () => {
      path = ["/usr/bin", "/home/ada/.local/bin"];
    });
    const locate = async (name: string): Promise<ExecutableLookup> =>
      name === "claude" && path.includes("/home/ada/.local/bin")
        ? {
            command: { kind: "native", path: "/home/ada/.local/bin/claude" },
            version: "2.1.319",
            broken: [],
          }
        : fakeLocate({})(name);
    const setup = service(happy, { locate, refreshPath });
    expect((await setup.status()).checks.find((c) => c.id === "claude")?.installed).toBe(false);
    // A plain (cached or first) status leaves PATH alone; a re-check refreshes it first.
    expect(refreshPath).not.toHaveBeenCalled();
    const after = await setup.status({ refresh: true });
    expect(refreshPath).toHaveBeenCalledTimes(1);
    expect(after.checks.find((c) => c.id === "claude")).toMatchObject({
      installed: true,
      executablePath: "/home/ada/.local/bin/claude",
    });
  });
});

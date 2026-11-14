import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AcpAgentSpec } from "../src/acp/extensions";
import { startAgent } from "../src/acp/process";
import { claudeEnv } from "../src/claude/options";
import { startAppServer } from "../src/codex/process";
import { CURSOR_AGENT } from "../src/cursor/adapter";
import { GEMINI_AGENT } from "../src/gemini/adapter";
import { openCodeServerEnv } from "../src/opencode/server";
import { builtinProviders } from "../src/registry";
import { agentEnv } from "../src/util/agent-env";
import type { ResolvedCommand } from "../src/util/exec";

/**
 * CodeDen's own variables, as the runner process has them in the desktop app: the server sets
 * `CODEDEN_HOME` for the runner and the desktop host sets `CODEDEN_DEPS_INSTALLER`. The token
 * stands for any credential a future `CODEDEN_*` variable might carry.
 */
const INTERNAL = {
  CODEDEN_HOME: join(tmpdir(), "real-codeden-home"),
  CODEDEN_DEPS_INSTALLER: "registry",
  CODEDEN_INSTALL_TOKEN: "secret",
};
/**
 * What CodeDen passes a session on purpose (`SessionOptions.env`): it always gets through and
 * wins over the runner's environment. The runner puts `CI` here (`agentSessionOptions`).
 */
const SESSION_EXTRAS = { CODEDEN_SESSION_EXTRA: "given", CI: "true" };

const saved = new Map<string, string | undefined>();
const setEnv = (vars: Record<string, string>) => {
  for (const [key, value] of Object.entries(vars)) {
    if (!saved.has(key)) saved.set(key, process.env[key]);
    process.env[key] = value;
  }
};

beforeEach(() => setEnv({ ...INTERNAL, USER_OWN_VAR: "kept", CI: "from-runner" }));
afterEach(() => {
  for (const [key, value] of saved) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  saved.clear();
});

/** The variables whose values the checks read; every other value stays out of the dump. */
const SHOWN = ["USER_OWN_VAR", "CODEDEN_SESSION_EXTRA", "CI"];

/**
 * A script that writes its environment to a file and exits, and how to read what it wrote. It
 * writes every variable's name but only the `SHOWN` values, so the machine's real secrets
 * never land on disk, and reading removes the folder.
 */
function envDumpScript(): { exe: ResolvedCommand; read: () => Record<string, string> } {
  const dir = mkdtempSync(join(tmpdir(), "codeden-agent-env-"));
  const out = join(dir, "env.json");
  const script = join(dir, "dump-env.mjs");
  writeFileSync(
    script,
    [
      `import { writeFileSync } from "node:fs";`,
      `const shown = new Set(${JSON.stringify(SHOWN)});`,
      `const env = {};`,
      `for (const key of Object.keys(process.env)) env[key] = shown.has(key) ? process.env[key] : "<set>";`,
      `writeFileSync(${JSON.stringify(out)}, JSON.stringify(env));`,
    ].join("\n"),
  );
  return {
    exe: { kind: "node-script", path: process.execPath, script },
    read: () => {
      try {
        return JSON.parse(readFileSync(out, "utf8")) as Record<string, string>;
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
  };
}

const handlers = { onNotification: () => {}, onRequest: async () => null, onExit: () => {} };

/** Spawn Codex's app server as the env-dump script; the handshake fails when it exits. */
async function codexAppServerEnv(): Promise<Record<string, string>> {
  const { exe, read } = envDumpScript();
  await expect(startAppServer(exe, handlers, { env: SESSION_EXTRAS })).rejects.toThrow(/exited/);
  return read();
}

/** Spawn an ACP agent with its real spec (arguments, login method) as the env-dump script. */
async function acpAgentEnv(spec: AcpAgentSpec): Promise<Record<string, string>> {
  const { exe, read } = envDumpScript();
  await expect(
    startAgent(exe, handlers, {
      args: spec.args,
      label: spec.label,
      ...(spec.authMethod ? { authMethod: spec.authMethod } : {}),
      env: SESSION_EXTRAS,
    }),
  ).rejects.toThrow(/exited/);
  return read();
}

/**
 * The environment each built-in provider starts its agent with, keyed by provider id. Every
 * provider must have an entry (checked below), so a new one can't skip the filter.
 */
type Env = Record<string, string | undefined>;
const SPAWN_ENV: Record<string, () => Env | Promise<Env>> = {
  claude: () => claudeEnv(SESSION_EXTRAS),
  codex: codexAppServerEnv,
  opencode: () => openCodeServerEnv(process.env, SESSION_EXTRAS, "pw", {}),
  cursor: () => acpAgentEnv(CURSOR_AGENT),
  gemini: () => acpAgentEnv(GEMINI_AGENT),
};

describe("agent session environment", () => {
  it("drops every inherited CODEDEN_* variable and Electron's runtime switch, in any case", () => {
    const base = {
      PATH: "/bin",
      CODEDEN_HOME: "/home/me/.codeden",
      CODEDEN_DEPS_INSTALLER: "registry",
      CODEDEN_INSTALL_TOKEN: "secret",
      codeden_debug: "1",
      ELECTRON_RUN_AS_NODE: "1",
      NOT_CODEDEN_HOME: "kept",
      EMPTY: undefined,
    };
    expect(agentEnv({}, base)).toEqual({ PATH: "/bin", NOT_CODEDEN_HOME: "kept" });
    expect(agentEnv({ CODEDEN_SESSION_EXTRA: "given", PATH: "/usr/bin" }, base)).toEqual({
      PATH: "/usr/bin",
      NOT_CODEDEN_HOME: "kept",
      CODEDEN_SESSION_EXTRA: "given",
    });
  });

  it("covers every built-in provider", () => {
    expect(Object.keys(SPAWN_ENV).sort()).toEqual(
      builtinProviders()
        .map((p) => p.id)
        .sort(),
    );
  });

  it.each(Object.keys(SPAWN_ENV))(
    "%s: the agent starts without CodeDen's internal variables",
    async (id) => {
      const env = await SPAWN_ENV[id]?.();
      // The user's variables and the session's extras are there, the extras on top.
      expect(env?.USER_OWN_VAR).toBe("kept");
      expect(env?.CODEDEN_SESSION_EXTRA).toBe("given");
      expect(env?.CI).toBe("true");
      for (const key of Object.keys(INTERNAL)) expect(env).not.toHaveProperty(key);
    },
  );
});

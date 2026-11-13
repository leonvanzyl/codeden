import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { claudeEnv } from "../src/claude/options";
import { startAppServer } from "../src/codex/process";
import { openCodeServerEnv } from "../src/opencode/server";
import { agentEnv } from "../src/util/agent-env";

/**
 * CodeDen's own variables, as the runner process has them in the desktop app: the server sets
 * `CODEDEN_HOME` for the runner and the desktop host sets `CODEDEN_DEPS_INSTALLER`.
 */
const INTERNAL = {
  CODEDEN_HOME: join(tmpdir(), "real-codeden-home"),
  CODEDEN_DEPS_INSTALLER: "registry",
};
/** What CodeDen passes a session on purpose (`SessionOptions.env`): it always gets through. */
const SESSION_EXTRAS = { CODEDEN_SESSION_EXTRA: "given" };

const saved = new Map<string, string | undefined>();
const setEnv = (vars: Record<string, string>) => {
  for (const [key, value] of Object.entries(vars)) {
    if (!saved.has(key)) saved.set(key, process.env[key]);
    process.env[key] = value;
  }
};

beforeEach(() => setEnv({ ...INTERNAL, USER_OWN_VAR: "kept" }));
afterEach(() => {
  for (const [key, value] of saved) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  saved.clear();
});

/** The user's variables and the session's extras are there; CodeDen's own are not. */
function expectAgentEnv(env: Record<string, string | undefined>) {
  expect(env.USER_OWN_VAR).toBe("kept");
  expect(env.CODEDEN_SESSION_EXTRA).toBe("given");
  expect(env).not.toHaveProperty("CODEDEN_HOME");
  expect(env).not.toHaveProperty("CODEDEN_DEPS_INSTALLER");
}

/** Spawn Codex's app server as a script that writes its environment to a file and exits. */
async function codexAppServerEnv(): Promise<Record<string, string>> {
  const dir = mkdtempSync(join(tmpdir(), "codeden-agent-env-"));
  const out = join(dir, "env.json");
  const script = join(dir, "dump-env.mjs");
  writeFileSync(
    script,
    `import { writeFileSync } from "node:fs";\nwriteFileSync(${JSON.stringify(out)}, JSON.stringify(process.env));\n`,
  );
  const handlers = { onNotification: () => {}, onRequest: async () => null, onExit: () => {} };
  await expect(
    startAppServer({ kind: "node-script", path: process.execPath, script }, handlers, {
      env: SESSION_EXTRAS,
    }),
  ).rejects.toThrow(/exited/);
  return JSON.parse(readFileSync(out, "utf8")) as Record<string, string>;
}

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

  it("Claude: leaves out CodeDen's internal variables the runner has", () => {
    const env = claudeEnv(SESSION_EXTRAS);
    expectAgentEnv(env);
    expect(env.CLAUDE_AGENT_SDK_CLIENT_APP).toMatch(/^codeden\//);
  });

  it("OpenCode: leaves out CodeDen's internal variables the runner has", () => {
    expectAgentEnv(openCodeServerEnv(process.env, SESSION_EXTRAS, "pw", {}));
  });

  it("Codex: the app server starts without CodeDen's internal variables", async () => {
    expectAgentEnv(await codexAppServerEnv());
  });
});

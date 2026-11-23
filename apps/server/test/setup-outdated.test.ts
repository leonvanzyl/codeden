import { CLAUDE_MIN_VERSION, CODEX_MIN_VERSION } from "@codeden/providers";
import { describe, expect, it } from "vitest";
import type { Exec } from "../src/services/exec";
import { type CheckEnv, checkClaude, checkCodex } from "../src/services/setup/checks";
import type { Locate } from "../src/services/setup/tool-lookup";

/** A check environment whose look-up finds `version` at `file` and records what was run. */
function env(file: string, version: string): CheckEnv & { ran: string[]; asked: unknown[] } {
  const ran: string[] = [];
  const asked: unknown[] = [];
  const exec: Exec = async (command, args) => {
    ran.push([command, ...args].join(" "));
    // What an old copy answers: nothing usable, after a long wait.
    return { code: null, stdout: "", stderr: "", notFound: false, timedOut: true, path: command };
  };
  const locate: Locate = async (_name, opts) => {
    asked.push(opts);
    return { command: { kind: "native", path: file }, version, broken: [] };
  };
  return {
    exec,
    locate,
    shell: "/bin/bash",
    platform: "darwin",
    nodeVersion: "v24.0.0",
    now: 0,
    ran,
    asked,
  };
}

describe("setup checks on a copy older than the provider's minimum", () => {
  it("claude: says the version is too old, names the file and never asks for the login", async () => {
    const e = env("/usr/local/bin/claude", "2.0.8");
    const check = await checkClaude(e);
    expect(e.asked).toEqual([{ minVersion: CLAUDE_MIN_VERSION }]);
    expect(check).toMatchObject({
      state: "warning",
      installed: true,
      version: "2.0.8",
      executablePath: "/usr/local/bin/claude",
      loggedIn: null,
      message: `Claude Code 2.0.8 is older than ${CLAUDE_MIN_VERSION}; update it`,
      fix: { kind: "upgrade", command: "claude update" },
    });
    expect(check.detail).toContain("`/usr/local/bin/claude`");
    expect(e.ran).toEqual([]);
  });

  it("codex: the same, instead of 'Not signed in to Codex'", async () => {
    const e = env("/usr/local/bin/codex", "0.42.0");
    const check = await checkCodex(e);
    expect(e.asked).toEqual([{ minVersion: CODEX_MIN_VERSION }]);
    expect(check).toMatchObject({
      state: "warning",
      loggedIn: null,
      message: `Codex 0.42.0 is older than ${CODEX_MIN_VERSION}; update it`,
      fix: { kind: "upgrade" },
    });
    expect(check.detail).toContain("`/usr/local/bin/codex`");
    expect(e.ran).toEqual([]);
  });

  it("a supported copy is still asked for its login", async () => {
    const e = env("/home/ada/.local/bin/claude", CLAUDE_MIN_VERSION);
    const check = await checkClaude(e);
    expect(e.ran).toEqual(["/home/ada/.local/bin/claude auth status"]);
    expect(check.message).toBe("Could not read the Claude login state");
  });
});

import { chmodSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CLAUDE_MIN_VERSION, detectClaude } from "../src/claude/detect";
import { CODEX_MIN_VERSION, detectCodex } from "../src/codex/detect";
import {
  clearExecutableCache,
  findExecutable,
  type LocateOptions,
  quickLocate,
  type Validation,
} from "../src/util/locate";

const win = process.platform === "win32";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "cd-locate-min-"));
  clearExecutableCache();
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

/** A tool that prints `output` whatever it is asked, runnable on this OS. */
function fakeTool(folder: string, name: string, output: string): string {
  mkdirSync(folder, { recursive: true });
  if (win) {
    const file = path.join(folder, `${name}.cmd`);
    writeFileSync(file, `@echo off\r\necho ${output}\r\nexit /b 0\r\n`);
    return file;
  }
  const file = path.join(folder, name);
  writeFileSync(file, `#!/bin/sh\necho '${output}'\nexit 0\n`);
  chmodSync(file, 0o755);
  return file;
}

/** `pathDirs` are folders on PATH; `known` are the files of the known install locations. */
const opts = (pathDirs: string[], known: string[] = [], minVersion?: string): LocateOptions => ({
  pathEnv: pathDirs.join(path.delimiter),
  pathExt: ".EXE;.CMD;.BAT",
  knownLocations: known,
  timeoutMs: 15_000,
  ...(minVersion ? { minVersion } : {}),
});

describe("findExecutable with a minimum version", () => {
  it("passes over an old copy on PATH for a supported one in a known location", async () => {
    const old = fakeTool(path.join(dir, "usr-local-bin"), "claude", "2.0.8 (Claude Code)");
    const current = fakeTool(path.join(dir, "local-bin"), "claude", "2.1.327 (Claude Code)");
    const o = opts([path.dirname(old)], [current], "2.1.250");
    // Before anything was checked, the synchronous look-up can only take PATH order.
    expect(quickLocate("claude", o)?.path).toBe(old);
    const found = await findExecutable("claude", o);
    expect(found.command?.path).toBe(current);
    expect(found.version).toBe("2.1.327");
    // The old copy runs: it is not reported as broken.
    expect(found.broken).toEqual([]);
    // Sessions start the copy detection chose, not the first one on PATH.
    expect(quickLocate("claude", o)?.path).toBe(current);
  });

  it("takes the first supported copy, not the newest", async () => {
    const old = fakeTool(path.join(dir, "a"), "codex", "codex-cli 0.42.0");
    const first = fakeTool(path.join(dir, "b"), "codex", "codex-cli 0.160.0");
    const newest = fakeTool(path.join(dir, "c"), "codex", "codex-cli 0.170.0");
    const found = await findExecutable(
      "codex",
      opts(
        [old, first, newest].map((f) => path.dirname(f)),
        [],
        "0.160.0",
      ),
    );
    expect(found.command?.path).toBe(first);
  });

  it("falls back to the first old copy when nothing meets the minimum", async () => {
    const older = fakeTool(path.join(dir, "a"), "claude", "2.0.8 (Claude Code)");
    const old = fakeTool(path.join(dir, "b"), "claude", "2.1.100 (Claude Code)");
    const o = opts([path.dirname(older)], [old], "2.1.250");
    const found = await findExecutable("claude", o);
    expect(found.command?.path).toBe(older);
    expect(found.version).toBe("2.0.8");
    expect(found.broken).toEqual([]);
    expect(quickLocate("claude", o)?.path).toBe(older);
  });

  it("finds nothing when there is no copy, and keeps PATH order without a minimum", async () => {
    expect(await findExecutable("claude", opts([path.join(dir, "empty")], [], "2.1.250"))).toEqual({
      version: null,
      broken: [],
    });
    const old = fakeTool(path.join(dir, "a"), "claude", "2.0.8 (Claude Code)");
    const current = fakeTool(path.join(dir, "b"), "claude", "2.1.327 (Claude Code)");
    const found = await findExecutable("claude", opts([path.dirname(old)], [current]));
    expect(found.command?.path).toBe(old);
  });

  it("treats a copy with no known version as older than the minimum", async () => {
    const unknown = fakeTool(path.join(dir, "a"), "claude", "x");
    const current = fakeTool(path.join(dir, "b"), "claude", "y");
    const validate = vi.fn(
      async (command: { path: string }): Promise<Validation> => ({
        ok: true,
        version: command.path === current ? "2.1.327" : null,
      }),
    );
    const o = { ...opts([path.dirname(unknown)], [current], "2.1.250"), validate };
    expect((await findExecutable("claude", o)).command?.path).toBe(current);
  });

  it("goes back to the old copy when the newer one is gone, and forward once it is updated", async () => {
    const old = fakeTool(path.join(dir, "a"), "claude", "2.0.8 (Claude Code)");
    const current = fakeTool(path.join(dir, "b"), "claude", "2.1.327 (Claude Code)");
    const o = opts([path.dirname(old)], [current], "2.1.250");
    await findExecutable("claude", o);
    rmSync(current);
    // Still the only copy there is, even before the next check.
    expect(quickLocate("claude", o)?.path).toBe(old);
    expect((await findExecutable("claude", o)).command?.path).toBe(old);
    // Updated in place: a changed file is checked again.
    fakeTool(path.dirname(old), "claude", "2.1.400 (Claude Code)");
    utimesSync(old, new Date(), new Date(Date.now() + 5_000));
    const found = await findExecutable("claude", o);
    expect(found).toMatchObject({ command: { path: old }, version: "2.1.400" });
  });
});

describe("detection with an old copy first on PATH", () => {
  it("claude: uses the supported copy and reports no version problem", async () => {
    const old = fakeTool(path.join(dir, "usr-local-bin"), "claude", "2.0.8 (Claude Code)");
    const current = fakeTool(path.join(dir, "local-bin"), "claude", "2.1.327 (Claude Code)");
    const status = await detectClaude({ locate: opts([path.dirname(old)], [current]) });
    expect(status).toMatchObject({
      installed: true,
      version: "2.1.327",
      executablePath: current,
      supported: true,
    });
    expect(status.issues.map((i) => i.code)).not.toContain("version_unsupported");
  });

  it("claude: only an old copy leads with the version and its path, and skips the login check", async () => {
    const old = fakeTool(path.join(dir, "usr-local-bin"), "claude", "2.0.8 (Claude Code)");
    const status = await detectClaude({ locate: opts([path.dirname(old)]) });
    expect(status).toMatchObject({
      installed: true,
      version: "2.0.8",
      executablePath: old,
      supported: false,
      loggedIn: null,
    });
    // `auth status` would print "2.0.8 (Claude Code)" here and read as a failed login check.
    expect(status.issues.map((i) => i.code)).toEqual(["version_unsupported"]);
    expect(status.issues[0]?.message).toBe(
      `Claude Code 2.0.8 (\`${old}\`) is older than the tested minimum ${CLAUDE_MIN_VERSION}.`,
    );
    expect(status.issues[0]?.fix?.kind).toBe("upgrade");
  });

  it("codex: the same, with its own minimum", async () => {
    const old = fakeTool(path.join(dir, "usr-local-bin"), "codex", "codex-cli 0.42.0");
    const current = fakeTool(path.join(dir, "local-bin"), "codex", "codex-cli 0.170.0");
    const both = await detectCodex({ locate: opts([path.dirname(old)], [current]) });
    expect(both).toMatchObject({ version: "0.170.0", executablePath: current, supported: true });

    clearExecutableCache();
    const only = await detectCodex({ locate: opts([path.dirname(old)]) });
    expect(only).toMatchObject({ version: "0.42.0", executablePath: old, supported: false });
    expect(only.loggedIn).toBeNull();
    expect(only.issues.map((i) => i.code)).toEqual(["version_unsupported"]);
    expect(only.issues[0]?.message).toContain(`\`${old}\``);
    expect(only.issues[0]?.message).toContain(CODEX_MIN_VERSION);
  });

  it("no copy at all is still 'not installed'", async () => {
    const status = await detectClaude({ locate: opts([path.join(dir, "empty")]) });
    expect(status.installed).toBe(false);
    expect(status.issues.map((i) => i.code)).toEqual(["not_installed"]);
  });
});

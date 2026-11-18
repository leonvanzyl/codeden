import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { detectClaude } from "../src/claude/detect";
import { brokenInstallMessage } from "../src/util/detect-exe";
import { knownLocations } from "../src/util/known-locations";
import {
  clearExecutableCache,
  findExecutable,
  type LocateOptions,
  quickLocate,
  type Validation,
} from "../src/util/locate";
import { shimTarget } from "../src/util/shim";
import { refreshProcessPath } from "../src/util/system-path";

const win = process.platform === "win32";

/** An npm `.cmd` shim for a package script (as npm writes it). */
const npmCmdShim = (rel: string) => `@ECHO off
GOTO start
:find_dp0
SET dp0=%~dp0
EXIT /b
:start
SETLOCAL
CALL :find_dp0

IF EXIST "%dp0%\\node.exe" (
  SET "_prog=%dp0%\\node.exe"
) ELSE (
  SET "_prog=node"
  SET PATHEXT=%PATHEXT:;.JS;=;%
)

endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\${rel}" %*
`;

/** The `.ps1` shim npm writes next to it. */
const npmPs1Shim = (rel: string) => `#!/usr/bin/env pwsh
$basedir=Split-Path $MyInvocation.MyCommand.Definition -Parent

$exe=""
if ($PSVersionTable.PSVersion -lt "6.0" -or $IsWindows) {
  $exe=".exe"
}
$ret=0
if (Test-Path "$basedir/node$exe") {
  & "$basedir/node$exe"  "$basedir/${rel}" $args
  $ret=$LASTEXITCODE
} else {
  & "node$exe"  "$basedir/${rel}" $args
  $ret=$LASTEXITCODE
}
exit $ret
`;

const CLAUDE_JS = "node_modules/@anthropic-ai/claude-code/cli.js";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "cd-locate-"));
  clearExecutableCache();
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

/** A tool that prints `output` and exits with `code`, runnable on this OS. */
function fakeTool(folder: string, name: string, output: string, code = 0): string {
  mkdirSync(folder, { recursive: true });
  if (win) {
    const file = path.join(folder, `${name}.cmd`);
    writeFileSync(file, `@echo off\r\n${output ? `echo ${output}\r\n` : ""}exit /b ${code}\r\n`);
    return file;
  }
  const file = path.join(folder, name);
  writeFileSync(file, `#!/bin/sh\n${output ? `echo '${output}'\n` : ""}exit ${code}\n`);
  chmodSync(file, 0o755);
  return file;
}

/** A leftover install on PATH: npm shims (Windows) or a dangling link (elsewhere). */
function brokenInstall(folder: string, name: string): string[] {
  mkdirSync(folder, { recursive: true });
  if (win) {
    const cmd = path.join(folder, `${name}.cmd`);
    const ps1 = path.join(folder, `${name}.ps1`);
    writeFileSync(cmd, npmCmdShim(CLAUDE_JS.replace(/\//g, "\\")));
    writeFileSync(ps1, npmPs1Shim(CLAUDE_JS));
    return [cmd, ps1];
  }
  const link = path.join(folder, name);
  symlinkSync(path.join("..", "lib", CLAUDE_JS), link);
  return [link];
}

const opts = (pathDirs: string[], known: string[] = []): LocateOptions => ({
  pathEnv: pathDirs.join(path.delimiter),
  pathExt: ".EXE;.CMD;.BAT",
  knownLocations: known,
  timeoutMs: 15_000,
});

describe("findExecutable", () => {
  it("skips a broken shim on PATH for a working native install off PATH", async () => {
    const npm = path.join(dir, "npm");
    const shims = brokenInstall(npm, "claude");
    const native = fakeTool(
      path.join(dir, "home", ".local", "bin"),
      "claude",
      "2.1.319 (Claude Code)",
    );
    const found = await findExecutable("claude", opts([npm], [native]));
    expect(found.command?.path).toBe(native);
    expect(found.version).toBe("2.1.319");
    expect(found.broken.map((b) => b.path)).toEqual(shims);
    expect(found.broken[0]?.reason).toMatch(/points at a missing (package|file)/);
    // The quick, synchronous look-up skips the broken shims too.
    expect(quickLocate("claude", opts([npm], [native]))?.path).toBe(native);
  });

  it("reports only broken copies when nothing runs", async () => {
    const npm = path.join(dir, "npm");
    const shims = brokenInstall(npm, "claude");
    const found = await findExecutable("claude", opts([npm]));
    expect(found.command).toBeUndefined();
    expect(found.broken.map((b) => b.path)).toEqual(shims);
    expect(found.broken[0]?.target).toContain(path.join("@anthropic-ai", "claude-code"));
    expect(brokenInstallMessage("Claude Code", found.broken)).toMatch(
      /^Claude Code is installed but broken: `.+` points at a missing (package|file).*\. Reinstall it, or remove the leftover shim\.$/,
    );
  });

  it("treats a copy that prints no version, or fails, as broken", async () => {
    const silent = fakeTool(path.join(dir, "a"), "claude", "");
    const failing = fakeTool(path.join(dir, "b"), "claude", "boom", 3);
    const empty = path.join(dir, "c", win ? "claude.cmd" : "claude");
    mkdirSync(path.dirname(empty));
    writeFileSync(empty, "");
    if (!win) chmodSync(empty, 0o755);
    const found = await findExecutable(
      "claude",
      opts([path.dirname(silent), path.dirname(failing), path.dirname(empty)]),
    );
    expect(found.command).toBeUndefined();
    expect(found.broken).toEqual([
      { path: silent, reason: "printed no version for `--version`" },
      { path: failing, reason: "exited with code 3 on `--version` (boom)" },
      { path: empty, reason: "is empty" },
    ]);
  });

  it("finds nothing when the tool is nowhere", async () => {
    expect(await findExecutable("claude", opts([path.join(dir, "empty")]))).toEqual({
      version: null,
      broken: [],
    });
  });

  it("caches --version per file and modification time", async () => {
    const tool = fakeTool(path.join(dir, "bin"), "claude", "2.1.319");
    const validate = vi.fn(async (): Promise<Validation> => ({ ok: true, version: "2.1.319" }));
    const o = { ...opts([path.dirname(tool)]), validate };
    await findExecutable("claude", o);
    await findExecutable("claude", o);
    expect(validate).toHaveBeenCalledTimes(1);
    // A reinstall changes the file: it is checked again.
    utimesSync(tool, new Date(), new Date(Date.now() + 60_000));
    await findExecutable("claude", o);
    expect(validate).toHaveBeenCalledTimes(2);
  });

  it("lets the quick look-up skip a copy whose --version failed, until it changes", async () => {
    const silent = fakeTool(path.join(dir, "a"), "claude", "");
    const good = fakeTool(path.join(dir, "b"), "claude", "2.1.319");
    const o = opts([path.dirname(silent), path.dirname(good)]);
    // Before any check, the first plausible copy is all the quick look-up knows.
    expect(quickLocate("claude", o)?.path).toBe(silent);
    expect((await findExecutable("claude", o)).command?.path).toBe(good);
    expect(quickLocate("claude", o)?.path).toBe(good);
    // A reinstall (a changed file) makes it a candidate again.
    utimesSync(silent, new Date(), new Date(Date.now() + 60_000));
    expect(quickLocate("claude", o)?.path).toBe(silent);
  });

  it("does not cache a timeout", async () => {
    const tool = fakeTool(path.join(dir, "bin"), "claude", "2.1.319");
    const validate = vi.fn(
      async (): Promise<Validation> => ({ ok: false, reason: "timed out", retry: true }),
    );
    const o = { ...opts([path.dirname(tool)]), validate };
    await findExecutable("claude", o);
    await findExecutable("claude", o);
    expect(validate).toHaveBeenCalledTimes(2);
  });

  it("detects Claude Code from a native install off PATH", async () => {
    const npm = path.join(dir, "npm");
    brokenInstall(npm, "claude");
    const native = fakeTool(path.join(dir, "native"), "claude", "2.1.319 (Claude Code)");
    const status = await detectClaude({ locate: opts([npm], [native]) });
    expect(status.installed).toBe(true);
    expect(status.version).toBe("2.1.319");
    expect(status.broken?.length).toBeGreaterThan(0);
    const broken = await detectClaude({ locate: opts([npm]) });
    expect(broken.installed).toBe(false);
    expect(broken.issues[0]?.code).toBe("broken_install");
    expect(broken.issues[0]?.message).toContain("installed but broken");
  });
});

describe("shim targets", () => {
  it("reads npm .cmd and .ps1 shims, including native package binaries", () => {
    expect(shimTarget("C:\\npm\\claude.cmd", npmCmdShim(CLAUDE_JS.replace(/\//g, "\\")))).toBe(
      "C:\\npm\\node_modules\\@anthropic-ai\\claude-code\\cli.js",
    );
    expect(shimTarget("C:\\npm\\claude.ps1", npmPs1Shim(CLAUDE_JS))).toBe(
      "C:\\npm\\node_modules\\@anthropic-ai\\claude-code\\cli.js",
    );
    const exeShim = '@ECHO off\r\n"%dp0%\\node_modules\\@x\\tool\\bin\\tool.exe"   %*\r\n';
    expect(shimTarget("C:\\npm\\tool.cmd", exeShim)).toBe(
      "C:\\npm\\node_modules\\@x\\tool\\bin\\tool.exe",
    );
    expect(shimTarget("C:\\x\\a.cmd", "@echo off\r\nfoo.exe %*")).toBeUndefined();
  });
});

describe("known install locations", () => {
  it("lists the native installers' folders per OS", () => {
    expect(knownLocations("claude", { platform: "win32", home: "C:\\Users\\Ada" })).toEqual([
      "C:\\Users\\Ada\\.local\\bin\\claude.exe",
    ]);
    expect(knownLocations("claude", { platform: "darwin", home: "/Users/ada", env: {} })).toEqual([
      "/Users/ada/.local/bin/claude",
      "/Users/ada/.claude/local/claude",
      // Then the package managers' global bin folders (an app started from the Dock).
      "/Users/ada/.bun/bin/claude",
      "/Users/ada/Library/pnpm/claude",
      "/Users/ada/.volta/bin/claude",
      "/Users/ada/.npm-global/bin/claude",
      "/opt/homebrew/bin/claude",
      "/usr/local/bin/claude",
    ]);
    expect(knownLocations("codex", { platform: "linux", home: "/home/ada", env: {} })).toEqual([
      "/home/ada/.local/bin/codex",
      "/home/ada/.codex/packages/standalone/current/bin/codex",
      "/home/ada/.codex/packages/standalone/current/codex",
      "/home/ada/.bun/bin/codex",
      "/home/ada/.local/share/pnpm/codex",
      "/home/ada/.volta/bin/codex",
      "/home/ada/.npm-global/bin/codex",
      "/home/linuxbrew/.linuxbrew/bin/codex",
      "/usr/local/bin/codex",
    ]);
    // The package managers' own variables move their folders; gh is found in `~/.local/bin` too.
    expect(
      knownLocations("gh", {
        platform: "darwin",
        home: "/Users/ada",
        env: { BUN_INSTALL: "/opt/bun", PNPM_HOME: "/p", npm_config_prefix: "/n" },
      }),
    ).toEqual([
      "/opt/homebrew/bin/gh",
      "/usr/local/bin/gh",
      "/opt/bun/bin/gh",
      "/p/gh",
      "/Users/ada/.volta/bin/gh",
      "/n/bin/gh",
      "/Users/ada/.npm-global/bin/gh",
      "/Users/ada/.local/bin/gh",
    ]);
    // Windows keeps its installers' folders only; npm's folder is on the user's Path there.
    expect(knownLocations("gh", { platform: "win32", home: "C:\\Users\\Ada", env: {} })).toEqual([
      "C:\\Program Files\\GitHub CLI\\gh.exe",
    ]);
    expect(knownLocations("codex", { platform: "win32", home: "C:\\Users\\Ada", env: {} })[0]).toBe(
      "C:\\Users\\Ada\\.codex\\packages\\standalone\\current\\bin\\codex.exe",
    );
    expect(knownLocations("git", { platform: "linux", home: "/home/ada" })).toEqual([]);
  });
});

describe("refreshProcessPath", () => {
  it("adds folders from the registry's user and machine Path, expanded", async () => {
    const env: NodeJS.ProcessEnv = {
      Path: "C:\\e2e\\bin;C:\\Windows\\System32",
      SystemRoot: "C:\\Windows",
      USERPROFILE: "C:\\Users\\Ada",
    };
    let user = "%USERPROFILE%\\AppData\\Roaming\\npm";
    const readRegistry = async (scope: "user" | "machine") =>
      scope === "machine" ? "%SystemRoot%\\system32;C:\\Program Files\\Git\\cmd" : user;
    const first = await refreshProcessPath({ platform: "win32", env, readRegistry });
    expect(first).toEqual(["C:\\Program Files\\Git\\cmd", "C:\\Users\\Ada\\AppData\\Roaming\\npm"]);
    // Existing entries keep their order (a test's own bin folder stays first).
    expect(env.Path).toBe(
      "C:\\e2e\\bin;C:\\Windows\\System32;C:\\Program Files\\Git\\cmd;C:\\Users\\Ada\\AppData\\Roaming\\npm",
    );
    // The user adds a folder later (e.g. the native installer's): the next refresh finds it.
    user = `${user};%USERPROFILE%\\.local\\bin\\`;
    expect(await refreshProcessPath({ platform: "win32", env, readRegistry })).toEqual([
      "C:\\Users\\Ada\\.local\\bin\\",
    ]);
    expect(await refreshProcessPath({ platform: "win32", env, readRegistry })).toEqual([]);
  });

  it("leaves PATH alone on macOS and Linux, and survives a registry failure", async () => {
    const env = { PATH: "/usr/bin" };
    const readRegistry = vi.fn(async () => "C:\\x");
    expect(await refreshProcessPath({ platform: "linux", env, readRegistry })).toEqual([]);
    expect(readRegistry).not.toHaveBeenCalled();
    const failing = async () => {
      throw new Error("no reg.exe");
    };
    expect(await refreshProcessPath({ platform: "win32", env, readRegistry: failing })).toEqual([]);
    expect(env.PATH).toBe("/usr/bin");
  });

  it.runIf(win)("makes a tool installed after start findable on re-check", async () => {
    const later = path.join(dir, "later");
    fakeTool(later, "claude", "2.1.319");
    const env: NodeJS.ProcessEnv = { Path: path.join(dir, "empty") };
    let user = "";
    const readRegistry = async (scope: "user" | "machine") => (scope === "user" ? user : null);
    const look = () => findExecutable("claude", { ...opts([]), pathEnv: env.Path });
    expect((await look()).command).toBeUndefined();
    user = later;
    await refreshProcessPath({ platform: "win32", env, readRegistry });
    expect((await look()).command?.path).toBe(path.join(later, "claude.cmd"));
  });
});

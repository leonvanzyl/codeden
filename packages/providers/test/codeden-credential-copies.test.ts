import { describe, expect, it } from "vitest";
import { ClaudePolicy } from "../src/claude/permissions";
import { assessClaudeTool } from "../src/claude/tools";
import { commandRisk, levelAllows } from "../src/codex/policy";
import { OpenCodePolicy, type PermissionCall } from "../src/opencode/policy";
import { classifyCommand, classifyRead, classifyWrite, type RiskContext } from "../src/policy/risk";
import { wildcardMatchesNumbered } from "../src/policy/wildcard";

/**
 * Before CodeDen resets a damaged `remote-access.json` it keeps a copy next to it,
 * `remote-access.json.invalid-<timestamp>` (#170), with the same password and session hashes.
 * The copies are guarded like the file: they ask at every level and are refused for read-only
 * sessions (§11.2).
 */
const posix: RiskContext = {
  cwd: "/home/me/.codeden/wt/repo/abc123",
  platform: "linux",
  home: "/home/me",
  tempRoots: ["/tmp"],
  codedenHome: "/home/me/.codeden",
};
const win: RiskContext = {
  cwd: "C:\\Users\\me\\.codeden\\wt\\repo\\abc123",
  platform: "win32",
  home: "C:\\Users\\me",
  tempRoots: ["C:\\Users\\me\\AppData\\Local\\Temp"],
  codedenHome: "C:\\Users\\me\\.codeden",
};
const COPY = "/home/me/.codeden/remote-access.json.invalid-1234567890";
const WIN_COPY = "C:\\Users\\me\\.codeden\\remote-access.json.invalid-1234567890";
const CREDENTIALS = { risky: true, action: "secrets", codeden: true };

const guarded = (command: string, ctx: RiskContext) => {
  const r = classifyCommand(command, ctx);
  return r.risky && r.codeden === true;
};

describe("copies of CodeDen's credential files", () => {
  it("an exact copy path, read, written or named in a command (POSIX)", () => {
    for (const file of [
      COPY,
      "~/.codeden/remote-access.json.invalid-1",
      "/home/me/.codeden/runner/runner.json.invalid-1794559031061",
      "../../../remote-access.json.invalid-42",
    ]) {
      expect(classifyRead(file, posix), file).toMatchObject(CREDENTIALS);
      expect(classifyWrite(file, posix), file).toMatchObject({ risky: true, codeden: true });
      expect(assessClaudeTool("Read", { file_path: file }, posix), file).toMatchObject(CREDENTIALS);
    }
    for (const cmd of [
      `cat ${COPY}`,
      "cat $CODEDEN_HOME/remote-access.json.invalid-1234567890",
      "cp ~/.codeden/remote-access.json.invalid-1 /tmp/x",
      `rm ${COPY}`,
      "cd ~/.codeden && cat remote-access.json.invalid-1234567890",
    ]) {
      expect(guarded(cmd, posix), cmd).toBe(true);
    }
  });

  it("an exact copy path on Windows, in any case", () => {
    for (const file of [WIN_COPY, "c:/users/me/.codeden/REMOTE-ACCESS.JSON.INVALID-1"]) {
      expect(classifyRead(file, win), file).toMatchObject(CREDENTIALS);
      expect(assessClaudeTool("Read", { file_path: file }, win), file).toMatchObject(CREDENTIALS);
    }
    for (const cmd of [
      `Get-Content -LiteralPath ${WIN_COPY}`,
      "Get-Content $env:CODEDEN_HOME\\remote-access.json.invalid-1234567890",
      "type %CODEDEN_HOME%\\remote-access.json.invalid-1",
      "Copy-Item $env:USERPROFILE\\.codeden\\remote-access.json.invalid-1 C:\\x",
    ]) {
      expect(guarded(cmd, win), cmd).toBe(true);
    }
  });

  it("a wildcard that matches a copy, in a command or Claude's Glob", () => {
    for (const cmd of [
      "cat ~/.codeden/remote-access.json.invalid-*",
      "cat ~/.codeden/*.invalid-*",
      "cat $CODEDEN_HOME/remote-access.json.*",
      "cat ~/.codeden/remote-access.json.invalid-17*",
      "cat ~/.codeden/remote-access.json.invalid-[0-9]*",
      "cat ~/.codeden/remote-access.json.invalid-$ts",
      "cat ~/.codeden/remote-*-[!a]*",
      "cat ~/.codeden/runner/*.invalid-*",
    ]) {
      expect(guarded(cmd, posix), cmd).toBe(true);
    }
    for (const cmd of [
      "Get-Content $env:CODEDEN_HOME\\remote-access.json.invalid-*",
      "Get-Content C:\\Users\\me\\.codeden\\*.INVALID-*",
    ]) {
      expect(guarded(cmd, win), cmd).toBe(true);
    }
    for (const input of [
      { path: "/home/me/.codeden", pattern: "*.invalid-*" },
      { path: "/home/me", pattern: "**/remote-access.json.invalid-*" },
      { pattern: "/home/me/.codeden/**/*.invalid-*" },
      { path: "/home/me/.codeden", pattern: "remote-access.json.invalid-1234567890" },
    ]) {
      expect(assessClaudeTool("Glob", input, posix), JSON.stringify(input)).toMatchObject({
        codeden: true,
      });
    }
    expect(
      assessClaudeTool("Glob", { path: "C:\\Users\\me", pattern: "**/*.invalid-*" }, win),
    ).toMatchObject({ codeden: true });
  });

  it("a recursive search or a listing that feeds a command, filtered to the copies", () => {
    for (const cmd of [
      "rg -g '*.invalid-*' . ~",
      "grep -r --include='remote-access.json.*' x ~/.codeden",
      "grep -rn --include=*.invalid-* . /home/me",
      "find ~ -name 'remote-access.json.invalid-*' | xargs cat",
      "find ~/.codeden -name '*.invalid-*' -exec cat {} +",
    ]) {
      expect(guarded(cmd, posix), cmd).toBe(true);
    }
    for (const cmd of [
      "Get-ChildItem -Recurse -Path ~ -Filter remote-access.json.invalid-* | Get-Content",
      "findstr /s token C:\\Users\\me\\*.invalid-*",
    ]) {
      expect(guarded(cmd, win), cmd).toBe(true);
    }
    expect(
      assessClaudeTool("Grep", { pattern: ".", path: "/home/me", glob: "*.invalid-*" }, posix),
    ).toMatchObject({ codeden: true });
  });

  it("leaves same-named files elsewhere and other copies in the home alone", () => {
    for (const file of [
      "remote-access.json.invalid-1",
      "/home/me/project/remote-access.json.invalid-1234567890",
      "/home/me/.codeden/wt/repo/abc123/remote-access.json.invalid-1",
      // Copies of files that hold no credentials.
      "/home/me/.codeden/settings.json.invalid-1234567890",
      "/home/me/.codeden/usage-settings.json.invalid-1",
      "/home/me/.codeden/remote-access.json.bak",
    ]) {
      expect(classifyRead(file, posix), file).toEqual({ risky: false });
      expect(assessClaudeTool("Read", { file_path: file }, posix), file).toEqual({ risky: false });
    }
    expect(classifyRead("C:\\Users\\me\\project\\remote-access.json.invalid-1", win)).toEqual({
      risky: false,
    });
    for (const cmd of [
      "cat ~/.codeden/settings.json.invalid-*",
      "cat ~/.codeden/logs/*.invalid-*",
      "cat ~/.codeden/remote-access.json.invalid-x*",
      "rg -g '*.invalid-*' . src",
      "rg -g '*.ts' token ~",
      // From a folder above the home (searching the home itself always asks).
      "grep -r --include='settings.json.invalid-*' x ~",
      "find ~ -name '*.log' | xargs cat",
    ]) {
      expect(guarded(cmd, posix), cmd).toBe(false);
    }
    for (const input of [
      { path: "/home/me/.codeden", pattern: "**/*.log" },
      { path: "/home/me/.codeden", pattern: "settings.json.invalid-*" },
    ]) {
      expect(assessClaudeTool("Glob", input, posix), JSON.stringify(input)).toEqual({
        risky: false,
      });
    }
    // Without the session's home the rule is off.
    const { codedenHome: _, ...noHome } = posix;
    expect(classifyRead(COPY, noHome)).toEqual({ risky: false });
  });
});

describe("copies of CodeDen's credential files: every level", () => {
  const read = { file_path: COPY };
  const commands = [`cat ${COPY}`, "cat ~/.codeden/*.invalid-*", "rg -g '*.invalid-*' . ~"];

  it("Claude asks at Supervised, Auto and Full, and refuses read-only sessions and roles", () => {
    for (const level of ["supervised", "auto", "full"] as const) {
      const p = new ClaudePolicy(level, posix);
      expect(p.gate("Read", read), level).toMatchObject({ ask: true, action: "secrets" });
      for (const command of commands) {
        expect(p.gate("Bash", { command }), `${level}: ${command}`).toMatchObject({
          ask: true,
          action: "secrets",
        });
      }
      expect(
        new ClaudePolicy(level, win).gate("PowerShell", {
          command: `Get-Content -LiteralPath ${WIN_COPY}`,
        }),
        level,
      ).toMatchObject({ ask: true, action: "secrets" });
    }
    for (const p of [new ClaudePolicy("read_only", posix), new ClaudePolicy("full", posix, true)]) {
      expect(p.denial("Read", read)).toMatch(/off limits/);
      for (const command of commands)
        expect(p.denial("Bash", { command }), command).toMatch(/off limits/);
    }
  });

  it("Codex never approves them by policy, at Auto or Full", () => {
    for (const level of ["auto", "full"] as const) {
      expect(levelAllows(level, classifyRead(COPY, posix)), level).toBe(false);
      expect(levelAllows(level, classifyRead(WIN_COPY, win)), level).toBe(false);
      for (const command of commands) {
        expect(levelAllows(level, commandRisk([command], posix)), `${level}: ${command}`).toBe(
          false,
        );
      }
    }
    // An ordinary same-named file is not CodeDen's: Full runs it.
    expect(
      levelAllows("full", classifyRead("/home/me/project/remote-access.json.invalid-1", posix)),
    ).toBe(true);
  });

  it("OpenCode asks at every level and denies read-only sessions", () => {
    const shell = (command: string): PermissionCall => ({
      request: { id: "p", sessionID: "s", action: "shell", resources: [command] },
      toolName: "bash",
      toolInput: { command },
    });
    for (const level of ["supervised", "auto", "full"] as const) {
      expect(new OpenCodePolicy(level, posix).decide(shell(`cat ${COPY}`)), level).toMatchObject({
        kind: "ask",
        action: "secrets",
      });
    }
    expect(new OpenCodePolicy("read_only", posix).decide(shell(`cat ${COPY}`))).toMatchObject({
      kind: "deny",
    });
  });
});

describe("wildcardMatchesNumbered", () => {
  const prefix = "/h/.codeden/remote-access.json.invalid-";
  it.each([
    ["/h/.codeden/remote-access.json.invalid-*", true],
    ["/h/.codeden/*", true],
    ["/h/**", true],
    ["/h/**/*.invalid-[0-9]?", true],
    ["/h/.codeden/remote-access.json.invalid-1234567890", true],
    ["/h/.codeden/*[!0-9]", false],
    ["/h/.codeden/*.log", false],
    ["/h/.codeden/remote-access.json.invalid-*/x", false],
    ["/h/.codeden/remote-access.json.invalid-", false],
    ["/h/other/*", false],
  ])("%s → %s", (pattern, expected) => {
    expect(wildcardMatchesNumbered(pattern, prefix, false)).toBe(expected);
  });

  it("matches in any case when asked, and says when a pattern is malformed", () => {
    expect(wildcardMatchesNumbered("/H/.CODEDEN/*", prefix, true)).toBe(true);
    expect(wildcardMatchesNumbered("/H/.CODEDEN/*", prefix, false)).toBe(false);
    expect(wildcardMatchesNumbered("/h/.codeden/[z-a]*", prefix, false)).toBeUndefined();
  });
});

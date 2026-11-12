import type { AutonomyLevel } from "@codeden/contracts";
import { describe, expect, it } from "vitest";
import { ClaudePolicy } from "../src/claude/permissions";
import { assessClaudeTool } from "../src/claude/tools";
import { commandRisk, levelAllows, patchRisk } from "../src/codex/policy";
import { OpenCodePolicy, type PermissionCall } from "../src/opencode/policy";
import { classifyCommand, classifyRead, classifyWrite, type RiskContext } from "../src/policy/risk";

/**
 * CodeDen's own credentials live as plain files in its home (§15): the install token the
 * loopback API accepts, the runner lock with the runner's bearer token, and the remote access
 * store. An agent that reads one can drive the API or the runner and approve its own requests,
 * so touching them asks at every level and is refused for read-only sessions (§11.2). The home
 * comes from the session (`SessionOptions.codedenHome`).
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

const action = (command: string, ctx: RiskContext) => {
  const r = classifyCommand(command, ctx);
  return r.risky ? r.action : null;
};
const guarded = (command: string, ctx: RiskContext) => {
  const r = classifyCommand(command, ctx);
  return r.risky && r.codeden === true;
};

describe("CodeDen's own credential files: the classifier", () => {
  it("a Claude Read or Grep of the install token, the runner lock or the remote access store", () => {
    for (const file_path of [
      "/home/me/.codeden/install-token",
      "/home/me/.codeden/runner/runner.json",
      "/home/me/.codeden/remote-access.json",
      "~/.codeden/install-token",
      "../../../install-token",
    ]) {
      expect(assessClaudeTool("Read", { file_path }, posix), file_path).toMatchObject({
        risky: true,
        action: "secrets",
        codeden: true,
      });
    }
    for (const file_path of [
      "C:\\Users\\me\\.codeden\\install-token",
      "c:/users/me/.codeden/RUNNER/runner.json",
    ]) {
      expect(assessClaudeTool("Read", { file_path }, win), file_path).toMatchObject({
        codeden: true,
      });
    }
    // Searching the home (or its runner folder) reads the files in it.
    expect(assessClaudeTool("Grep", { pattern: ".", path: "~/.codeden" }, posix)).toMatchObject({
      codeden: true,
    });
    expect(
      assessClaudeTool("Grep", { pattern: ".", path: "/home/me/.codeden/runner" }, posix),
    ).toMatchObject({ codeden: true });
    // Listing names reads nothing.
    expect(assessClaudeTool("Glob", { pattern: "*", path: "/home/me/.codeden" }, posix)).toEqual({
      risky: false,
    });
  });

  it("classifyRead and classifyWrite flag them (Codex and OpenCode paths)", () => {
    expect(classifyRead("/home/me/.codeden/install-token", posix)).toMatchObject({ codeden: true });
    expect(classifyRead("/home/me/.codeden/runner/runner.json", posix)).toMatchObject({
      codeden: true,
    });
    expect(classifyWrite("/home/me/.codeden/remote-access.json", posix)).toMatchObject({
      risky: true,
      codeden: true,
    });
  });

  it("POSIX shell reads, by path, through CODEDEN_HOME, a wildcard or the folder", () => {
    for (const cmd of [
      "cat ~/.codeden/install-token",
      "cat ~/.codeden/runner/runner.json",
      'cat "$CODEDEN_HOME/install-token"',
      "cat $CODEDEN_HOME/runner/runner.json",
      // biome-ignore lint/suspicious/noTemplateCurlyInString: a shell variable, not a template
      "cat ${CODEDEN_HOME}/remote-access.json",
      "head -c 64 ~/.codeden/remote-access.json",
      "cat $HOME/.codeden/install-token",
      "cat ~/.codeden/*",
      "cat ~/.codeden/install-*",
      "cat ~/.codeden/runner/*.json",
      "cat ~/.codeden/install-toke?",
      "cat ~/.codeden/{install-token,x}",
      "cat $CODEDEN_HOME/runner/{runner.json,}",
      "cd ~/.codeden && cat install-token",
      "cd $CODEDEN_HOME/runner && cat ./runner.json",
      "cat ../../../install-token",
      "grep -r token ~/.codeden",
      "rg --hidden . $CODEDEN_HOME",
      "tar czf /tmp/home.tgz ~/.codeden",
      "cp ~/.codeden/install-token /tmp/t",
      "git diff --no-index ~/.codeden/install-token /dev/null",
      "bash -c 'cat ~/.codeden/install-token'",
      "find ~/.codeden -name install-token -exec cat {} \\;",
    ]) {
      expect(action(cmd, posix), cmd).toBe("secrets");
      expect(guarded(cmd, posix), cmd).toBe(true);
    }
  });

  it("PowerShell and cmd reads, by path or through CODEDEN_HOME", () => {
    for (const cmd of [
      "Get-Content $env:CODEDEN_HOME\\install-token",
      "Get-Content -Path $env:CODEDEN_HOME\\runner\\runner.json",
      "gc $env:USERPROFILE\\.codeden\\remote-access.json",
      "Get-Content $env:USERPROFILE\\.codeden\\runner\\runner.json",
      "type %USERPROFILE%\\.codeden\\install-token",
      "type %CODEDEN_HOME%\\install-token",
      "Get-Content C:\\Users\\me\\.codeden\\*",
      "Select-String -Pattern token -Path $env:CODEDEN_HOME\\install-token",
    ]) {
      expect(guarded(cmd, win), cmd).toBe(true);
    }
  });

  it("writes and deletes ask too", () => {
    for (const cmd of [
      "echo x > ~/.codeden/install-token",
      "cp evil.json $CODEDEN_HOME/remote-access.json",
      "rm ~/.codeden/runner/runner.json",
    ]) {
      expect(guarded(cmd, posix), cmd).toBe(true);
    }
    expect(guarded("Set-Content $env:CODEDEN_HOME\\install-token x", win)).toBe(true);
  });

  it("leaves same-named files elsewhere, the rest of the home and other commands alone", () => {
    for (const cmd of [
      // A project's own runner.json, in the worktree.
      "cat runner/runner.json",
      "cat /home/me/.codeden/wt/repo/abc123/runner/runner.json",
      "pnpm test",
      "ls ~/.codeden",
      "ls -la $CODEDEN_HOME/runner",
      "cd ~/.codeden/wt/repo/abc123 && pnpm build",
      "cd $CODEDEN_HOME",
      "cat ~/.codeden/logs/server.log",
      "cat ~/.codeden/settings.json",
      'rg -n "install-token" apps/server/src',
      "echo ~/.codeden/install-token",
      "git log --oneline",
    ]) {
      expect(guarded(cmd, posix), cmd).toBe(false);
    }
    expect(
      assessClaudeTool(
        "Read",
        { file_path: "/home/me/.codeden/wt/repo/abc123/runner/runner.json" },
        posix,
      ),
    ).toEqual({ risky: false });
    // Without the session's home the rule is off; copies named like the token are still secrets.
    const { codedenHome: _, ...noHome } = posix;
    expect(classifyRead("/home/me/.codeden/runner/runner.json", noHome)).toEqual({ risky: false });
    expect(classifyRead("/tmp/copy/install-token", noHome)).toMatchObject({ action: "secrets" });
  });
});

describe("CodeDen's own credential files: every level", () => {
  const read = { file_path: "/home/me/.codeden/install-token" };
  const cat = { command: "cat $CODEDEN_HOME/runner/runner.json" };

  it("Claude asks under Supervised, Auto and Full", () => {
    for (const level of ["supervised", "auto", "full"] as const) {
      const p = new ClaudePolicy(level, posix);
      expect(p.denial("Read", read), level).toBeUndefined();
      expect(p.gate("Read", read), level).toMatchObject({ ask: true, action: "secrets" });
      expect(p.gate("Bash", cat), level).toMatchObject({ ask: true, action: "secrets" });
      expect(
        p.gate("Write", { file_path: "/home/me/.codeden/install-token" }),
        level,
      ).toMatchObject({ ask: true });
    }
    // Under Full an ordinary secrets read still runs.
    expect(new ClaudePolicy("full", posix).gate("Read", { file_path: ".env" }).ask).toBe(false);
  });

  it("Claude refuses them at Read-only and for the orchestrator and PMs", () => {
    for (const p of [new ClaudePolicy("read_only", posix), new ClaudePolicy("full", posix, true)]) {
      expect(p.denial("Read", read)).toMatch(/credential files are off limits/);
      expect(p.denial("Bash", cat)).toMatch(/credential files are off limits/);
      expect(p.denial("Grep", { pattern: "x", path: "~/.codeden" })).toMatch(/off limits/);
      // Relative paths resolve from the shell's current directory.
      expect(p.denial("Bash", { command: "cat install-token" }, "/home/me/.codeden")).toMatch(
        /off limits/,
      );
      expect(p.denial("Read", { file_path: "src/a.ts" })).toBeUndefined();
    }
  });

  it("a Read approved for the session doesn't cover them; an exact command does", () => {
    const p = new ClaudePolicy("auto", posix);
    p.allowForSession("Read", { file_path: ".env" });
    expect(p.gate("Read", { file_path: ".env.local" }).ask).toBe(false);
    expect(p.gate("Read", read).ask).toBe(true);
    p.allowForSession("Bash", cat);
    expect(p.gate("Bash", cat).ask).toBe(false);
  });

  it("OpenCode asks at every level and refuses read-only sessions", () => {
    const ctx = posix;
    const shell = (command: string): PermissionCall => ({
      request: { id: "p", sessionID: "s", action: "shell", resources: [command] },
      toolName: "bash",
      toolInput: { command },
    });
    const outside = (resource: string): PermissionCall => ({
      request: { id: "p", sessionID: "s", action: "external_directory", resources: [resource] },
    });
    const edit = (file: string): PermissionCall => ({
      request: { id: "p", sessionID: "s", action: "edit", resources: [file] },
    });
    for (const level of ["supervised", "auto", "full"] as AutonomyLevel[]) {
      const p = new OpenCodePolicy(level, ctx);
      expect(p.decide(shell("cat ~/.codeden/install-token")), level).toMatchObject({
        kind: "ask",
        action: "secrets",
      });
      // OpenCode names the folder of a file outside the worktree.
      expect(p.decide(outside("/home/me/.codeden/*")), level).toMatchObject({ kind: "ask" });
      expect(p.decide(outside("/home/me/.codeden/runner/*")), level).toMatchObject({
        kind: "ask",
      });
      expect(p.decide(edit("/home/me/.codeden/remote-access.json")), level).toMatchObject({
        kind: "ask",
      });
    }
    expect(new OpenCodePolicy("full", ctx).decide(outside("/home/me/other/*"))).toEqual({
      kind: "allow",
    });
    for (const p of [new OpenCodePolicy("read_only", ctx), new OpenCodePolicy("auto", ctx, true)]) {
      expect(p.decide(shell("cat ~/.codeden/install-token"))).toMatchObject({
        kind: "deny",
        message: expect.stringMatching(/off limits/),
      });
      expect(p.decide(outside("/home/me/.codeden/*"))).toMatchObject({ kind: "deny" });
      expect(p.decide(shell("cat README.md"))).toEqual({ kind: "allow" });
    }
  });

  it("Codex: requests that reach CodeDen are never approved by policy", () => {
    for (const level of ["auto", "full"] as const) {
      expect(levelAllows(level, commandRisk(["cat ~/.codeden/install-token"], posix)), level).toBe(
        false,
      );
      expect(
        levelAllows(level, patchRisk(["/home/me/.codeden/remote-access.json"], null, posix)),
        level,
      ).toBe(false);
    }
    expect(levelAllows("full", commandRisk(["cat .env"], posix))).toBe(true);
  });
});

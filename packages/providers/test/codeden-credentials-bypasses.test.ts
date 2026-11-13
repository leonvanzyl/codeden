import type { AutonomyLevel } from "@codeden/contracts";
import { describe, expect, it } from "vitest";
import { ClaudePolicy } from "../src/claude/permissions";
import { assessClaudeTool } from "../src/claude/tools";
import { commandRisk, levelAllows } from "../src/codex/policy";
import { OpenCodePolicy, type PermissionCall } from "../src/opencode/policy";
import { classifyCommand, classifyRead, classifyWrite, type RiskContext } from "../src/policy/risk";

/**
 * Ordinary command syntax that names CodeDen's own credential files (§11.2, §15) must not slip
 * past the guard: search options with attached values or in clusters (`grep -e. file`,
 * `-ne.`, `-fFILE`), PowerShell path lists (`Get-Content a,b`), and a CodeDen home whose
 * folder name has glob characters in it (`CodeDen [dev]`).
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

const guarded = (command: string, ctx: RiskContext) => {
  const r = classifyCommand(command, ctx);
  return r.risky && r.codeden === true;
};
const action = (command: string, ctx: RiskContext) => {
  const r = classifyCommand(command, ctx);
  return r.risky ? r.action : null;
};

const FILES = ["install-token", "runner/runner.json", "remote-access.json"];

describe("search options with attached values or in clusters", () => {
  const posixReads = [
    // From the report.
    "grep -e. /home/me/.codeden/install-token",
    "rg -e. /home/me/.codeden/runner/runner.json",
    "grep -ne. /home/me/.codeden/remote-access.json",
    "rg --hidden -g install-token -e. /home/me",
    // `-eVALUE` and clusters ending in `e`, direct paths.
    "grep -etoken ~/.codeden/install-token",
    "egrep -ie. $CODEDEN_HOME/runner/runner.json",
    "rg -ie. ~/.codeden/remote-access.json",
    // An attached pattern file.
    "grep -fpatterns.txt /home/me/.codeden/install-token",
    "grep -nfpatterns.txt ~/.codeden/runner/runner.json",
    "rg -fpatterns.txt $CODEDEN_HOME/remote-access.json",
    // Recursive, from a folder above them.
    "grep -re. /home/me",
    "grep -rne. ~/.codeden",
    "grep -r -e. /home/me",
    "grep -Rfpatterns.txt ~",
    "rg -e. ~",
    "rg -ie. $CODEDEN_HOME",
    // The pattern file is the credential.
    "grep -f/home/me/.codeden/install-token README.md",
    "grep -nf$CODEDEN_HOME/runner/runner.json README.md",
    // After `--` every word is an operand, even one starting with `-`.
    "grep -- -x ~/.codeden/install-token",
    "grep -e. -- ~/.codeden/remote-access.json",
  ];
  const gitBashReads = [
    "grep -e. C:\\Users\\me\\.codeden\\install-token",
    "rg -e. /c/Users/me/.codeden/runner/runner.json",
    "grep -ne. $CODEDEN_HOME/remote-access.json",
    "grep -fpatterns.txt C:/Users/me/.codeden/install-token",
    "rg --hidden -g install-token -e. C:\\Users\\me",
    "grep -re. /c/Users/me",
  ];

  it("reach the credential files on POSIX", () => {
    for (const cmd of posixReads) {
      expect(action(cmd, posix), cmd).toBe("secrets");
      expect(guarded(cmd, posix), cmd).toBe(true);
    }
  });

  it("leaves the options of tools whose -f takes no value as written", () => {
    // `ag -f` follows symlinks and `ack -f` lists files: `~` stays a root, not a pattern file.
    for (const cmd of ["ag token -if ~", "ack token -if ~"]) {
      expect(guarded(cmd, posix), cmd).toBe(true);
    }
  });

  it("reach the credential files from Git Bash on Windows", () => {
    for (const cmd of gitBashReads)
      expect(guarded(cmd, { ...win, shell: "posix" }), cmd).toBe(true);
  });

  it("ordinary searches in the project stay safe", () => {
    for (const cmd of [
      "grep -e. src",
      "grep -ne. README.md",
      "grep -rne. src",
      "grep -re. .",
      "grep -fpatterns.txt src/index.ts",
      "rg -e. src",
      "rg -ie. -g '*.ts'",
      // A project file that is merely named like a credential file.
      "grep -ne. install-token",
      "rg -e. runner/runner.json",
      // A pattern that only names a credential file searches other files for that text.
      "grep -e/home/me/.codeden/install-token README.md",
      "grep -ne~/.codeden/install-token docs",
      "grep -- ~/.codeden/install-token README.md",
      // Clustered options with values (`-A3`, `-m1`) are not files.
      "grep -nA3 -m1 token src",
    ]) {
      expect(action(cmd, posix), cmd).toBeNull();
    }
  });
});

describe("PowerShell path lists", () => {
  const lists = [
    // From the report.
    "Get-Content -LiteralPath C:\\Users\\me\\.codeden\\install-token,C:\\Users\\me\\.codeden\\runner\\runner.json",
    "Select-String -Pattern . -Path C:\\Users\\me\\.codeden\\install-token,C:\\Users\\me\\.codeden\\runner\\runner.json",
    "Get-Content $env:CODEDEN_HOME\\install-token,$env:CODEDEN_HOME\\runner\\runner.json",
    // The credential file second, quoted elements, colon-bound and copied.
    "Get-Content README.md,$env:CODEDEN_HOME\\remote-access.json",
    "Get-Content 'README.md','C:\\Users\\me\\.codeden\\install-token'",
    'Get-Content "README.md",$env:CODEDEN_HOME\\install-token',
    "Get-Content -Path:README.md,$env:CODEDEN_HOME\\install-token",
    "gc README.md,$env:USERPROFILE\\.codeden\\runner\\runner.json",
    "Copy-Item README.md,$env:CODEDEN_HOME\\install-token C:\\Users\\me\\AppData\\Local\\Temp",
    "Get-Content README.md ,$env:CODEDEN_HOME\\install-token",
    "Get-Content README.md,C:\\Users\\me\\.codeden\\*",
  ];

  it("each element is checked, in PowerShell and when the shell is unknown", () => {
    for (const shell of ["powershell", "auto"] as const) {
      for (const cmd of lists)
        expect(guarded(cmd, { ...win, shell }), `${shell}: ${cmd}`).toBe(true);
    }
    // PowerShell on macOS or Linux.
    expect(
      guarded("Get-Content /home/me/.codeden/install-token,/home/me/.codeden/runner/runner.json", {
        ...posix,
        shell: "powershell",
      }),
    ).toBe(true);
    // An ordinary secrets file in a list asks like one on its own.
    expect(action("Get-Content README.md,.env", { ...win, shell: "powershell" })).toBe("secrets");
  });

  it("commas inside a quoted literal stay part of one name", () => {
    for (const shell of ["powershell", "auto"] as const) {
      const ctx = { ...win, shell };
      for (const cmd of [
        "Get-Content README.md,CHANGELOG.md",
        "Get-Content 'C:\\Users\\me\\.codeden\\install-token,x'",
        'Get-Content "C:\\Users\\me\\.codeden\\runner\\runner.json,bak"',
        "Get-Content install-token,runner\\runner.json",
        "Select-String -Pattern 'a,b' -Path src\\*.ts",
        "Write-Output a,b",
      ]) {
        expect(action(cmd, ctx), `${shell}: ${cmd}`).toBeNull();
      }
    }
  });
});

describe("a CodeDen home with glob characters in its name", () => {
  const homes: RiskContext[] = [
    { ...posix, codedenHome: "/tmp/CodeDen [dev]" },
    { ...posix, codedenHome: "/home/me/odd *?[x] home" },
    { ...posix, codedenHome: "/home/me/a]b" },
    { ...win, codedenHome: "C:\\Users\\me\\CodeDen [dev]" },
    { ...win, codedenHome: "C:\\Users\\me\\Code Den [a-z]" },
  ];

  it("Read, Write and Claude's Read guard all three files", () => {
    for (const ctx of homes) {
      const home = ctx.codedenHome as string;
      const sep = ctx.platform === "win32" ? "\\" : "/";
      for (const file of FILES) {
        const target = `${home}${sep}${file.replace("/", sep)}`;
        expect(classifyRead(target, ctx), target).toMatchObject({ risky: true, codeden: true });
        expect(classifyWrite(target, ctx), target).toMatchObject({ risky: true, codeden: true });
        expect(assessClaudeTool("Read", { file_path: target }, ctx), target).toMatchObject({
          codeden: true,
        });
      }
    }
  });

  it("searches, globs and shell commands reach them too", () => {
    for (const ctx of homes) {
      const home = ctx.codedenHome as string;
      const label = (what: string) => `${home}: ${what}`;
      expect(
        assessClaudeTool("Grep", { pattern: ".", path: home }, ctx),
        label("Grep"),
      ).toMatchObject({ codeden: true });
      expect(
        assessClaudeTool("Glob", { path: home, pattern: "install-token" }, ctx),
        label("Glob"),
      ).toMatchObject({ codeden: true });
      expect(
        assessClaudeTool("Glob", { path: home, pattern: "*" }, ctx),
        label("Glob *"),
      ).toMatchObject({ codeden: true });
      const commands =
        ctx.platform === "win32"
          ? ["Get-Content $env:CODEDEN_HOME\\install-token", `Get-Content '${home}\\install-token'`]
          : [
              'cat "$CODEDEN_HOME/install-token"',
              `cat '${home}/runner/runner.json'`,
              `cat '${home}'/*`,
              'grep -r token "$CODEDEN_HOME"',
            ];
      for (const cmd of commands) expect(guarded(cmd, ctx), label(cmd)).toBe(true);
    }
  });

  it("a wildcard the agent writes below a bracketed folder still matches", () => {
    // The default home under a user folder whose name has brackets.
    const ctx: RiskContext = {
      ...posix,
      cwd: "/home/J [1]/src/app",
      home: "/home/J [1]",
      codedenHome: "/home/J [1]/.codeden",
    };
    for (const cmd of [
      "cat ~/.code*/install-token",
      "cat ~/.codeden/runner/*.json",
      "cat ~/*/remote-access.json",
      "rg -g install-token . ~",
    ]) {
      expect(guarded(cmd, ctx), cmd).toBe(true);
    }
    expect(action("cat ~/.code*/settings.json", ctx)).toBeNull();
  });

  it("other files in and next to that home stay safe", () => {
    const ctx: RiskContext = { ...posix, codedenHome: "/tmp/CodeDen [dev]" };
    for (const target of [
      "/tmp/CodeDen d/install-token",
      "/tmp/CodeDen [dev]/logs/server.log",
      "/tmp/CodeDen [dev]/settings.json",
      "install-token",
    ]) {
      expect(classifyRead(target, ctx), target).toEqual({ risky: false });
    }
    const onWindows: RiskContext = { ...win, codedenHome: "C:\\Users\\me\\CodeDen [dev]" };
    expect(classifyRead("C:\\Users\\me\\CodeDen [dev]\\settings.json", onWindows)).toEqual({
      risky: false,
    });
    expect(
      assessClaudeTool(
        "Glob",
        { path: "C:\\Users\\me\\CodeDen [dev]", pattern: "logs/*" },
        onWindows,
      ),
    ).toEqual({ risky: false });
  });
});

describe("every level asks, read-only refuses, Codex never auto-approves", () => {
  const posixCommands = [
    "grep -e. /home/me/.codeden/install-token",
    "rg -e. /home/me/.codeden/runner/runner.json",
    "grep -ne. /home/me/.codeden/remote-access.json",
    "rg --hidden -g install-token -e. /home/me",
    "grep -fpatterns.txt /home/me/.codeden/install-token",
    "grep -re. /home/me",
  ];
  const pwshCommands = [
    "Get-Content -LiteralPath C:\\Users\\me\\.codeden\\install-token,C:\\Users\\me\\.codeden\\runner\\runner.json",
    "Select-String -Pattern . -Path C:\\Users\\me\\.codeden\\install-token,C:\\Users\\me\\.codeden\\runner\\runner.json",
    "Get-Content $env:CODEDEN_HOME\\install-token,$env:CODEDEN_HOME\\runner\\runner.json",
  ];
  const bracketHome: RiskContext = { ...win, codedenHome: "C:\\Users\\me\\CodeDen [dev]" };
  const bracketRead = { file_path: "C:\\Users\\me\\CodeDen [dev]\\install-token" };

  it("Claude", () => {
    for (const level of ["supervised", "auto", "full"] as const) {
      const bash = new ClaudePolicy(level, posix);
      for (const command of posixCommands) {
        expect(bash.gate("Bash", { command }), `${level}: ${command}`).toMatchObject({
          ask: true,
          action: "secrets",
        });
      }
      const pwsh = new ClaudePolicy(level, win);
      for (const command of pwshCommands) {
        expect(pwsh.gate("PowerShell", { command }), `${level}: ${command}`).toMatchObject({
          ask: true,
          action: "secrets",
        });
      }
      expect(new ClaudePolicy(level, bracketHome).gate("Read", bracketRead), level).toMatchObject({
        ask: true,
        action: "secrets",
      });
    }
    for (const isPm of [false, true]) {
      const level = isPm ? "full" : "read_only";
      const bash = new ClaudePolicy(level, posix, isPm);
      for (const command of posixCommands) {
        expect(bash.denial("Bash", { command }), command).toMatch(/off limits/);
      }
      const pwsh = new ClaudePolicy(level, win, isPm);
      for (const command of pwshCommands) {
        expect(pwsh.denial("PowerShell", { command }), command).toMatch(/off limits/);
      }
      expect(new ClaudePolicy(level, bracketHome, isPm).denial("Read", bracketRead)).toMatch(
        /off limits/,
      );
    }
  });

  it("OpenCode", () => {
    const shell = (command: string): PermissionCall => ({
      request: { id: "p", sessionID: "s", action: "shell", resources: [command] },
      toolName: "bash",
      toolInput: { command },
    });
    for (const level of ["supervised", "auto", "full"] as AutonomyLevel[]) {
      for (const command of posixCommands) {
        expect(new OpenCodePolicy(level, posix).decide(shell(command)), command).toMatchObject({
          kind: "ask",
          action: "secrets",
        });
      }
      for (const command of pwshCommands) {
        expect(new OpenCodePolicy(level, win).decide(shell(command)), command).toMatchObject({
          kind: "ask",
          action: "secrets",
        });
      }
    }
    for (const p of [
      new OpenCodePolicy("read_only", posix),
      new OpenCodePolicy("auto", posix, true),
    ]) {
      for (const command of posixCommands) {
        expect(p.decide(shell(command)), command).toMatchObject({ kind: "deny" });
      }
    }
    for (const p of [new OpenCodePolicy("read_only", win), new OpenCodePolicy("auto", win, true)]) {
      for (const command of pwshCommands) {
        expect(p.decide(shell(command)), command).toMatchObject({ kind: "deny" });
      }
    }
  });

  it("Codex", () => {
    for (const level of ["auto", "full"] as const) {
      for (const command of posixCommands) {
        expect(levelAllows(level, commandRisk([command], posix)), `${level}: ${command}`).toBe(
          false,
        );
      }
      for (const command of pwshCommands) {
        expect(levelAllows(level, commandRisk([command], win)), `${level}: ${command}`).toBe(false);
      }
    }
  });
});

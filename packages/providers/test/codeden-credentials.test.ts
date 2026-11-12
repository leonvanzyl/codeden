import type { AutonomyLevel } from "@codeden/contracts";
import { describe, expect, it } from "vitest";
import { ClaudePolicy } from "../src/claude/permissions";
import { assessClaudeTool } from "../src/claude/tools";
import { commandRisk, levelAllows, patchRisk, permissionsRisk } from "../src/codex/policy";
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
    // A Grep filtered to the files' names, from a folder above the home, reads them too.
    expect(
      assessClaudeTool("Grep", { pattern: ".", path: "/home/me", glob: "install-token" }, posix),
    ).toMatchObject({ codeden: true });
    expect(assessClaudeTool("Grep", { pattern: "x", glob: "*.json" }, posix)).toEqual({
      risky: false,
    });
  });

  it("a Claude Glob that reaches them asks; ordinary globbing doesn't", () => {
    for (const input of [
      { path: "/home/me/.codeden", pattern: "install-token" },
      { pattern: "/home/me/.codeden/install-token" },
      { path: "/home/me/.codeden", pattern: "*" },
      { path: "~/.codeden", pattern: "runner/*.json" },
      { path: "/home/me", pattern: "**/remote-access.json" },
      { pattern: "../../../{install-token,x}" },
      // `**/` is zero or more folders: files right in the search folder count.
      { path: "/home/me/.codeden", pattern: "**/install-token" },
      { path: "/home/me/.codeden", pattern: "**/remote-access.json" },
      { path: "/home/me/.codeden/runner", pattern: "**/runner.json" },
      { path: "/home/me/.codeden", pattern: "**/runner.json" },
      { pattern: "/home/me/.codeden/**/install-token" },
    ]) {
      expect(assessClaudeTool("Glob", input, posix), JSON.stringify(input)).toMatchObject({
        risky: true,
        codeden: true,
      });
    }
    for (const input of [
      { path: "C:\\Users\\me\\.codeden", pattern: "*-token" },
      { path: "C:\\Users\\me\\.codeden", pattern: "**/install-token" },
      { path: "C:\\Users\\me\\.codeden\\runner", pattern: "**/runner.json" },
      { path: "C:\\Users\\me\\.codeden", pattern: "**/runner.json" },
      { path: "C:\\Users\\me", pattern: "**/REMOTE-ACCESS.json" },
    ]) {
      expect(assessClaudeTool("Glob", input, win), JSON.stringify(input)).toMatchObject({
        codeden: true,
      });
    }
    for (const input of [
      { pattern: "**/*.ts" },
      { pattern: "**/*" },
      { pattern: "src/**/runner.json" },
      { path: "/home/me/.codeden/wt/repo/abc123", pattern: "**/install-token" },
      { path: "/home/me/.codeden", pattern: "logs/*.log" },
      { path: "/home/me/.codeden", pattern: "**/*.log" },
      { path: "/home/me/.codeden/runner", pattern: "**/install-token" },
    ]) {
      expect(assessClaudeTool("Glob", input, posix), JSON.stringify(input)).toEqual({
        risky: false,
      });
    }
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
      // Colon-bound parameters.
      "Get-Content -LiteralPath:$env:CODEDEN_HOME\\runner\\runner.json",
      "Get-Content -Path:C:\\Users\\me\\.codeden\\install-token",
      "Select-String -Pattern . -Path:$env:CODEDEN_HOME\\runner\\runner.json",
      "Select-String -Pattern:x $env:CODEDEN_HOME\\install-token",
      "Set-Location -Path:$env:CODEDEN_HOME; Get-Content install-token",
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
    for (const cmd of [
      "Set-Content $env:CODEDEN_HOME\\install-token x",
      "Set-Content -Path:$env:CODEDEN_HOME\\install-token -Value x",
      "Out-File -FilePath:$env:CODEDEN_HOME\\runner\\runner.json",
      "Copy-Item evil.json -Destination:$env:CODEDEN_HOME\\remote-access.json",
    ]) {
      expect(guarded(cmd, win), cmd).toBe(true);
    }
  });

  it("an earlier ordinary risk can't hide them, nested or inline", () => {
    for (const cmd of [
      "cat .env; cat ~/.codeden/install-token",
      "cat .env; echo x > ~/.codeden/install-token",
      "git push --force && cat $CODEDEN_HOME/runner/runner.json",
      "sudo cat ~/.codeden/install-token",
      "npm i -g x; bash -c 'cat ~/.codeden/install-token'",
      "echo $(cat .env) $(cat ~/.codeden/install-token)",
      "printenv; cp ~/.codeden/remote-access.json /tmp/x",
    ]) {
      expect(guarded(cmd, posix), cmd).toBe(true);
    }
    expect(
      guarded("Get-Content .env; Get-Content -LiteralPath:$env:CODEDEN_HOME\\install-token", win),
    ).toBe(true);
  });

  it("a search pattern that repeats a file operand doesn't hide the file", () => {
    for (const cmd of [
      "grep -e . -e /home/me/.codeden/install-token /home/me/.codeden/install-token",
      "rg -e . -e /home/me/.codeden/runner/runner.json /home/me/.codeden/runner/runner.json",
      "grep /home/me/.codeden/install-token /home/me/.codeden/install-token",
      "rg --regexp=~/.codeden/install-token ~/.codeden/install-token",
    ]) {
      expect(guarded(cmd, posix), cmd).toBe(true);
    }
    expect(
      guarded(
        "Select-String -Pattern $env:CODEDEN_HOME\\install-token -Path $env:CODEDEN_HOME\\install-token",
        win,
      ),
    ).toBe(true);
    // A pattern that only names the file searches other files for that text.
    for (const cmd of [
      "grep -e ~/.codeden/install-token README.md",
      "rg ~/.codeden/install-token docs",
    ]) {
      expect(guarded(cmd, posix), cmd).toBe(false);
    }
  });

  it("a recursive search, or a listing that feeds a command, from a folder above them", () => {
    for (const cmd of [
      "rg --hidden --no-ignore -g install-token . /home/me",
      "rg -g '*.json' token ~",
      "rg --glob=remote-access.json . /home",
      "rg -g '**/install-token' . ~",
      "rg token ~",
      "grep -r token ~",
      "grep -rn --include=install-token . /home/me",
      "grep -R x /",
      "grep -d recurse x ~",
      "cd ~ && rg token",
      "find ~ -name install-token | xargs cat",
      "find ~ -name install-token -exec cat {} \\;",
      "find / -iname runner.json -print0 | xargs -0 cat",
      "cat $(find ~ -name install-token)",
      "fd install-token ~ -x cat",
      "ls ~/.codeden | xargs -I{} cat ~/.codeden/{}",
      "echo ~/.codeden/install-token | xargs cat",
      "xargs cat <<< ~/.codeden/install-token",
      "cat $CODEDEN_HOME/$name",
    ]) {
      expect(guarded(cmd, posix), cmd).toBe(true);
    }
    for (const cmd of [
      "findstr /s token C:\\Users\\me\\install-token",
      "findstr /s /i x %USERPROFILE%\\*.json",
      "Get-ChildItem -Recurse -Path ~ -Filter install-token | Get-Content",
      "gci $env:USERPROFILE -r -Include *.json | Select-String token",
      "Get-ChildItem $env:CODEDEN_HOME | Get-Content",
    ]) {
      expect(guarded(cmd, win), cmd).toBe(true);
    }
    // Filters that leave them out, other folders, and listings only shown to the user don't.
    for (const cmd of [
      "rg -g '*.ts' token ~",
      "grep -rn --include=*.md token ~",
      "rg -g '!*.ts' token src",
      "rg token src",
      "grep -r token .",
      "grep token ~",
      "find ~ -name '*.ts' | xargs wc -l",
      "find . -name install-token | xargs cat",
      "find ~ -name install-token",
      "ls -R ~",
      "ls ~ | head",
      "echo hello | grep h",
    ]) {
      expect(guarded(cmd, posix), cmd).toBe(false);
    }
    expect(guarded("findstr /s token *.ts", win)).toBe(false);
  });

  it("leaves same-named files elsewhere, the rest of the home and other commands alone", () => {
    for (const cmd of [
      // A project's own files with the same names, in the worktree.
      "cat runner/runner.json",
      "cat install-token",
      "cat remote-access.json",
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
      expect(action(cmd, posix), cmd).toBeNull();
    }
    for (const file of ["install-token", "remote-access.json", "runner/runner.json"]) {
      expect(classifyRead(file, posix), file).toEqual({ risky: false });
      expect(classifyWrite(file, posix), file).toEqual({ risky: false });
      expect(assessClaudeTool("Read", { file_path: file }, posix), file).toEqual({ risky: false });
      expect(
        assessClaudeTool("Read", { file_path: `/home/me/.codeden/wt/repo/abc123/${file}` }, posix),
        file,
      ).toEqual({ risky: false });
    }
    expect(action("Get-Content install-token", win)).toBeNull();
    // Without the session's home the rule is off.
    const { codedenHome: _, ...noHome } = posix;
    expect(classifyRead("/home/me/.codeden/runner/runner.json", noHome)).toEqual({ risky: false });
  });
});

describe("CodeDen's own credential files: every level", () => {
  const read = { file_path: "/home/me/.codeden/install-token" };
  const cat = { command: "cat $CODEDEN_HOME/runner/runner.json" };
  /** An ordinary risk first, which Full allows, then CodeDen's credentials. */
  const masked = [
    "cat .env; cat ~/.codeden/install-token",
    "cat .env; echo x > ~/.codeden/install-token",
    "git push --force; cat $CODEDEN_HOME/runner/runner.json",
  ];
  /** Searches that read them through a repeated pattern or from a folder above them. */
  const searches = [
    "grep -e . -e /home/me/.codeden/install-token /home/me/.codeden/install-token",
    "rg -e . -e /home/me/.codeden/runner/runner.json /home/me/.codeden/runner/runner.json",
    "rg --hidden --no-ignore -g install-token . /home/me",
    "find ~ -name install-token | xargs cat",
  ];
  const colonBound = [
    "Get-Content -LiteralPath:$env:CODEDEN_HOME\\runner\\runner.json",
    "Select-String -Pattern . -Path:$env:CODEDEN_HOME\\runner\\runner.json",
    "Set-Content -Path:$env:CODEDEN_HOME\\install-token -Value x",
  ];

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
      for (const [tool, input] of [
        ["Glob", { path: "/home/me/.codeden", pattern: "install-token" }],
        ["Glob", { path: "/home/me/.codeden", pattern: "**/install-token" }],
        ["Grep", { pattern: ".", path: "/home/me", glob: "install-token" }],
      ] as const) {
        expect(p.gate(tool, input), `${level}: ${tool}`).toMatchObject({ ask: true });
      }
      for (const command of [...masked, ...searches]) {
        expect(p.gate("Bash", { command }), `${level}: ${command}`).toMatchObject({
          ask: true,
          action: "secrets",
          reason: expect.stringMatching(/CodeDen's own credentials/),
        });
      }
      const pwsh = new ClaudePolicy(level, win);
      for (const command of colonBound) {
        expect(pwsh.gate("PowerShell", { command }), `${level}: ${command}`).toMatchObject({
          ask: true,
          action: "secrets",
        });
      }
    }
    // Under Full an ordinary secrets read still runs.
    expect(new ClaudePolicy("full", posix).gate("Read", { file_path: ".env" }).ask).toBe(false);
    expect(new ClaudePolicy("full", posix).gate("Bash", { command: "cat .env" }).ask).toBe(false);
  });

  it("Claude refuses them at Read-only and for the orchestrator and PMs", () => {
    for (const p of [new ClaudePolicy("read_only", posix), new ClaudePolicy("full", posix, true)]) {
      expect(p.denial("Read", read)).toMatch(/credential files are off limits/);
      expect(p.denial("Bash", cat)).toMatch(/credential files are off limits/);
      expect(p.denial("Grep", { pattern: "x", path: "~/.codeden" })).toMatch(/off limits/);
      expect(p.denial("Glob", { pattern: "/home/me/.codeden/*" })).toMatch(/off limits/);
      expect(p.denial("Glob", { path: "/home/me/.codeden", pattern: "**/install-token" })).toMatch(
        /off limits/,
      );
      for (const command of [...masked, ...searches]) {
        expect(p.denial("Bash", { command }), command).toMatch(/off limits/);
      }
      // Relative paths resolve from the shell's current directory.
      expect(p.denial("Bash", { command: "cat install-token" }, "/home/me/.codeden")).toMatch(
        /off limits/,
      );
      expect(p.denial("Read", { file_path: "src/a.ts" })).toBeUndefined();
    }
    const pwsh = new ClaudePolicy("read_only", win);
    for (const command of colonBound) {
      expect(pwsh.denial("PowerShell", { command }), command).toMatch(/off limits/);
    }
  });

  it("a session approval covers them only as given: same call, same directory", () => {
    const worktree = posix.cwd;
    const home = "/home/me/.codeden";
    const p = new ClaudePolicy("supervised", posix);
    // A harmless read of the repository's own file, approved for the session...
    const repoRead = { command: "cat runner/runner.json" };
    expect(p.gate("Bash", repoRead, worktree).ask).toBe(true);
    p.allowForSession("Bash", repoRead, worktree);
    expect(p.gate("Bash", repoRead, worktree).ask).toBe(false);
    // ...doesn't approve the same words once the shell is in CodeDen's home.
    expect(p.gate("Bash", repoRead, home)).toMatchObject({ ask: true, action: "secrets" });
    expect(p.needsUser("Bash", repoRead, home).ask).toBe(true);
    // Approving the credential read itself covers that call, there.
    p.allowForSession("Bash", repoRead, home);
    expect(p.gate("Bash", repoRead, home).ask).toBe(false);
    expect(p.gate("Bash", repoRead, worktree).ask).toBe(false);

    // Approving the Read tool for the session doesn't cover them; approving one does.
    const auto = new ClaudePolicy("auto", posix);
    auto.allowForSession("Read", { file_path: ".env" });
    expect(auto.gate("Read", { file_path: ".env.local" }).ask).toBe(false);
    expect(auto.gate("Read", read).ask).toBe(true);
    auto.allowForSession("Read", read);
    expect(auto.gate("Read", read).ask).toBe(false);
    expect(auto.gate("Read", { file_path: "/home/me/.codeden/remote-access.json" }).ask).toBe(true);
  });

  describe("OpenCode", () => {
    const shell = (command: string, workdir?: string): PermissionCall => ({
      request: { id: "p", sessionID: "s", action: "shell", resources: [command] },
      toolName: "bash",
      toolInput: { command, ...(workdir ? { workdir } : {}) },
    });
    const outside = (resource: string): PermissionCall => ({
      request: { id: "p", sessionID: "s", action: "external_directory", resources: [resource] },
    });
    const edit = (file: string): PermissionCall => ({
      request: { id: "p", sessionID: "s", action: "edit", resources: [file] },
    });

    it("asks at every level", () => {
      for (const level of ["supervised", "auto", "full"] as AutonomyLevel[]) {
        const p = new OpenCodePolicy(level, posix);
        expect(p.decide(shell("cat ~/.codeden/install-token")), level).toMatchObject({
          kind: "ask",
          action: "secrets",
        });
        for (const command of [...masked, ...searches]) {
          expect(p.decide(shell(command)), `${level}: ${command}`).toMatchObject({
            kind: "ask",
            action: "secrets",
          });
        }
        // OpenCode names the folder of a file outside the worktree.
        expect(p.decide(outside("/home/me/.codeden/*")), level).toMatchObject({ kind: "ask" });
        expect(p.decide(outside("/home/me/.codeden/runner/*")), level).toMatchObject({
          kind: "ask",
        });
        expect(p.decide(edit("/home/me/.codeden/remote-access.json")), level).toMatchObject({
          kind: "ask",
        });
        const onWindows = new OpenCodePolicy(level, win);
        for (const command of colonBound) {
          expect(onWindows.decide(shell(command)), `${level}: ${command}`).toMatchObject({
            kind: "ask",
          });
        }
      }
      expect(new OpenCodePolicy("full", posix).decide(outside("/home/me/other/*"))).toEqual({
        kind: "allow",
      });
      expect(new OpenCodePolicy("full", posix).decide(shell("cat .env"))).toEqual({
        kind: "allow",
      });
    });

    it("refuses read-only sessions, the orchestrator and PMs", () => {
      for (const p of [
        new OpenCodePolicy("read_only", posix),
        new OpenCodePolicy("auto", posix, true),
      ]) {
        expect(p.decide(shell("cat ~/.codeden/install-token"))).toMatchObject({
          kind: "deny",
          message: expect.stringMatching(/off limits/),
        });
        for (const command of [...masked, ...searches]) {
          expect(p.decide(shell(command)), command).toMatchObject({ kind: "deny" });
        }
        expect(p.decide(outside("/home/me/.codeden/*"))).toMatchObject({ kind: "deny" });
        expect(p.decide(shell("cat README.md"))).toEqual({ kind: "allow" });
      }
    });

    it("a command approved for the session covers it in that directory only", () => {
      const p = new OpenCodePolicy("supervised", posix);
      const repoRead = shell("cat runner/runner.json");
      p.allowForSession(repoRead);
      expect(p.decide(repoRead)).toEqual({ kind: "allow" });
      expect(p.decide(shell("cat runner/runner.json", "/home/me/.codeden"))).toMatchObject({
        kind: "ask",
        action: "secrets",
      });
    });
  });

  it("Codex: requests that reach CodeDen are never approved by policy", () => {
    for (const level of ["auto", "full"] as const) {
      for (const texts of [
        ["cat ~/.codeden/install-token"],
        ...[...masked, ...searches].map((command) => [command]),
        // The command line as sent, then Codex's parsed actions.
        ["cat .env", "cat ~/.codeden/install-token"],
      ]) {
        expect(levelAllows(level, commandRisk(texts, posix)), `${level}: ${texts}`).toBe(false);
      }
      for (const command of colonBound) {
        expect(levelAllows(level, commandRisk([command], win)), `${level}: ${command}`).toBe(false);
      }
      expect(
        levelAllows(level, patchRisk(["/home/me/.codeden/remote-access.json"], null, posix)),
        level,
      ).toBe(false);
      expect(
        levelAllows(
          level,
          permissionsRisk(
            { network: null, fileSystem: { read: [".env", "/home/me/.codeden"], write: null } },
            posix,
          ),
        ),
        level,
      ).toBe(false);
    }
    expect(levelAllows("full", commandRisk(["cat .env"], posix))).toBe(true);
  });
});

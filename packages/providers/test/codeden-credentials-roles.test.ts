import { describe, expect, it } from "vitest";
import { ClaudePolicy } from "../src/claude/permissions";
import { commandRisk, levelAllows } from "../src/codex/policy";
import { OpenCodePolicy, type PermissionCall } from "../src/opencode/policy";
import { classifyCommand, type RiskContext } from "../src/policy/risk";

/**
 * A search command's words keep the role the tool gives them (§11.2): an option's value is never
 * read as an option, however it looks (`rg -r-e`: the replacement text `-e`), and a PowerShell
 * list given as a search pattern stays data, element by element (`-Pattern .env,hello`), while a
 * list of files is checked element by element.
 */
const posix: RiskContext = {
  cwd: "/home/me/project",
  platform: "linux",
  home: "/home/me",
  tempRoots: ["/tmp"],
  codedenHome: "/home/me/.codeden",
  shell: "posix",
};
const win: RiskContext = {
  cwd: "C:\\Users\\me\\project",
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

/** Option values that look like options, before a credential file or a folder above it. */
const valueLookalikes = [
  // `-r` is ripgrep's replacement: `-e`, `--regexp` and `-g` here are its text.
  "rg '^' -r-e /home/me/.codeden/install-token",
  "rg '^' -r--regexp /home/me/.codeden/runner/runner.json",
  "rg '^' -r -e /home/me/.codeden/remote-access.json",
  "rg '^' --replace -e /home/me/.codeden/install-token",
  "rg '^' --replace=-e /home/me/.codeden/install-token",
  "grep . --label -e /home/me/.codeden/install-token",
  // Recursive roots.
  "rg '^' -r-e ~",
  "rg '^' -r-e $CODEDEN_HOME",
  "rg -r-g install-token . ~",
  "rg -r-g '*.ts' token ~",
];

describe("an option's value is never read as an option", () => {
  it("values that look like options don't hide the file or narrow a recursive search", () => {
    for (const cmd of valueLookalikes) {
      expect(action(cmd, posix), cmd).toBe("secrets");
      expect(guarded(cmd, posix), cmd).toBe(true);
    }
    for (const cmd of [
      "rg '^' -r-e C:\\Users\\me\\.codeden\\install-token",
      "rg '^' -r--regexp /c/Users/me/.codeden/runner/runner.json",
      "rg '^' -r-e C:\\Users\\me",
    ]) {
      expect(guarded(cmd, { ...win, shell: "posix" }), cmd).toBe(true);
    }
  });

  it("the same options over project files stay safe", () => {
    for (const cmd of [
      "rg '^' -r-e src",
      "rg '^' --replace -e README.md",
      "rg -r-g '*.ts' token src",
      "rg -e. -r-x src",
    ]) {
      expect(action(cmd, posix), cmd).toBeNull();
    }
  });

  it("asks at every level, refuses read-only roles, and Codex never approves it", () => {
    const opencode = (command: string): PermissionCall => ({
      request: { id: "p", sessionID: "s", action: "shell", resources: [command] },
      toolName: "bash",
      toolInput: { command },
    });
    for (const level of ["supervised", "auto", "full"] as const) {
      const claude = new ClaudePolicy(level, posix);
      const open = new OpenCodePolicy(level, posix);
      for (const command of valueLookalikes) {
        const label = `${level}: ${command}`;
        expect(claude.gate("Bash", { command }), label).toMatchObject({
          ask: true,
          action: "secrets",
        });
        expect(open.decide(opencode(command)), label).toMatchObject({
          kind: "ask",
          action: "secrets",
        });
      }
    }
    for (const level of ["auto", "full"] as const) {
      for (const command of valueLookalikes) {
        expect(levelAllows(level, commandRisk([command], posix)), `${level}: ${command}`).toBe(
          false,
        );
      }
    }
    for (const readOnly of [
      new ClaudePolicy("read_only", posix),
      new ClaudePolicy("full", posix, true),
    ]) {
      for (const command of valueLookalikes) {
        expect(readOnly.denial("Bash", { command }), command).toMatch(/off limits/);
      }
    }
    for (const readOnly of [
      new OpenCodePolicy("read_only", posix),
      new OpenCodePolicy("auto", posix, true),
    ]) {
      for (const command of valueLookalikes) {
        expect(readOnly.decide(opencode(command)), command).toMatchObject({ kind: "deny" });
      }
    }
  });
});

describe("a PowerShell list keeps its argument's role", () => {
  /** Lists given as the pattern: the files searched are ordinary. */
  const patternLists = [
    "Select-String -Pattern .env,hello -Path README.md",
    "Select-String -Pattern C:/Users/me/.codeden/install-token,hello -Path README.md",
    "Select-String -Pattern $env:CODEDEN_HOME\\install-token,hello -Path README.md",
    "Select-String -Pattern:.env,$env:CODEDEN_HOME\\runner\\runner.json README.md",
    "Select-String .env,hello README.md",
    "sls -pattern hello,.env -LiteralPath src\\a.ts",
    "grep -e .env,hello README.md",
    "rg -e $env:CODEDEN_HOME\\install-token,x src",
  ];

  it("a pattern list is data, ordinary or naming a credential file", () => {
    for (const shell of ["powershell", "auto"] as const) {
      for (const cmd of patternLists) {
        expect(action(cmd, { ...win, shell }), `${shell}: ${cmd}`).toBeNull();
      }
    }
  });

  it("a list of files is still checked element by element", () => {
    for (const shell of ["powershell", "auto"] as const) {
      const ctx = { ...win, shell };
      for (const cmd of [
        "Select-String -Pattern hello,x -Path README.md,$env:CODEDEN_HOME\\install-token",
        "Select-String -Pattern hello -Path:README.md,C:\\Users\\me\\.codeden\\runner\\runner.json",
        "Select-String hello,x README.md,$env:CODEDEN_HOME\\remote-access.json",
        "rg -e x README.md,$env:CODEDEN_HOME\\install-token",
      ]) {
        expect(guarded(cmd, ctx), `${shell}: ${cmd}`).toBe(true);
      }
      expect(action("Select-String -Pattern hello -Path README.md,.env", ctx)).toBe("secrets");
    }
  });

  it("no provider asks about or refuses a pattern list", () => {
    const opencode = (command: string): PermissionCall => ({
      request: { id: "p", sessionID: "s", action: "shell", resources: [command] },
      toolName: "bash",
      toolInput: { command },
    });
    for (const command of patternLists) {
      expect(new ClaudePolicy("auto", win).gate("PowerShell", { command }).ask, command).toBe(
        false,
      );
      expect(new OpenCodePolicy("auto", win).decide(opencode(command)), command).toEqual({
        kind: "allow",
      });
      expect(levelAllows("auto", commandRisk([command], win)), command).toBe(true);
      for (const readOnly of [
        new ClaudePolicy("read_only", win),
        new ClaudePolicy("full", win, true),
      ]) {
        expect(readOnly.denial("PowerShell", { command }) ?? "", command).not.toMatch(/off limits/);
      }
    }
  });
});

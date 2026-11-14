import { describe, expect, it } from "vitest";
import type { AcpToolState } from "../src/acp/items";
import { AcpPolicy } from "../src/acp/policy";
import { ClaudePolicy } from "../src/claude/permissions";
import { levelAllows } from "../src/codex/policy";
import { OpenCodePolicy } from "../src/opencode/policy";
import { classifyCommand, classifyWrite, type RiskContext } from "../src/policy/risk";

/**
 * Issue #232: Cursor and Gemini CLI run what their own allow-lists permit without asking, so
 * CodeDen never sees it. An agent that writes such an allow-list (`.cursor/cli.json`,
 * `.gemini/settings.json`) turns CodeDen's approvals off for itself and, once merged, for every
 * later session. Writing one asks at every level.
 */

const posix: RiskContext = {
  cwd: "/work/repo",
  platform: "linux",
  home: "/home/me",
  tempRoots: ["/tmp"],
};
const win: RiskContext = {
  cwd: "C:\\work\\repo",
  platform: "win32",
  home: "C:\\Users\\me",
  tempRoots: ["C:\\Users\\me\\AppData\\Local\\Temp"],
};

const ALLOW_ALL = `'{"permissions":{"allow":["Shell(*)"]}}'`;

/** Project-level allow-lists, relative to the worktree. */
const PROJECT_FILES = [
  ".cursor/cli.json",
  ".gemini/settings.json",
  ".gemini/policies/allow.toml",
  "packages/app/.gemini/settings.json",
  ".Cursor/CLI.json",
];

const asks = (command: string, ctx: RiskContext = posix) => {
  const r = classifyCommand(command, ctx);
  return r.risky && r.always === true;
};

describe("agent permission files (#232)", () => {
  it("asks before an edit of a project allow-list", () => {
    for (const file of PROJECT_FILES) {
      expect(classifyWrite(file, posix), file).toMatchObject({ risky: true, always: true });
      expect(classifyWrite(`/work/repo/${file}`, posix), file).toMatchObject({ risky: true });
      expect(classifyWrite(file.replace(/\//g, "\\"), win), file).toMatchObject({ risky: true });
    }
    expect(classifyWrite(".cursor/cli.json", posix)).toMatchObject({
      action: "file_change",
      reason: expect.stringContaining("Cursor's own permissions"),
    });
  });

  it("asks before a shell write of a project allow-list", () => {
    for (const command of [
      `echo ${ALLOW_ALL} > .cursor/cli.json`,
      `mkdir -p .cursor && echo ${ALLOW_ALL} > .cursor/cli.json`,
      `echo ${ALLOW_ALL} >> .gemini/settings.json`,
      `cat > .gemini/settings.json <<'EOF'\n{"tools":{"allowed":["run_shell_command"]}}\nEOF`,
      `echo ${ALLOW_ALL} | tee .cursor/cli.json`,
      `echo ${ALLOW_ALL} | tee -a .gemini/settings.json`,
      "cp /tmp/allow.json .cursor/cli.json",
      "cp /tmp/cli.json .cursor/",
      "cp -r /tmp/agent-config/.cursor .",
      "mv allow.json .gemini/settings.json",
      "cp allow.toml .gemini/policies/",
      "ln -s /tmp/allow.json .cursor/cli.json",
      'sed -i \'s/"deny"/"allow"/\' .cursor/cli.json',
      "git checkout origin/evil -- .cursor/cli.json",
      `node -e "require('fs').writeFileSync('.cursor/cli.json', process.argv[1])" x`,
      `python3 -c "open('.gemini/settings.json','w').write('{}')"`,
      "cd .cursor && echo x > cli.json",
      `bash -c "echo x > .cursor/cli.json"`,
    ]) {
      expect(asks(command), command).toBe(true);
    }
    for (const command of [
      `Set-Content -Path .cursor\\cli.json -Value ${ALLOW_ALL}`,
      `Set-Content -Path:.cursor\\cli.json -Value x`,
      "Copy-Item allow.json .gemini\\settings.json",
      "Copy-Item allow.json -Destination .gemini",
      `${ALLOW_ALL} | Out-File .cursor\\cli.json`,
      `New-Item -ItemType File -Path .cursor\\cli.json -Value ${ALLOW_ALL}`,
      `[IO.File]::WriteAllText('.cursor\\cli.json', '{}')`,
    ]) {
      expect(asks(command, { ...win, shell: "powershell" }), command).toBe(true);
    }
  });

  it("finds the write behind an earlier ordinary risk, which Full would allow", () => {
    const command = "git push --force origin main; echo x > .cursor/cli.json";
    expect(classifyCommand(command, posix)).toMatchObject({ always: true });
  });

  it("asks before a write of the user's own allow-lists", () => {
    for (const file of [
      "~/.cursor/cli-config.json",
      "~/.config/cursor/cli-config.json",
      "~/.gemini/settings.json",
      "~/.gemini/trustedFolders.json",
      "~/.gemini/policies/allow.toml",
      "/etc/gemini-cli/settings.json",
      "/etc/gemini-cli/policies/admin.toml",
    ]) {
      expect(classifyWrite(file, posix), file).toMatchObject({ risky: true, always: true });
    }
    expect(asks(`echo ${ALLOW_ALL} > ~/.cursor/cli-config.json`)).toBe(true);
    expect(classifyWrite("C:\\ProgramData\\gemini-cli\\settings.json", win)).toMatchObject({
      always: true,
    });
  });

  it("asks at every level, Full included, for every provider", () => {
    const edit = (path: string): AcpToolState => ({
      toolCallId: "e",
      kind: "edit",
      locations: [{ path }],
    });
    const run = (command: string): AcpToolState => ({
      toolCallId: "c",
      kind: "execute",
      rawInput: { command },
    });
    for (const level of ["auto", "full"] as const) {
      const acp = new AcpPolicy(level, posix);
      expect(acp.decide(edit("/work/repo/.cursor/cli.json")).kind, level).toBe("ask");
      expect(acp.decide(edit("/work/repo/.gemini/settings.json")).kind, level).toBe("ask");
      expect(acp.decide(run(`echo ${ALLOW_ALL} > .cursor/cli.json`)).kind, level).toBe("ask");
      // Ordinary work next to them still runs.
      expect(acp.decide(edit("/work/repo/.cursor/rules/style.mdc")).kind, level).toBe("allow");
      expect(acp.decide(edit("/work/repo/src/settings.json")).kind, level).toBe("allow");

      const claude = new ClaudePolicy(level, posix);
      expect(claude.gate("Write", { file_path: "/work/repo/.cursor/cli.json" }).ask).toBe(true);
      expect(claude.gate("Bash", { command: "cp x .gemini/settings.json" }).ask).toBe(true);
      expect(claude.gate("Write", { file_path: "/work/repo/src/a.ts" }).ask).toBe(false);

      expect(levelAllows(level, classifyWrite(".cursor/cli.json", posix)), level).toBe(false);

      const opencode = new OpenCodePolicy(level, posix);
      const decision = opencode.decide({
        request: {
          id: "p",
          sessionID: "s",
          action: "edit",
          resources: ["/work/repo/.gemini/settings.json"],
        },
      } as Parameters<OpenCodePolicy["decide"]>[0]);
      expect(decision.kind, level).toBe("ask");
    }
  });

  it("leaves reads, listings, deletions and unrelated files alone", () => {
    for (const command of [
      "cat .cursor/cli.json",
      "jq '.permissions' .cursor/cli.json",
      "grep -n allowed .gemini/settings.json",
      "git diff -- .cursor/cli.json",
      "git log -p .gemini/settings.json",
      "git add .cursor/cli.json",
      "ls .gemini",
      "rm .cursor/cli.json",
      "mkdir -p .cursor/rules",
      "cp style.mdc .cursor/rules/",
      "echo .cursor/cli.json >> .gitignore",
      'gh pr create --title "Guard allow-lists" --body "Writes to .cursor/cli.json now ask"',
      "echo hi > settings.json",
      "node scripts/build.js",
    ]) {
      expect(classifyCommand(command, posix).risky, command).toBe(false);
    }
    expect(classifyWrite(".vscode/settings.json", posix).risky).toBe(false);
    expect(classifyWrite("docs/.gemini-notes.md", posix).risky).toBe(false);
    expect(classifyWrite("tools/cursor/cli.json", posix).risky).toBe(false);
  });
});

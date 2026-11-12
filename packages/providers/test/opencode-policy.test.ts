import path from "node:path";
import type { AutonomyLevel } from "@codeden/contracts";
import { describe, expect, it } from "vitest";
import { OpenCodePolicy, type PermissionCall } from "../src/opencode/policy";

const cwd = path.resolve("/work/tree");
const ctx = { cwd, tempRoots: [path.resolve("/tmp")] };

const shell = (command: string): PermissionCall => ({
  request: { id: "p", sessionID: "s", action: "shell", resources: [command] },
  toolName: "shell",
  toolInput: { command },
});
const edit = (file: string): PermissionCall => ({
  request: { id: "p", sessionID: "s", action: "edit", resources: [file] },
  toolName: "edit",
  toolInput: { path: file },
});
const other = (action: string, resources: string[], toolName?: string): PermissionCall => ({
  request: { id: "p", sessionID: "s", action, resources },
  ...(toolName ? { toolName, toolInput: {} } : {}),
});

const policy = (level: AutonomyLevel, readOnly = false) => new OpenCodePolicy(level, ctx, readOnly);

describe("OpenCode policy", () => {
  it("auto: safe calls run, risky ones ask", () => {
    const p = policy("auto");
    expect(p.decide(shell("pnpm test"))).toEqual({ kind: "allow" });
    expect(p.decide(edit("src/a.ts"))).toEqual({ kind: "allow" });
    expect(p.decide(shell("git push --force origin main"))).toMatchObject({
      kind: "ask",
      action: "git_destructive",
    });
    expect(p.decide(edit(path.resolve("/etc/hosts")))).toMatchObject({
      kind: "ask",
      action: "outside_worktree",
    });
  });

  it("supervised: every edit and command asks, other calls run", () => {
    const p = policy("supervised");
    expect(p.decide(shell("ls"))).toMatchObject({ kind: "ask", action: "command" });
    expect(p.decide(edit("a.txt"))).toMatchObject({ kind: "ask", action: "file_change" });
    expect(p.decide(other("webfetch", ["https://example.com"]))).toEqual({ kind: "allow" });
  });

  it("full: only writes outside the worktree ask; secrets reads still ask", () => {
    const p = policy("full");
    expect(p.decide(shell("git push --force"))).toEqual({ kind: "allow" });
    expect(p.decide(edit(path.resolve("/etc/hosts")))).toMatchObject({
      action: "outside_worktree",
    });
    expect(p.decide(other("read", [".env"]))).toMatchObject({ kind: "ask", action: "secrets" });
  });

  it("read-only roles refuse edits and writing commands, allow read-only commands", () => {
    const p = policy("auto", true);
    expect(p.decide(edit("a.txt"))).toMatchObject({ kind: "deny" });
    expect(p.decide(shell("git status"))).toEqual({ kind: "allow" });
    expect(p.decide(shell("rm -rf build"))).toMatchObject({
      kind: "deny",
      message: expect.stringMatching(/read-only/),
    });
    // Checks are allowed for agents at the read_only level, not for read-only roles.
    expect(p.decide(shell("pnpm test"))).toMatchObject({ kind: "deny" });
    expect(policy("read_only").decide(shell("pnpm test"))).toEqual({ kind: "allow" });
  });

  it("external directories: reads run; writes wait for the edit ask that follows", () => {
    const p = policy("auto");
    expect(p.decide(other("external_directory", ["C:/elsewhere/*"], "read"))).toEqual({
      kind: "allow",
    });
    expect(p.decide(other("external_directory", ["C:/elsewhere/*"], "write"))).toEqual({
      kind: "allow",
    });
  });

  it("asks the user for actions only the user's own rules make ask", () => {
    expect(policy("full").decide(other("subagent", ["explore"]))).toMatchObject({
      kind: "ask",
      action: "tool",
    });
  });

  it("allow_session matches the exact command or path, for this policy only", () => {
    const p = policy("supervised");
    p.allowForSession(shell("pnpm lint"));
    expect(p.decide(shell("pnpm lint"))).toEqual({ kind: "allow" });
    expect(p.decide(shell("pnpm lint --fix"))).toMatchObject({ kind: "ask" });
    expect(policy("supervised").decide(shell("pnpm lint"))).toMatchObject({ kind: "ask" });
  });

  it("a remembered approval never outlives a switch to read-only", () => {
    const p = policy("supervised");
    p.allowForSession(edit("src/a.ts"));
    p.allowForSession(shell("git push origin main"));
    expect(p.decide(edit("src/a.ts"))).toEqual({ kind: "allow" });
    p.setAutonomy("read_only");
    expect(p.decide(edit("src/a.ts"))).toMatchObject({ kind: "deny" });
    expect(p.decide(shell("git push origin main"))).toMatchObject({ kind: "deny" });
    // Forgotten, not just suspended: back at supervised, the user is asked again.
    p.setAutonomy("supervised");
    expect(p.decide(edit("src/a.ts"))).toMatchObject({ kind: "ask" });
    // A read-only role never honours one either.
    const role = policy("auto", true);
    role.allowForSession(edit("src/a.ts"));
    expect(role.decide(edit("src/a.ts"))).toMatchObject({ kind: "deny" });
  });

  it("an autonomy change applies to the next decision", () => {
    const p = policy("auto");
    expect(p.decide(shell("ls"))).toEqual({ kind: "allow" });
    p.setAutonomy("supervised");
    expect(p.decide(shell("ls"))).toMatchObject({ kind: "ask" });
    p.setAutonomy("read_only");
    expect(p.decide(edit("a.txt"))).toMatchObject({ kind: "deny" });
  });
});

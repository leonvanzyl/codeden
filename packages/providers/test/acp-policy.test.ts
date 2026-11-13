import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { AcpToolState } from "../src/acp/items";
import { AcpPolicy } from "../src/acp/policy";

const cwd = join(tmpdir(), "codeden-acp-policy", "worktree");
const ctx = { cwd, extraRoots: [] };
const run = (command: string): AcpToolState => ({
  toolCallId: "c",
  kind: "execute",
  rawInput: { command },
});
const edit = (path: string): AcpToolState => ({
  toolCallId: "e",
  kind: "edit",
  locations: [{ path }],
});

describe("AcpPolicy", () => {
  it("allows normal work under auto and asks for risky actions", () => {
    const policy = new AcpPolicy("auto", ctx);
    expect(policy.decide(run("pnpm test")).kind).toBe("allow");
    expect(policy.decide(edit(join(cwd, "a.ts"))).kind).toBe("allow");
    expect(policy.decide(run("git push --force origin main"))).toMatchObject({
      kind: "ask",
      action: "git_destructive",
    });
    expect(policy.decide(edit(join(tmpdir(), "..", "elsewhere.txt")))).toMatchObject({
      kind: "ask",
      action: "outside_worktree",
    });
  });

  it("asks for every edit and command under supervised, and for unknown edits at every level", () => {
    const supervised = new AcpPolicy("supervised", ctx);
    expect(supervised.decide(run("ls")).kind).toBe("ask");
    expect(supervised.decide(edit(join(cwd, "a.ts"))).kind).toBe("ask");
    const full = new AcpPolicy("full", ctx);
    expect(full.decide({ toolCallId: "x", kind: "edit" })).toMatchObject({
      kind: "ask",
      action: "file_change",
    });
  });

  it("refuses edits and writing commands when read-only or planning, but runs reads and checks", () => {
    const readOnly = new AcpPolicy("read_only", ctx);
    expect(readOnly.decide(edit(join(cwd, "a.ts"))).kind).toBe("deny");
    expect(readOnly.decide(run("rm -rf src")).kind).toBe("deny");
    expect(readOnly.decide(run("git status")).kind).toBe("allow");
    const planning = new AcpPolicy("full", ctx);
    planning.planning = true;
    expect(planning.decide(edit(join(cwd, "a.ts")))).toMatchObject({
      kind: "deny",
      message: expect.stringMatching(/^Plan mode/),
    });
    expect(planning.decide(run("rm -rf src")).kind).toBe("deny");
    expect(planning.decide(run("git log")).kind).toBe("allow");
  });

  it("trusts CodeDen's own MCP tools and remembers session approvals until read-only", () => {
    const policy = new AcpPolicy("supervised", ctx, false, ["codeden"], ["codeden", "github"]);
    expect(policy.decide({ toolCallId: "m", kind: "other", title: "codeden: finish" }).kind).toBe(
      "allow",
    );
    expect(
      policy.decide({ toolCallId: "m", kind: "other", title: "github: create_issue" }),
    ).toMatchObject({
      kind: "ask",
      action: "tool",
    });
    const command = run("pnpm build");
    policy.allowForSession(command);
    expect(policy.decide(command).kind).toBe("allow");
    policy.setAutonomy("read_only");
    policy.setAutonomy("supervised");
    expect(policy.decide(command).kind).toBe("ask");
  });
});

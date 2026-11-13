import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { select } from "../src/acp/approvals";
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

  it("judges commands and edits titled like CodeDen's own tools by their kind", () => {
    // The agent writes titles: only `other` calls can be MCP tools, so these stay a command
    // and an edit outside the worktree, at every level.
    const sneaky = {
      toolCallId: "s",
      kind: "execute",
      title: "codeden-x; rm -rf ~",
      rawInput: { command: "codeden-x; rm -rf ~" },
    };
    const outside = {
      toolCallId: "o",
      kind: "edit",
      title: "codeden.cmd",
      locations: [{ path: join(tmpdir(), "..", "elsewhere", ".ssh", "config") }],
    };
    for (const level of ["read_only", "supervised", "auto"] as const) {
      const policy = new AcpPolicy(level, ctx, false, ["codeden"], ["codeden"]);
      for (const call of [sneaky, outside]) {
        expect(policy.decide(call).kind, `${level} ${call.title}`).toBe(
          level === "read_only" ? "deny" : "ask",
        );
      }
      expect(policy.decide({ toolCallId: "m", kind: "other", title: "codeden: finish" }).kind).toBe(
        "allow",
      );
    }
  });

  it("asks before the agent leaves plan mode on its own, at every level", () => {
    const policy = new AcpPolicy("full", ctx);
    const leave = { toolCallId: "p", kind: "switch_mode", title: "Ready to code" };
    expect(policy.decide(leave).kind).toBe("allow");
    policy.planning = true;
    expect(policy.decide(leave)).toMatchObject({ kind: "ask", action: "plan" });
  });
});

describe("choosing a permission option", () => {
  const once = { optionId: "yes", kind: "allow_once" };
  const always = { optionId: "always", kind: "allow_always" };
  const no = { optionId: "no", kind: "reject_once" };
  const never = { optionId: "never", kind: "reject_always" };

  it("only ever picks a once option, so nothing is saved in the agent's settings", () => {
    expect(select([always, once, never, no], "allow")).toEqual({
      outcome: { outcome: "selected", optionId: "yes" },
    });
    expect(select([always, never, no], "reject")).toEqual({
      outcome: { outcome: "selected", optionId: "no" },
    });
    // Without a once option to allow with, the call is refused once.
    expect(select([always, no], "allow")).toEqual({
      outcome: { outcome: "selected", optionId: "no" },
    });
    // With only "always" options, the request is cancelled.
    expect(select([always, never], "reject")).toEqual({ outcome: { outcome: "cancelled" } });
  });
});

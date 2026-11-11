import path from "node:path";
import type {
  CanUseTool,
  HookCallback,
  Options,
  PermissionMode,
  PermissionResult,
  Query,
} from "@anthropic-ai/claude-agent-sdk";
import type { AgentEvent, SessionOptions } from "@codeden/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { KEEP_PLANNING } from "../src/claude/plan-review";
import { ClaudeSession } from "../src/claude/session";

/**
 * A stand-in for the SDK's `query()`: records options and permission-mode changes, and lets a
 * test deliver SDK messages (`deliver`) as if the CLI sent them.
 */
function stubSdk() {
  const launches: Options[] = [];
  const modes: PermissionMode[] = [];
  let deliver: (message: unknown) => void = () => {};
  let exit = () => {};
  const query = ((params: { options: Options }) => {
    launches.push(params.options);
    const inbox: unknown[] = [];
    let wake = () => {};
    let ended = false;
    deliver = (message) => {
      inbox.push(message);
      wake();
    };
    exit = () => {
      ended = true;
      wake();
    };
    const q = {
      [Symbol.asyncIterator]: () => ({
        next: async () => {
          while (inbox.length === 0 && !ended) await new Promise<void>((r) => (wake = r));
          const value = inbox.shift();
          return value === undefined ? { done: true as const, value } : { done: false, value };
        },
      }),
      setPermissionMode: async (mode: PermissionMode) => {
        modes.push(mode);
      },
      interrupt: async () => undefined,
      supportedModels: async () => [],
      close: () => exit(),
    };
    return q as unknown as Query;
  }) as unknown as ConstructorParameters<typeof ClaudeSession>[1]["query"];
  return {
    query,
    launches,
    modes,
    deliver: (m: unknown) => deliver(m),
    exit: () => exit(),
  };
}

// A worktree outside the OS temp directory, and Claude's plans folder outside both.
const cwd = path.resolve(import.meta.dirname, "..");
const plans = path.join(path.parse(cwd).root, "claude-home", ".claude", "plans");

const base: SessionOptions = {
  sessionId: "s1",
  role: "agent",
  cwd,
  autonomy: "auto",
  mcpServers: [],
  additionalDirectories: [],
  planMode: true,
};

const sessions: ClaudeSession[] = [];
afterEach(async () => {
  await Promise.all(sessions.splice(0).map((s) => s.close()));
});

const settle = () => new Promise((r) => setTimeout(r, 20));

function open(sdk: ReturnType<typeof stubSdk>, opts: Partial<SessionOptions> = {}) {
  const events: AgentEvent[] = [];
  const session = new ClaudeSession(
    { ...base, ...opts },
    {
      executable: { kind: "native", path: "/bin/claude" } as never,
      query: sdk.query,
      notesRoots: [plans],
    },
  );
  sessions.push(session);
  void (async () => {
    for await (const e of session.events) events.push(e);
  })();
  const options = sdk.launches[0] as Options;
  const hook = options.hooks?.PreToolUse?.[0]?.hooks[0] as HookCallback;
  const canUseTool = options.canUseTool as CanUseTool;
  const preToolUse = async (tool: string, input: Record<string, unknown>) => {
    const out = (await hook(
      { hook_event_name: "PreToolUse", tool_name: tool, tool_input: input, cwd } as never,
      "t",
      { signal: new AbortController().signal },
    )) as { hookSpecificOutput?: { permissionDecision?: string } };
    return out.hookSpecificOutput?.permissionDecision ?? "none";
  };
  const permission = (tool: string, input: Record<string, unknown>, id: string) =>
    canUseTool(tool, input, {
      signal: new AbortController().signal,
      toolUseID: id,
      requestId: `r-${id}`,
    } as never) as Promise<PermissionResult>;
  const items = (kind: string) =>
    events.flatMap((e) =>
      (e.type === "item.started" || e.type === "item.completed") && e.item.kind === kind
        ? [e.item]
        : [],
    );
  const planUpdates = () =>
    events.filter((e) => e.type === "session.updated" && e.planMode !== undefined);
  return { session, events, preToolUse, permission, items, planUpdates };
}

const toolResult = (id: string) => ({
  type: "user",
  message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, content: "ok" }] },
});

const inWorktree = { file_path: path.join(cwd, "src", "x.ts"), content: "x" };
const planFile = { file_path: path.join(plans, "quiet-river.md"), content: "# Plan" };

describe("Claude plan mode", () => {
  it("starts in plan mode and stays there while the level changes", async () => {
    const sdk = stubSdk();
    const { session } = open(sdk, { autonomy: "full" });
    expect(sdk.launches[0]).toMatchObject({
      permissionMode: "plan",
      // So the session can switch to bypassPermissions once the plan is approved.
      allowDangerouslySkipPermissions: true,
    });
    await session.setAutonomy("supervised");
    expect(sdk.modes).toEqual([]);
  });

  it("refuses edits and writing commands while planning, even under Full", async () => {
    const sdk = stubSdk();
    const { session, preToolUse, permission } = open(sdk, { autonomy: "full" });
    expect(await preToolUse("Write", inWorktree)).toBe("deny");
    expect(await permission("Edit", { ...inWorktree, old_string: "a" }, "t1")).toMatchObject({
      behavior: "deny",
      message: expect.stringContaining("Plan mode"),
    });
    expect(await preToolUse("Bash", { command: "rm -rf src" })).toBe("deny");
    // Reading, checks and Claude's own plan file are fine.
    expect(await preToolUse("Bash", { command: "git status" })).toBe("none");
    expect(await preToolUse("Read", { file_path: inWorktree.file_path })).toBe("none");
    expect(await preToolUse("Write", planFile)).toBe("none");

    await session.setPlanMode(false);
    expect(sdk.modes).toEqual(["bypassPermissions"]);
    expect(await preToolUse("Write", inWorktree)).toBe("none");
    expect(await preToolUse("Bash", { command: "rm -rf src" })).toBe("none");
  });

  it("approving the plan continues at the session's permission level", async () => {
    const sdk = stubSdk();
    const { session, preToolUse, permission, items, planUpdates } = open(sdk);
    await session.send({ text: "plan it", attachments: [] });

    let result: PermissionResult | undefined;
    void permission("ExitPlanMode", { plan: "## Plan\n1. Change x" }, "p1").then((r) => {
      result = r;
    });
    await settle();
    expect(items("plan")).toMatchObject([{ kind: "plan", text: "## Plan\n1. Change x" }]);
    const [approval] = items("approval_request");
    expect(approval).toMatchObject({ action: "plan", options: ["allow_once", "deny"] });
    if (approval?.kind !== "approval_request") throw new Error("no approval");

    await session.respond(approval.requestId, { kind: "approval", decision: "allow_once" });
    await settle();
    expect(result).toMatchObject({
      behavior: "allow",
      updatedPermissions: [{ type: "setMode", mode: "acceptEdits", destination: "session" }],
    });
    expect(planUpdates()).toEqual([{ type: "session.updated", planMode: false }]);
    expect(await preToolUse("Write", inWorktree)).toBe("none");

    // Once ExitPlanMode has run, the level is set again in case the CLI chose its own mode.
    expect(sdk.modes).toEqual([]);
    sdk.deliver(toolResult("p1"));
    await settle();
    expect(sdk.modes).toEqual(["acceptEdits"]);
    // Out of plan mode, level changes reach the CLI again.
    await session.setAutonomy("supervised");
    expect(sdk.modes).toEqual(["acceptEdits", "default"]);
  });

  it("declining keeps it planning, with the user's feedback", async () => {
    const sdk = stubSdk();
    const { session, preToolUse, permission, items, planUpdates } = open(sdk);
    await session.send({ text: "plan it", attachments: [] });

    const first = permission("ExitPlanMode", { plan: "v1" }, "p1");
    await settle();
    const [approval] = items("approval_request");
    if (approval?.kind !== "approval_request") throw new Error("no approval");
    await session.respond(approval.requestId, {
      kind: "approval",
      decision: "deny",
      message: "Split step 2 in two",
    });
    expect(await first).toEqual({ behavior: "deny", message: "Split step 2 in two" });

    const second = permission("ExitPlanMode", { plan: "v2" }, "p2");
    await settle();
    const again = items("approval_request").at(-1);
    if (again?.kind !== "approval_request") throw new Error("no approval");
    await session.respond(again.requestId, { kind: "approval", decision: "deny" });
    expect(await second).toEqual({ behavior: "deny", message: KEEP_PLANNING });

    expect(planUpdates()).toEqual([]);
    expect(await preToolUse("Write", inWorktree)).toBe("deny");
    expect(sdk.modes).toEqual([]);
  });

  it("turns plan mode on and off live, and a restarted query keeps the current state", async () => {
    const sdk = stubSdk();
    const { session, preToolUse } = open(sdk, { planMode: false });
    expect(sdk.launches[0]?.permissionMode).toBe("acceptEdits");
    await session.setPlanMode(true);
    expect(sdk.modes).toEqual(["plan"]);
    expect(await preToolUse("Write", inWorktree)).toBe("deny");

    sdk.exit();
    await settle();
    await session.send({ text: "again", attachments: [] });
    expect(sdk.launches[1]?.permissionMode).toBe("plan");

    await session.setPlanMode(false);
    expect(sdk.modes).toEqual(["plan", "acceptEdits"]);
  });
});

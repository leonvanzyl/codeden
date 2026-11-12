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
import { ClaudeSession } from "../src/claude/session";

/** A stand-in for the SDK's `query()`: records options and permission-mode changes. */
function stubSdk(opts: { refuseBypass?: boolean } = {}) {
  const launches: Options[] = [];
  const modes: PermissionMode[] = [];
  /** Ends the latest query, as if the CLI exited. */
  let exit = () => {};
  const query = ((params: { options: Options }) => {
    launches.push(params.options);
    let finish = () => {};
    const done = new Promise<void>((resolve) => {
      finish = resolve;
    });
    exit = () => finish();
    const q = {
      // Yields no messages; the stream ends when the query is closed or exits.
      [Symbol.asyncIterator]: () => ({
        next: async () => {
          await done;
          return { done: true as const, value: undefined };
        },
      }),
      setPermissionMode: async (mode: PermissionMode) => {
        if (opts.refuseBypass && mode === "bypassPermissions") throw new Error("not allowed");
        modes.push(mode);
      },
      interrupt: async () => undefined,
      supportedModels: async () => [],
      supportedCommands: async () => [],
      close: () => finish(),
    };
    return q as unknown as Query;
  }) as unknown as ConstructorParameters<typeof ClaudeSession>[1]["query"];
  return { query, launches, modes, exit: () => exit() };
}

// A worktree outside the OS temp directory, and a file outside both.
const cwd = path.resolve(import.meta.dirname, "..");
const outside = path.join(path.parse(cwd).root, "codeden-outside", "x.txt");

const base: SessionOptions = {
  sessionId: "s1",
  role: "agent",
  cwd,
  autonomy: "auto",
  mcpServers: [],
  additionalDirectories: [],
  planMode: false,
};

const sessions: ClaudeSession[] = [];
afterEach(async () => {
  await Promise.all(sessions.splice(0).map((s) => s.close()));
});

function open(sdk: ReturnType<typeof stubSdk>, opts: Partial<SessionOptions> = {}) {
  const events: AgentEvent[] = [];
  const session = new ClaudeSession(
    { ...base, ...opts },
    { executable: { kind: "native", path: "/bin/claude" } as never, query: sdk.query },
  );
  sessions.push(session);
  void (async () => {
    for await (const e of session.events) events.push(e);
  })();
  const options = sdk.launches[0] as Options;
  const hook = options.hooks?.PreToolUse?.[0]?.hooks[0] as HookCallback;
  const canUseTool = options.canUseTool as CanUseTool;
  let n = 0;
  const preToolUse = async (tool: string, input: Record<string, unknown>) => {
    const out = (await hook(
      {
        hook_event_name: "PreToolUse",
        tool_name: tool,
        tool_input: input,
        tool_use_id: `t${++n}`,
        session_id: "x",
        transcript_path: "x",
        cwd,
      } as never,
      `t${n}`,
      { signal: new AbortController().signal },
    )) as { hookSpecificOutput?: { permissionDecision?: string } };
    return out.hookSpecificOutput?.permissionDecision ?? "none";
  };
  const permission = (tool: string, input: Record<string, unknown>) => {
    n += 1;
    return canUseTool(tool, input, {
      signal: new AbortController().signal,
      toolUseID: `t${n}`,
      requestId: `r${n}`,
    } as never) as Promise<PermissionResult>;
  };
  const approvals = () =>
    events.filter((e) => e.type === "item.started" && e.item.kind === "approval_request");
  return { session, preToolUse, permission, approvals };
}

const settle = () => new Promise((r) => setTimeout(r, 20));
const forcePush = { command: "git push --force" };
const writeOutside = { file_path: outside, content: "x" };

describe("Claude autonomy changes on a live session", () => {
  it("stops asking for in-worktree risky actions after a switch to full", async () => {
    const sdk = stubSdk();
    const { session, preToolUse, permission, approvals } = open(sdk);
    await session.send({ text: "go", attachments: [] });

    expect(await preToolUse("Bash", forcePush)).toBe("ask");
    await session.setAutonomy("full");
    expect(sdk.modes).toEqual(["bypassPermissions"]);
    expect(await preToolUse("Bash", forcePush)).toBe("none");
    expect(await permission("Bash", forcePush)).toMatchObject({ behavior: "allow" });
    expect(approvals()).toHaveLength(0);

    // Writes outside the worktree and temp still ask.
    expect(await preToolUse("Write", writeOutside)).toBe("ask");
    void permission("Write", writeOutside);
    await settle();
    expect(approvals()).toHaveLength(1);
    expect(approvals()[0]).toMatchObject({ item: { action: "outside_worktree" } });
  });

  it("keeps approvals that were already waiting, and asks for nothing new", async () => {
    const sdk = stubSdk();
    const { session, permission, approvals } = open(sdk);
    await session.send({ text: "go", attachments: [] });

    let answered: PermissionResult | undefined;
    void permission("Bash", forcePush).then((r) => {
      answered = r;
    });
    await settle();
    expect(approvals()).toHaveLength(1);

    await session.setAutonomy("full");
    await settle();
    expect(answered).toBeUndefined();
    expect(await permission("Bash", { command: "git push -f origin main" })).toMatchObject({
      behavior: "allow",
    });
    expect(approvals()).toHaveLength(1);

    const first = approvals()[0];
    if (first?.type !== "item.started" || first.item.kind !== "approval_request") throw new Error();
    await session.respond(first.item.requestId, { kind: "approval", decision: "allow_once" });
    await settle();
    expect(answered).toMatchObject({ behavior: "allow" });
  });

  it("tightens too: supervised asks for every command from the next call", async () => {
    const sdk = stubSdk();
    const { session, preToolUse } = open(sdk, { autonomy: "full" });
    expect(await preToolUse("Bash", { command: "ls" })).toBe("none");
    await session.setAutonomy("supervised");
    expect(sdk.modes).toEqual(["default"]);
    expect(await preToolUse("Bash", { command: "ls" })).toBe("ask");
  });

  it("falls back to acceptEdits when the CLI refuses bypassPermissions", async () => {
    const sdk = stubSdk({ refuseBypass: true });
    const { session, preToolUse } = open(sdk);
    await session.setAutonomy("full");
    expect(sdk.modes).toEqual(["acceptEdits"]);
    // CodeDen's policy still follows the new level.
    expect(await preToolUse("Bash", forcePush)).toBe("none");
  });

  it("leaves plan mode alone and starts a restarted query with the new level", async () => {
    const sdk = stubSdk();
    const { session } = open(sdk, { planMode: true });
    await session.setAutonomy("full");
    expect(sdk.modes).toEqual([]);

    const plain = stubSdk();
    const fresh = open(plain);
    expect(plain.launches[0]?.permissionMode).toBe("acceptEdits");
    await fresh.session.setAutonomy("full");
    plain.exit();
    await settle();
    await fresh.session.send({ text: "again", attachments: [] });
    expect(plain.launches).toHaveLength(2);
    expect(plain.launches[1]).toMatchObject({ permissionMode: "bypassPermissions" });
  });
});

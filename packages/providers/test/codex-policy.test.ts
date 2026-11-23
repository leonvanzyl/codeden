import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentEvent, type AutonomyLevel, type SessionOptions } from "@codeden/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { ApprovalBroker } from "../src/approvals";
import { handleServerRequest } from "../src/codex/approvals";
import { codexPolicy } from "../src/codex/config";
import type { ServerRequest } from "../src/codex/protocol";
import { CodexSession } from "../src/codex/session";

const T = "thread-x";
const TURN = "turn-1";
const risk = { cwd: "/w", platform: "linux" as const, home: "/home/me", tempRoots: ["/tmp"] };

const command = (cmd: string, extra: Record<string, unknown> = {}) => ({
  method: "item/commandExecution/requestApproval",
  id: 0,
  params: {
    threadId: T,
    turnId: TURN,
    itemId: "c1",
    command: cmd,
    cwd: "/w",
    startedAtMs: 1,
    environmentId: null,
    ...extra,
  },
});

/** Run one request at `autonomy`; a request that reaches the user is answered with `answer`. */
async function decide(req: object, autonomy: AutonomyLevel, paths: string[] = ["/w/a.ts"]) {
  const events: AgentEvent[] = [];
  const broker = new ApprovalBroker((e) => events.push(AgentEvent.parse(e)));
  const pending = handleServerRequest(req as ServerRequest, {
    broker,
    risk,
    autonomy: () => autonomy,
    ctx: () => ({ threadId: "s1:root", turnId: TURN }),
    filePaths: () => paths,
  });
  const started = events.find((e) => e.type === "item.started");
  if (started && "requestId" in started.item) {
    broker.respond(started.item.requestId, { kind: "approval", decision: "deny" });
  }
  return { result: await pending, events, asked: started !== undefined };
}

describe("Codex requests under CodeDen's policy (§11.2)", () => {
  it("approves what Auto allows by policy, and records it", async () => {
    for (const cmd of [
      "git add -A && git commit -m 'feat: x'",
      "pnpm install",
      "git push -u origin HEAD",
      "npm ci && npm test",
      "curl -s http://localhost:3000/health",
    ]) {
      const { result, events, asked } = await decide(command(cmd), "auto");
      expect(result, cmd).toEqual({ decision: "accept" });
      expect(asked, cmd).toBe(false);
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        type: "item.completed",
        item: {
          kind: "approval_request",
          status: "completed",
          decision: "allow_once",
          decidedBy: "policy",
          command: cmd,
        },
      });
    }
  });

  it("asks the user for what Auto flags as risky, with the classifier's reason", async () => {
    for (const [cmd, action] of [
      ["git push --force origin main", "git_destructive"],
      ["rm -rf /home/me/projects", "outside_worktree"],
      ["cat .env", "secrets"],
      ["npm install -g typescript", "other"],
    ] as const) {
      const { result, events, asked } = await decide(command(cmd), "auto");
      expect(asked, cmd).toBe(true);
      expect(result, cmd).toEqual({ decision: "decline" });
      expect(events[0], cmd).toMatchObject({ type: "item.started", item: { action } });
      expect(events[1], cmd).toMatchObject({ item: { decidedBy: "user" } });
    }
  });

  it("checks the command as sent as well as Codex's parsed actions", async () => {
    const { asked } = await decide(
      command("bash -lc 'ls && echo x > /etc/profile'", {
        commandActions: [{ type: "listFiles", command: "ls", path: null }],
      }),
      "auto",
    );
    expect(asked).toBe(true);
  });

  it("under Full asks only for writes outside the worktree", async () => {
    for (const cmd of ["git push --force origin main", "cat .env", "npm i -g x"]) {
      expect((await decide(command(cmd), "full")).asked, cmd).toBe(false);
    }
    expect((await decide(command("rm -rf /home/me/projects"), "full")).asked).toBe(true);
  });

  it("resolves relative paths from the command's working directory, never past the worktree", async () => {
    const at = (cwd: string, cmd: string) => command(cmd, { cwd });
    for (const level of ["auto", "full"] as const) {
      // `../proof.log` from `/w/frontend` is `/w/proof.log`, inside the worktree (#589).
      expect((await decide(at("/w/frontend", "echo ok > ../proof.log"), level)).asked).toBe(false);
      expect((await decide(at("/w/frontend", "echo ok > ../../x.log"), level)).asked).toBe(true);
      // A working directory outside the worktree doesn't widen it.
      expect((await decide(at("/elsewhere", "echo ok > proof.log"), level)).asked).toBe(true);
    }
  });

  it("asks for everything under Supervised and Read-only", async () => {
    for (const level of ["supervised", "read_only"] as const) {
      expect((await decide(command("pnpm test"), level)).asked, level).toBe(true);
    }
  });

  it("approves patches and permissions inside the worktree, and asks outside it", async () => {
    const patch = (grantRoot?: string) => ({
      method: "item/fileChange/requestApproval",
      id: 1,
      params: { threadId: T, turnId: TURN, itemId: "p1", startedAtMs: 1, grantRoot },
    });
    expect(await decide(patch(), "auto")).toMatchObject({
      result: { decision: "accept" },
      asked: false,
    });
    expect((await decide(patch(), "auto", ["/w/.git/hooks/pre-commit", "/tmp/x"])).asked).toBe(
      false,
    );
    expect((await decide(patch("/home/me"), "auto")).asked).toBe(true);
    expect((await decide(patch(), "full", ["/home/me/.bashrc"])).asked).toBe(true);
    expect((await decide(patch(), "full", [])).asked).toBe(true);

    const permissions = (p: object) => ({
      method: "item/permissions/requestApproval",
      id: 2,
      params: {
        threadId: T,
        turnId: TURN,
        itemId: "q1",
        startedAtMs: 1,
        environmentId: null,
        cwd: "/w",
        reason: null,
        permissions: p,
      },
    });
    expect(
      await decide(permissions({ network: { enabled: true }, fileSystem: null }), "auto"),
    ).toMatchObject({
      result: { permissions: { network: { enabled: true } }, scope: "turn" },
      asked: false,
    });
    expect(
      (
        await decide(
          permissions({ network: null, fileSystem: { read: null, write: ["/w/build"] } }),
          "auto",
        )
      ).asked,
    ).toBe(false);
    expect(
      (
        await decide(
          permissions({ network: null, fileSystem: { read: null, write: ["/etc"] } }),
          "auto",
        )
      ).asked,
    ).toBe(true);
    expect(
      (
        await decide(
          permissions({
            network: null,
            fileSystem: {
              read: null,
              write: null,
              entries: [{ path: { type: "glob_pattern", pattern: "**" }, access: "write" }],
            },
          }),
          "full",
        )
      ).asked,
    ).toBe(true);
  });

  it("puts Full on on-request, so escalations reach the policy instead of failing", () => {
    expect(codexPolicy("full")).toEqual({
      approvalPolicy: "on-request",
      sandbox: "workspace-write",
      networkAccess: true,
    });
    expect(codexPolicy("auto").networkAccess).toBe(false);
  });
});

describe("Codex policy with the app-server (fake)", () => {
  const fakeCodex = {
    kind: "node-script" as const,
    path: process.execPath,
    script: join(import.meta.dirname, "fixtures", "fake-codex", "app-server.mjs"),
  };
  const sessions: CodexSession[] = [];
  afterEach(async () => {
    await Promise.all(sessions.splice(0).map((s) => s.close()));
    delete process.env.FAKE_CODEX_LOG;
    delete process.env.FAKE_CODEX_REQUESTS;
  });

  it("approves a commit and an install by policy and asks the user for a force push", async () => {
    const dir = mkdtempSync(join(tmpdir(), "codeden-codex-policy-"));
    const log = join(dir, "requests.log");
    const script = join(dir, "requests.json");
    const cwd = join(dir, "wt");
    mkdirSync(cwd);
    const approval = (cmd: string) => ({
      method: "item/commandExecution/requestApproval",
      params: { command: cmd, cwd, reason: "needs to write .git" },
    });
    writeFileSync(
      script,
      JSON.stringify([
        approval("git add -A && git commit -m 'feat: x'"),
        approval("pnpm install"),
        {
          method: "item/started",
          notify: true,
          params: {
            item: {
              type: "fileChange",
              id: "patch-1",
              status: "inProgress",
              changes: [
                {
                  path: join(cwd, "src", "a.ts"),
                  kind: { type: "update", move_path: null },
                  diff: "",
                },
              ],
            },
          },
        },
        { method: "item/fileChange/requestApproval", params: { itemId: "patch-1" } },
        approval("git push --force origin main"),
      ]),
    );
    process.env.FAKE_CODEX_LOG = log;
    process.env.FAKE_CODEX_REQUESTS = script;
    const opts: SessionOptions = {
      sessionId: "s1",
      role: "agent",
      cwd,
      autonomy: "auto",
      mcpServers: [],
      additionalDirectories: [],
      planMode: false,
    };
    const session = new CodexSession(opts, { executable: fakeCodex });
    sessions.push(session);
    const events: AgentEvent[] = [];
    let done = false;
    void (async () => {
      for await (const e of session.events as AsyncIterable<AgentEvent>) {
        events.push(e);
        if (e.type === "item.started" && e.item.kind === "approval_request") {
          await session.respond(e.item.requestId, { kind: "approval", decision: "deny" });
        }
        if (e.type === "turn.completed") done = true;
      }
    })();
    await session.start();
    await session.send({ text: "go", attachments: [] });
    const deadline = Date.now() + 10_000;
    while (!done) {
      if (Date.now() > deadline) throw new Error("turn did not complete");
      await new Promise((r) => setTimeout(r, 20));
    }
    const answers = (existsSync(log) ? readFileSync(log, "utf8").trim().split("\n") : [])
      .map((line) => JSON.parse(line) as { method: string; params: unknown })
      .filter((r) => r.method.startsWith("answer:"))
      .map((r) => r.params);
    expect(answers).toEqual([
      { decision: "accept" },
      { decision: "accept" },
      { decision: "accept" },
      { decision: "decline" },
    ]);
    const approvals = events.filter(
      (e) =>
        (e.type === "item.started" || e.type === "item.completed") &&
        e.item.kind === "approval_request",
    );
    expect(
      approvals.map((e) => [e.type, (e as { item: { decidedBy?: string } }).item.decidedBy]),
    ).toEqual([
      ["item.completed", "policy"],
      ["item.completed", "policy"],
      ["item.completed", "policy"],
      ["item.started", undefined],
      ["item.completed", "user"],
    ]);
  });
});

import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  CheckpointList,
  DiffResult,
  GitStatusResponse,
  RestoreFilesResponse,
  TERMINAL_CONTROL_PREFIX,
  TerminalServerMessage,
} from "@codeden/contracts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { type Harness, startHarness, TOKEN, waitUntil } from "./support/harness";

let h: Harness;
let sessionId: string;
let worktree: string;

beforeAll(async () => {
  h = await startHarness();
  sessionId = await h.startFakeSession();
  worktree = (await h.detail(sessionId)).session.worktreePath ?? "";
}, 60_000);

afterAll(async () => {
  await h?.close();
});

const checkpoints = async () =>
  CheckpointList.parse((await h.api("GET", `/sessions/${sessionId}/checkpoints`)).body).checkpoints;

describe("checkpoints, diffs and git", () => {
  it("diffs a turn, the whole session and uncommitted changes", async () => {
    expect(worktree).toBeTruthy();
    await waitUntil(async () => ((await checkpoints()).length >= 2 ? true : undefined));
    writeFileSync(join(worktree, "hello.txt"), "hi\n");
    await h.api("POST", `/sessions/${sessionId}/messages`, { input: { text: "again" } });
    const cps = await waitUntil(async () => {
      const list = await checkpoints();
      return list.length >= 3 ? list : undefined;
    });
    const turnId = cps.at(-1)?.turnId;
    expect(turnId).toBeTruthy();

    const turn = DiffResult.parse(
      (await h.api("POST", `/sessions/${sessionId}/diff`, { kind: "turn", turnId })).body,
    );
    expect(turn.files).toEqual([
      expect.objectContaining({ path: "hello.txt", change: "add", additions: 1 }),
    ]);
    expect(turn.files[0]?.patch).toContain("+hi");
    expect(turn.turns.map((t) => t.id)).toContain(turnId);

    const session = DiffResult.parse(
      (await h.api("POST", `/sessions/${sessionId}/diff`, { kind: "session" })).body,
    );
    expect(session.files.map((f) => f.path)).toEqual(["hello.txt"]);
    const uncommitted = DiffResult.parse(
      (await h.api("POST", `/sessions/${sessionId}/diff`, { kind: "uncommitted" })).body,
    );
    expect(uncommitted.files.map((f) => f.path)).toEqual(["hello.txt"]);

    const status = GitStatusResponse.parse(
      (await h.api("GET", `/sessions/${sessionId}/git/status`)).body,
    );
    expect(status.files.map((f) => f.path)).toContain("hello.txt");

    const restored = RestoreFilesResponse.parse(
      (await h.api("POST", `/sessions/${sessionId}/restore`, { turnId })).body,
    );
    expect(restored.deleted).toEqual(["hello.txt"]);
    expect(existsSync(join(worktree, "hello.txt"))).toBe(false);
  }, 60_000);

  it("commits in the worktree and reports push failures", async () => {
    writeFileSync(join(worktree, "notes.md"), "notes\n");
    const commit = await h.api("POST", `/sessions/${sessionId}/git/commit`, {
      message: "Add notes",
    });
    expect(commit.status).toBe(200);
    expect((commit.body as { commit: string }).commit).toMatch(/^[0-9a-f]{40}$/);
    const push = await h.api("POST", `/sessions/${sessionId}/git/push`, {});
    expect(push.status).toBeGreaterThanOrEqual(400);
  });

  it("rejects unknown sessions and bad scopes", async () => {
    expect((await h.api("POST", "/sessions/nope/diff", { kind: "session" })).status).toBe(404);
    expect((await h.api("POST", `/sessions/${sessionId}/diff`, { kind: "x" })).status).toBe(400);
  });
});

describe("terminal channel", () => {
  it("opens a terminal in the session worktree, streams output and kills it", async () => {
    const url = `${h.server.url.replace("http", "ws")}/ws/pty?sessionId=${sessionId}&cols=100&rows=20`;
    const ws = new WebSocket(url, { headers: { authorization: `Bearer ${TOKEN}` } });
    let output = "";
    const controls: TerminalServerMessage[] = [];
    ws.on("message", (data) => {
      const text = data.toString();
      if (text.startsWith(TERMINAL_CONTROL_PREFIX)) {
        controls.push(TerminalServerMessage.parse(JSON.parse(text.slice(1))));
      } else output += text;
    });
    await new Promise((resolve, reject) => {
      ws.once("open", resolve);
      ws.once("error", reject);
    });
    await waitUntil(() => controls.some((c) => c.type === "opened"));
    ws.send(JSON.stringify({ type: "resize", cols: 120, rows: 30 }));
    ws.send(JSON.stringify({ type: "input", data: "echo codeden-ready\r" }));
    // The echoed output line (not the typed command) starts with the text, once ANSI is gone.
    const ansi = new RegExp(
      `${"\u001b"}\\[[0-9;?]*[ -/]*[@-~]|${"\u001b"}\\][^${"\u0007"}]*${"\u0007"}`,
      "g",
    );
    // bash with bracketed paste emits `ESC[?2004l\r` before the command's output, so allow
    // carriage returns at the start of the line.
    await waitUntil(() => /(^|\n)\r*codeden-ready\r?\n/.test(output.replace(ansi, "")));
    ws.send(JSON.stringify({ type: "kill" }));
    await waitUntil(() => controls.some((c) => c.type === "exited"));
    ws.close();
  });

  it("needs the install token", async () => {
    const ws = new WebSocket(`${h.server.url.replace("http", "ws")}/ws/pty`);
    const status = await new Promise<number>((resolve) => {
      ws.on("unexpected-response", (_req, res) => resolve(res.statusCode ?? 0));
      ws.on("open", () => resolve(101));
    });
    expect(status).toBe(401);
  });
});

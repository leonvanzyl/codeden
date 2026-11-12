import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CreateProjectResponse,
  type InboxItem,
  InboxItem as InboxItemSchema,
  type ItemRecord,
  SessionDetail,
  StartSessionResponse,
  type TranscriptMessage,
  type UiServerMessage,
} from "@codeden/contracts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { isProcessAlive, type RunningServer, readLiveRunnerLock, startServer } from "../src";
import { removeTree } from "./support/remove-tree";
import { TestWsClient } from "./support/ws-client";

const TOKEN = "f".repeat(64);
let home: string;
let repo: string;
let server: RunningServer;
let ws: TestWsClient;
let projectId: string;

const headers = { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" };
const api = async (method: string, path: string, body?: unknown) => {
  const res = await fetch(`${server.url}/api${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as unknown };
};

async function waitUntil<T>(probe: () => Promise<T | undefined>, timeoutMs = 20_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await probe();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 50));
  }
}

const detail = async (id: string) =>
  SessionDetail.parse((await api("GET", `/sessions/${id}`)).body);
const statusIs = (id: string, ...statuses: string[]) =>
  waitUntil(async () => {
    const d = await detail(id);
    return statuses.includes(d.session.status) ? d : undefined;
  });
const openInbox = async (sessionId: string) =>
  ((await api("GET", `/inbox?sessionId=${sessionId}`)).body as unknown[]).map((i) =>
    InboxItemSchema.parse(i),
  );

const git = (...args: string[]) => execFileSync("git", ["-C", repo, ...args], { stdio: "pipe" });

beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), "codeden-flow-"));
  repo = join(home, "repo");
  mkdirSync(repo);
  git("init", "-q", "-b", "main");
  git("config", "user.email", "test@example.com");
  git("config", "user.name", "Test");
  writeFileSync(join(repo, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
  git("add", ".");
  git("commit", "-q", "-m", "init");

  server = await startServer({
    port: 0,
    dataDir: join(home, "data"),
    token: TOKEN,
    enableFakeProvider: true,
    waitForRunner: true,
    secrets: "memory",
    checkSetupOnStart: false,
    userHome: home,
    realtimeFlushMs: 10,
  });
  ws = await TestWsClient.connect(server.url, TOKEN);
});

afterAll(async () => {
  ws?.close();
  const lock = server ? readLiveRunnerLock(server.paths.runnerLock) : undefined;
  await server?.close({ stopRunner: true });
  // The runner exits shortly after; Windows keeps its folders locked until then.
  const deadline = Date.now() + 10_000;
  while (lock && isProcessAlive(lock.pid) && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 50));
  }
  await removeTree(home);
});

describe("project -> Fake session through a real runner", () => {
  it("adds a local git folder as a project", async () => {
    const res = await api("POST", "/projects", { source: { type: "local", path: repo } });
    expect(res.status).toBe(201);
    const created = CreateProjectResponse.parse(res.body);
    expect(created.project).toMatchObject({ kind: "local", defaultBranch: "main" });
    expect(created.detected).toMatchObject({ isGitRepo: true, packageManager: "pnpm" });
    projectId = created.project.id;
    const again = await api("POST", "/projects", { source: { type: "local", path: repo } });
    expect(again.status).toBe(409);
  });

  it("streams a session, routes its approval through the inbox, then goes idle", async () => {
    ws.send({ type: "subscribe", fromSeq: server.store.headSeq(), agentEvents: false });
    const res = await api("POST", "/sessions", {
      projectId,
      provider: "fake",
      purpose: "Say hello",
      input: { text: "hello [approval]" },
    });
    const started = StartSessionResponse.parse(res.body);
    expect(started.status).toBe("started");
    if (started.status !== "started") return;
    const id = started.sessionId;
    ws.send({ type: "watch_session", sessionId: id, fromSeq: 0 });

    // The approval becomes an inbox item and the session waits on it.
    await statusIs(id, "waiting");
    const [approval] = await openInbox(id);
    expect(approval).toMatchObject({ kind: "approval", status: "open", projectId });
    await ws.waitFor(
      (m) => m.type === "events" && m.events.some((e) => e.type === "inbox.created"),
    );

    const resolved = await api("POST", `/inbox/${(approval as InboxItem).id}/resolve`, {
      response: { kind: "approval", decision: "allow_once" },
    });
    expect(resolved.status).toBe(200);
    expect(InboxItemSchema.parse(resolved.body).status).toBe("resolved");

    const done = await statusIs(id, "idle");
    expect(done.followups?.suggestions.length).toBeGreaterThan(0);
    expect(done.usage).toMatchObject({ outputTokens: 42 });
    expect(done.session.resumeToken).toBe(`fake-${id}`);
    // Until the runner creates worktrees, CodeDen falls back to the repo root and says so.
    if (done.session.worktreePath === null) {
      expect(done.startMeta?.workspaceFallback).toBeTruthy();
      expect(done.session.cwd).toBe(server.services.projects.get(projectId).path);
    }

    // Transcript items arrived over the websocket.
    const items = new Map<string, ItemRecord>();
    await ws.waitFor((m) => {
      if (m.type === "transcript" && m.sessionId === id) {
        for (const r of (m as TranscriptMessage).items) items.set(r.item.id, r);
      }
      return [...items.values()].some((r) => r.item.kind === "followups");
    });
    const kinds = [...items.values()].map((r) => r.item.kind);
    expect(kinds).toEqual(
      expect.arrayContaining(["user_message", "assistant_message", "tool_call"]),
    );
    const reply = [...items.values()].find((r) => r.item.kind === "assistant_message")?.item;
    expect(reply?.kind === "assistant_message" && reply.text).toBe("Echo: hello [approval]");

    // Domain-only subscription: session updates arrive, agent events do not.
    const seen = ws.messages.flatMap((m: UiServerMessage) => (m.type === "events" ? m.events : []));
    expect(seen.some((e) => e.type === "session.updated")).toBe(true);
    expect(seen.some((e) => e.type.startsWith("agent."))).toBe(false);

    // Paginated transcript and lazy tool output.
    const root = done.session.rootThreadId as string;
    const page = await api(
      "GET",
      `/sessions/${id}/threads/${encodeURIComponent(root)}/items?limit=2`,
    );
    const body = page.body as { items: ItemRecord[]; hasMoreBefore: boolean };
    expect(body.items).toHaveLength(2);
    expect(body.hasMoreBefore).toBe(true);
    const tool = [...items.values()].find((r) => r.item.kind === "tool_call");
    const output = await api("GET", `/sessions/${id}/items/${tool?.item.id}/output`);
    expect(output.body).toMatchObject({
      text: "hello\n",
      totalBytes: 6,
      truncated: false,
      outputBytes: 6,
    });

    // Follow-up message in the same session.
    const sent = await api("POST", `/sessions/${id}/messages`, { input: { text: "again" } });
    expect(sent.body).toEqual({ status: "sent" });
    await statusIs(id, "idle");
  });

  it("detects duplicate work and honours wait, skip and force", async () => {
    const first = StartSessionResponse.parse(
      (
        await api("POST", "/sessions", {
          projectId,
          provider: "fake",
          workKey: "issue:7",
          input: { text: "fix it [approval]" },
        })
      ).body,
    );
    if (first.status !== "started") throw new Error("expected started");
    await statusIs(first.sessionId, "waiting");

    const dup = { projectId, provider: "fake", workKey: "issue:7", input: { text: "fix it too" } };
    const conflict = await api("POST", "/sessions", dup);
    expect(conflict.status).toBe(409);
    const parsed = StartSessionResponse.parse(conflict.body);
    expect(parsed.status === "conflict" && parsed.existing[0]?.sessionId).toBe(first.sessionId);

    expect(
      (await api("POST", "/sessions", { ...dup, conflict: { resolution: "skip" } })).body,
    ).toEqual({
      status: "skipped",
    });

    const forced = StartSessionResponse.parse(
      (
        await api("POST", "/sessions", {
          ...dup,
          conflict: { resolution: "force", reason: "urgent" },
        })
      ).body,
    );
    if (forced.status !== "started") throw new Error("expected started");
    expect((await detail(forced.sessionId)).startMeta?.forced).toMatchObject({
      reason: "urgent",
      conflictsWith: expect.arrayContaining([first.sessionId]),
    });

    const queued = StartSessionResponse.parse(
      (
        await api("POST", "/sessions", {
          ...dup,
          conflict: { resolution: "wait", behindId: first.sessionId },
        })
      ).body,
    );
    if (queued.status !== "queued") throw new Error("expected queued");
    expect((await detail(queued.sessionId)).session.status).toBe("queued");

    // Stopping the blockers lets the queued session start on its own.
    await api("POST", `/sessions/${forced.sessionId}/stop`);
    const stopped = SessionDetail.parse((await api("GET", `/sessions/${first.sessionId}`)).body);
    expect(stopped.session.status).toBe("waiting");
    await api("POST", `/sessions/${first.sessionId}/stop`);
    expect((await openInbox(first.sessionId)).length).toBe(0);
    const ran = await statusIs(queued.sessionId, "idle");
    expect(ran.session.status).toBe("idle");
  });
});

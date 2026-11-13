import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  agentEventToNewEvent,
  type NewEvent,
  type ServerToClientMessage,
  SessionSnapshot,
  Settings,
  Snapshot,
} from "@codeden/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import WebSocket from "ws";
import { type RunningServer, startServer } from "../src";
import { sampleSessionEvent } from "./helpers";

const TOKEN = "t".repeat(64);
let home: string;
let server: RunningServer;

beforeEach(async () => {
  home = mkdtempSync(join(tmpdir(), "codeden-server-"));
  server = await startServer({
    port: 0,
    dataDir: home,
    token: TOKEN,
    runner: false,
    secrets: "memory",
    checkSetupOnStart: false,
  });
});

afterEach(async () => {
  await server.close();
  rmSync(home, { recursive: true, force: true });
});

const auth = { authorization: `Bearer ${TOKEN}` };

describe("security", () => {
  it("serves health without a token", async () => {
    const res = await fetch(`${server.url}/api/health`);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, name: "codeden" });
  });

  it("requires a token everywhere else", async () => {
    expect((await fetch(`${server.url}/api/snapshot`)).status).toBe(401);
    expect(
      (await fetch(`${server.url}/api/snapshot`, { headers: { authorization: "Bearer nope" } }))
        .status,
    ).toBe(401);
    expect((await fetch(`${server.url}/api/snapshot`, { headers: auth })).status).toBe(200);
  });

  it("exchanges ?token= for an HttpOnly SameSite=Strict cookie and strips it", async () => {
    const res = await fetch(`${server.url}/?token=${TOKEN}`, { redirect: "manual" });
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/");
    const cookie = res.headers.get("set-cookie") ?? "";
    expect(cookie).toContain(`codeden_token_${server.port}=${TOKEN}`);
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/SameSite=Strict/i);
    const withCookie = await fetch(`${server.url}/api/snapshot`, {
      headers: { cookie: cookie.split(";")[0] as string },
    });
    expect(withCookie.status).toBe(200);
  });

  it("rejects foreign origins and hosts", async () => {
    const evil = await fetch(`${server.url}/api/snapshot`, {
      headers: { ...auth, origin: "http://evil.example" },
    });
    expect(evil.status).toBe(403);
    const otherPort = await fetch(`${server.url}/api/snapshot`, {
      headers: { ...auth, origin: "http://localhost:1" },
    });
    expect(otherPort.status).toBe(403);
    const same = await fetch(`${server.url}/api/snapshot`, {
      headers: { ...auth, origin: server.url },
    });
    expect(same.status).toBe(200);
    // fetch() cannot override Host, so use node:http for the DNS-rebinding case.
    const rebind = await new Promise<number>((resolve, reject) => {
      const req = request(
        {
          host: "127.0.0.1",
          port: server.port,
          path: "/api/health",
          headers: { host: "evil.example" },
        },
        (res) => resolve(res.statusCode ?? 0),
      );
      req.on("error", reject);
      req.end();
    });
    expect(rebind).toBe(403);
  });
});

describe("api", () => {
  it("returns a valid snapshot", async () => {
    const res = await fetch(`${server.url}/api/snapshot`, { headers: auth });
    const snapshot = Snapshot.parse(await res.json());
    expect(snapshot.runner.state).toBe("disabled");
    expect(snapshot.seq).toBe(0);
  });

  it("patches and persists settings", async () => {
    const res = await fetch(`${server.url}/api/settings`, {
      method: "PATCH",
      headers: { ...auth, "content-type": "application/json" },
      body: JSON.stringify({ voice: { readAloud: { enabled: true } } }),
    });
    expect(res.status).toBe(200);
    const saved = Settings.parse(JSON.parse(readFileSync(join(home, "settings.json"), "utf8")));
    expect(saved.voice.readAloud.enabled).toBe(true);
    expect(saved.voice.readAloud.engine).toBe("browser");
    const bad = await fetch(`${server.url}/api/settings`, {
      method: "PATCH",
      headers: { ...auth, "content-type": "application/json" },
      body: JSON.stringify({ autonomy: { default: "reckless" } }),
    });
    expect(bad.status).toBe(400);
    expect(server.store.headSeq()).toBe(1);
  });

  it("projects agent events into a session snapshot", async () => {
    for (const e of sampleSessionEvent()) server.store.append([e]);
    const res = await fetch(`${server.url}/api/sessions/s1/snapshot`, { headers: auth });
    const snap = SessionSnapshot.parse(await res.json());
    expect(snap.session.rootThreadId).toBe("t1");
    expect(snap.turns[0]?.status).toBe("completed");
    const message = snap.items.find((i) => i.item.kind === "assistant_message");
    expect(message?.item.kind === "assistant_message" && message.item.text).toBe("Hello world");
    expect(
      (await fetch(`${server.url}/api/sessions/nope/snapshot`, { headers: auth })).status,
    ).toBe(404);
  });

  it("returns a session's turns in the order they started, not by id", async () => {
    const [created, thread] = sampleSessionEvent();
    server.store.append([created as NewEvent, thread as NewEvent]);
    // Turn ids are random UUIDs in practice, so their sort order says nothing about time. The
    // last append starts two turns, which then share a start time and keep insertion order.
    const appends = [
      ["2026-11-07T10:01:00.000Z", ["c-turn"]],
      ["2026-11-07T10:02:00.000Z", ["a-turn"]],
      ["2026-11-07T10:03:00.000Z", ["d-turn", "b-turn"]],
    ] as const;
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      for (const [at, turnIds] of appends) {
        vi.setSystemTime(new Date(at));
        server.store.append(
          turnIds.flatMap((turnId) => [
            agentEventToNewEvent("s1", { type: "turn.started", threadId: "t1", turnId }),
            agentEventToNewEvent("s1", { type: "turn.completed", threadId: "t1", turnId }),
          ]),
        );
      }
    } finally {
      vi.useRealTimers();
    }
    const res = await fetch(`${server.url}/api/sessions/s1/snapshot`, { headers: auth });
    const snap = SessionSnapshot.parse(await res.json());
    expect(snap.turns.map((t) => [t.id, t.startedAt])).toEqual(
      appends.flatMap(([at, turnIds]) => turnIds.map((id) => [id, at])),
    );
  });
});

describe("ui websocket", () => {
  it("catches up from a seq, then streams live events", async () => {
    const [first, ...rest] = sampleSessionEvent();
    server.store.append([first as (typeof rest)[number]]);
    const ws = new WebSocket(`${server.url.replace("http", "ws")}/ws`, { headers: auth });
    const messages: ServerToClientMessage[] = [];
    await new Promise<void>((resolve, reject) => {
      ws.on("open", () => ws.send(JSON.stringify({ type: "subscribe", fromSeq: 0 })));
      ws.on("error", reject);
      ws.on("message", (data) => {
        messages.push(JSON.parse(data.toString()));
        const seqs = messages.flatMap((m) =>
          m.type === "events" ? m.events.map((e) => e.seq) : [],
        );
        if (seqs.length === 1) server.store.append(rest);
        else if (seqs.at(-1) === server.store.headSeq()) resolve();
      });
    });
    ws.close();
    expect(messages[0]?.type).toBe("hello");
    const events = messages.flatMap((m) => (m.type === "events" ? m.events : []));
    const seqs = events.map((e) => e.seq);
    // Strictly increasing up to the head; consecutive text deltas are merged into one.
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
    expect(new Set(seqs).size).toBe(seqs.length);
    expect(seqs.at(-1)).toBe(server.store.headSeq());
    const deltas = events.filter((e) => e.type === "agent.item.delta");
    expect(deltas).toHaveLength(1);
    const merged = deltas[0]?.payload as { delta: { text: string } } | undefined;
    expect(merged?.delta.text).toBe("Hello world");
  });

  it("asks clients ahead of the log to resync", async () => {
    const ws = new WebSocket(`${server.url.replace("http", "ws")}/ws`, { headers: auth });
    const resync = await new Promise<ServerToClientMessage>((resolve, reject) => {
      ws.on("open", () => ws.send(JSON.stringify({ type: "subscribe", fromSeq: 99 })));
      ws.on("error", reject);
      ws.on("message", (data) => {
        const msg = JSON.parse(data.toString()) as ServerToClientMessage;
        if (msg.type === "resync") resolve(msg);
      });
    });
    ws.close();
    expect(resync).toMatchObject({ type: "resync", reason: "server_restarted", seq: 0 });
  });

  it("rejects websocket upgrades without a token", async () => {
    const ws = new WebSocket(`${server.url.replace("http", "ws")}/ws`);
    const status = await new Promise<number>((resolve) => {
      ws.on("unexpected-response", (_req, res) => resolve(res.statusCode ?? 0));
      ws.on("error", () => {});
    });
    expect(status).toBe(401);
  });

  const upgradeStatus = (path: string, headers: Record<string, string>) =>
    new Promise<number>((resolve) => {
      const ws = new WebSocket(`${server.url.replace("http", "ws")}${path}`, { headers });
      ws.on("unexpected-response", (_req, res) => resolve(res.statusCode ?? 0));
      ws.on("open", () => {
        ws.close();
        resolve(101);
      });
      ws.on("error", () => {});
    });

  it("checks Origin and Host on every websocket endpoint, even with the token", async () => {
    for (const path of ["/ws", "/ws/pty", "/ws/browser?sessionId=s1"]) {
      expect([path, await upgradeStatus(path, { ...auth, origin: "http://evil.example" })]).toEqual(
        [path, 403],
      );
      expect([path, await upgradeStatus(path, { ...auth, origin: "null" })]).toEqual([path, 403]);
      expect([path, await upgradeStatus(path, { ...auth, host: "evil.example" })]).toEqual([
        path,
        403,
      ]);
      expect([path, await upgradeStatus(path, {})]).toEqual([path, 401]);
    }
    // A cookie set for this server is not enough from another origin.
    expect(
      await upgradeStatus("/ws", {
        cookie: `codeden_token_${new URL(server.url).port}=${TOKEN}`,
        origin: "http://localhost:1",
      }),
    ).toBe(403);
  });

  it("guards /mcp with Origin/Host checks and per-session tokens, never the install token", async () => {
    const call = (headers: Record<string, string>) =>
      fetch(`${server.url}/mcp`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          ...headers,
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
      });
    expect((await call({ origin: "http://evil.example" })).status).toBe(403);
    expect((await call({})).status).toBe(401);
    expect((await call(auth)).status).toBe(401);
    expect((await call({ authorization: "Bearer cdm_not-a-real-token" })).status).toBe(401);
  });
});

it("keeps agent event persistence helpers consistent", () => {
  const e = agentEventToNewEvent("s1", { type: "turn.started", threadId: "t", turnId: "u" });
  expect(e.type).toBe("agent.turn.started");
});

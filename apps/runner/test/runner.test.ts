import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type ModelInfo,
  type ProviderStatus,
  RUNNER_PROTOCOL_VERSION,
  RunnerLock,
  type RunnerToServerMessage,
  RunnerToServerMessage as RunnerToServerSchema,
  type ServerToRunnerMessage,
} from "@codeden/contracts";
import {
  FakeProvider,
  ModelCatalog,
  type ProviderAdapter,
  type RefreshModelsOptions,
} from "@codeden/providers";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { Journal, type RunningRunner, startRunner } from "../src";
import { MODEL_LIST_MAX_AGE_MS } from "../src/runner";

let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "codeden-runner-"));
});
afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

describe("Journal", () => {
  it("assigns seqs, survives reloads and drops acked events", () => {
    const dir = join(home, "runner");
    const journal = new Journal(dir);
    const id = journal.runnerId;
    journal.append({ kind: "runner.draining", reason: "a" });
    journal.append({ kind: "runner.draining", reason: "b" });
    journal.append({ kind: "runner.draining", reason: "c" });
    journal.ack(1);

    const reloaded = new Journal(dir);
    expect(reloaded.runnerId).toBe(id);
    expect(reloaded.lastSeq).toBe(3);
    expect(reloaded.after(0).map((e) => e.seq)).toEqual([2, 3]);
    reloaded.ack(3);
    expect(new Journal(dir).unacked).toBe(0);
    expect(new Journal(dir).append({ kind: "runner.draining", reason: "d" }).seq).toBe(4);
  });
});

/** Minimal protocol client for tests. */
class TestServer {
  readonly messages: RunnerToServerMessage[] = [];
  private constructor(private readonly ws: WebSocket) {
    ws.on("message", (d) =>
      this.messages.push(RunnerToServerSchema.parse(JSON.parse(d.toString()))),
    );
  }

  static async connect(runner: RunningRunner): Promise<TestServer> {
    const ws = new WebSocket(`ws://127.0.0.1:${runner.port}/runner`, {
      headers: { authorization: `Bearer ${runner.token}` },
    });
    await new Promise((resolve, reject) => {
      ws.once("open", resolve);
      ws.once("error", reject);
    });
    return new TestServer(ws);
  }

  send(msg: ServerToRunnerMessage): void {
    this.ws.send(JSON.stringify(msg));
  }

  async waitFor<T extends RunnerToServerMessage>(
    pred: (m: RunnerToServerMessage) => m is T,
  ): Promise<T>;
  async waitFor(pred: (m: RunnerToServerMessage) => boolean): Promise<RunnerToServerMessage>;
  async waitFor(pred: (m: RunnerToServerMessage) => boolean): Promise<RunnerToServerMessage> {
    for (let i = 0; i < 400; i++) {
      const found = this.messages.find(pred);
      if (found) return found;
      await new Promise((r) => setTimeout(r, 10));
    }
    throw new Error("timed out waiting for message");
  }

  close(): Promise<void> {
    return new Promise((resolve) => {
      this.ws.once("close", () => resolve());
      this.ws.close();
    });
  }
}

const sessionStart = (sessionId: string): ServerToRunnerMessage => ({
  type: "command",
  id: `start-${sessionId}`,
  command: {
    name: "session.start",
    sessionId,
    providerId: "fake",
    options: {
      sessionId,
      role: "agent",
      cwd: home,
      autonomy: "auto",
      mcpServers: [],
      additionalDirectories: [],
      planMode: false,
    },
    input: { text: "hello", attachments: [] },
  },
});

const isTurnCompleted = (m: RunnerToServerMessage) =>
  m.type === "event" && m.event.kind === "agent" && m.event.event.type === "turn.completed";

describe("runner", () => {
  it("writes a lock file and rejects unauthenticated connections", async () => {
    const runner = await startRunner({ home, enableFakeProvider: true });
    const lock = RunnerLock.parse(JSON.parse(readFileSync(runner.lockFile, "utf8")));
    expect(lock).toMatchObject({ pid: process.pid, port: runner.port, token: runner.token });
    expect(lock.providers).toEqual(["fake"]);
    const res = await fetch(`http://127.0.0.1:${runner.port}/health`);
    expect(res.status).toBe(401);
    // Browser pages (any Origin) and rebinding hosts are refused, even with the token.
    const bearer = { authorization: `Bearer ${runner.token}` };
    const ok = await fetch(`http://127.0.0.1:${runner.port}/health`, { headers: bearer });
    expect(ok.status).toBe(200);
    const fromPage = await fetch(`http://127.0.0.1:${runner.port}/health`, {
      headers: { ...bearer, origin: `http://127.0.0.1:${runner.port}` },
    });
    expect(fromPage.status).toBe(403);
    const mcpFromPage = await fetch(`http://127.0.0.1:${runner.port}/mcp`, {
      method: "POST",
      headers: { authorization: "Bearer cdm_x", origin: "http://evil.example" },
      body: "{}",
    });
    expect(mcpFromPage.status).toBe(403);
    await expect(startRunner({ home })).rejects.toThrow(/already running/);
    await runner.close();
    expect(() => readFileSync(runner.lockFile)).toThrow();
  });

  it("loads OpenCode from a given executable (--opencode), even without the built-ins", async () => {
    const fake = join(
      import.meta.dirname,
      "../../../packages/providers/test/fixtures/fake-opencode/opencode.mjs",
    );
    const runner = await startRunner({ home, openCodeExecutable: fake });
    const lock = RunnerLock.parse(JSON.parse(readFileSync(runner.lockFile, "utf8")));
    expect(lock.providers).toEqual(["opencode"]);
    await runner.close();
    // A path that isn't there is reported, not loaded.
    const logs: string[] = [];
    const missing = await startRunner({
      home,
      openCodeExecutable: join(home, "no-such-opencode.mjs"),
      log: (m) => logs.push(m),
    });
    expect(RunnerLock.parse(JSON.parse(readFileSync(missing.lockFile, "utf8"))).providers).toEqual(
      [],
    );
    expect(logs.some((m) => m.includes("no-such-opencode.mjs not found"))).toBe(true);
    await missing.close();
  });

  it("handshakes, runs a Fake session and replays unacked events after reconnect", async () => {
    const runner = await startRunner({ home, enableFakeProvider: true });
    const server = await TestServer.connect(runner);
    server.send({ type: "hello", protocolVersion: RUNNER_PROTOCOL_VERSION, serverVersion: "test" });
    const welcome = await server.waitFor((m) => m.type === "welcome");
    expect(welcome.type === "welcome" && welcome.providers.map((p) => p.id)).toEqual(["fake"]);
    expect(welcome.type === "welcome" && welcome.capabilities.browser).toBe(true);
    server.send({ type: "resume", lastAckedSeq: 0 });

    server.send(sessionStart("s1"));
    const result = await server.waitFor((m) => m.type === "result");
    expect(result).toMatchObject({ ok: true, result: { resumeToken: "fake-s1" } });
    await server.waitFor(isTurnCompleted);

    const events = server.messages.flatMap((m) => (m.type === "event" ? [m] : []));
    expect(events.map((e) => e.seq)).toEqual(events.map((_, i) => i + 1));
    // Ack only the first half, then drop the connection.
    const half = Math.floor(events.length / 2);
    server.send({ type: "ack", seq: half });
    await new Promise((r) => setTimeout(r, 50));
    await server.close();

    const again = await TestServer.connect(runner);
    again.send({ type: "hello", protocolVersion: RUNNER_PROTOCOL_VERSION, serverVersion: "test" });
    const welcome2 = await again.waitFor((m) => m.type === "welcome");
    expect(welcome2.type === "welcome" && welcome2.sessions.map((s) => s.sessionId)).toEqual([
      "s1",
    ]);
    again.send({ type: "resume", lastAckedSeq: half });
    await again.waitFor(isTurnCompleted);
    const replayed = again.messages.flatMap((m) => (m.type === "event" ? [m.seq] : []));
    expect(replayed[0]).toBe(half + 1);
    expect(replayed.at(-1)).toBe(events.at(-1)?.seq);

    await again.close();
    await runner.close();
  });

  it("pushes provider model changes to the attached server", async () => {
    const model = (id: string): ModelInfo => ({ id, label: id, efforts: ["low", "high"] });
    const catalog = new ModelCatalog([model("default")]);
    const lists = [[model("found-at-start")], [model("found-on-detect")]];
    let releaseStart: () => void = () => {};
    const startGate = new Promise<void>((resolve) => {
      releaseStart = resolve;
    });
    let refreshes = 0;
    const skipped: (RefreshModelsOptions | undefined)[] = [];
    const status = { providerId: "listed", installed: true } as ProviderStatus;
    const listed: ProviderAdapter = {
      id: "listed",
      displayName: "Listed",
      detect: async () => status,
      capabilities: () => new FakeProvider().capabilities(),
      models: () => catalog.list(),
      onModelsChanged: (listener) => catalog.subscribe(listener),
      refreshModels: async (opts) => {
        // Throttled refreshes (a server attaching) find the list recent here.
        if (opts?.maxAgeMs !== undefined) {
          skipped.push(opts);
          return;
        }
        const list = lists[refreshes++] ?? [];
        if (refreshes === 1) await startGate;
        catalog.set(list);
      },
      openSession: () => Promise.reject(new Error("not used")),
    };
    const modelIds = (m: RunnerToServerMessage) =>
      m.type === "welcome" || m.type === "providers"
        ? m.providers.find((p) => p.id === "listed")?.models.map((x) => x.id)
        : undefined;

    const runner = await startRunner({ home, adapters: [listed] });
    expect(refreshes).toBe(1); // discovery starts with the runner, without blocking it
    const server = await TestServer.connect(runner);
    server.send({ type: "hello", protocolVersion: RUNNER_PROTOCOL_VERSION, serverVersion: "test" });
    expect(modelIds(await server.waitFor((m) => m.type === "welcome"))).toEqual(["default"]);
    server.send({ type: "resume", lastAckedSeq: 0 });
    await server.waitFor((m) => m.type === "providers");
    // Attaching asks for a refresh, unless the list is recent.
    expect(skipped).toEqual([{ maxAgeMs: MODEL_LIST_MAX_AGE_MS }]);

    // Discovery that finishes after the handshake reaches the server.
    releaseStart();
    await server.waitFor((m) => modelIds(m)?.[0] === "found-at-start");

    // A re-detect refreshes the lists too.
    server.send({ type: "command", id: "detect", command: { name: "provider.detect" } });
    await server.waitFor((m) => m.type === "result" && m.id === "detect");
    await server.waitFor((m) => modelIds(m)?.[0] === "found-on-detect");
    expect(refreshes).toBe(2);
    expect(server.messages.filter((m) => m.type === "providers").map(modelIds)).toEqual([
      ["default"],
      ["found-at-start"],
      ["found-on-detect"],
    ]);

    // "Refresh models": the answer waits for the refresh and carries the new lists.
    lists.push([model("found-on-refresh")]);
    server.send({
      type: "command",
      id: "refresh",
      command: { name: "provider.detect", providerId: "listed", waitForModels: true },
    });
    const result = await server.waitFor((m) => m.type === "result" && m.id === "refresh");
    const answer = result.type === "result" && result.ok ? result.result : undefined;
    expect(answer).toMatchObject({ statuses: [status] });
    const providers = (answer as { providers?: { id: string; models: ModelInfo[] }[] }).providers;
    expect(providers?.find((p) => p.id === "listed")?.models.map((m) => m.id)).toEqual([
      "found-on-refresh",
    ]);

    await server.close();
    await runner.close();
  });

  it("rejects incompatible protocol versions and unknown commands fail cleanly", async () => {
    const runner = await startRunner({ home });
    const server = await TestServer.connect(runner);
    server.send({ type: "hello", protocolVersion: 999, serverVersion: "future" });
    const reject = await server.waitFor((m) => m.type === "reject");
    expect(reject).toMatchObject({ reason: "protocol_mismatch" });
    // Browser commands reach the browser engine; a session that never opened one has none.
    server.send({
      type: "command",
      id: "x",
      command: { name: "browser.tabs.list", sessionId: "s" },
    });
    const result = await server.waitFor((m) => m.type === "result");
    expect(result).toMatchObject({ ok: false, error: { code: "not_found" } });
    server.send(sessionStart("s2"));
    const failed = await server.waitFor((m) => m.type === "result" && m.id === "start-s2");
    expect(failed).toMatchObject({ ok: false, error: { code: "unknown_provider" } });
    await server.close();
    await runner.close();
  });
});

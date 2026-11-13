import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  RUNNER_PROTOCOL_VERSION,
  type RunnerCommand,
  type RunnerCommandName,
  type RunnerCommandResult,
  type RunnerToServerMessage,
  RunnerToServerMessage as RunnerToServerSchema,
  type ServerToRunnerMessage,
} from "@codeden/contracts";
import WebSocket from "ws";
import type { RunningRunner } from "../src";

export function tempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

/**
 * Make `process.platform` read `platform`, to test a platform's rules on any host. Returns what
 * puts the real one back.
 */
export function setPlatform(platform: NodeJS.Platform): () => void {
  const real = Object.getOwnPropertyDescriptor(process, "platform");
  Object.defineProperty(process, "platform", { value: platform, configurable: true });
  return () => {
    if (real) Object.defineProperty(process, "platform", real);
  };
}

export function removeDir(dir: string): void {
  rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}

/** Run git synchronously in a test repo. */
export function sh(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", windowsHide: true }).trim();
}

export function write(root: string, path: string, content: string | Buffer): void {
  const file = join(root, path);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, content);
}

/** A git repo with identity configured and one commit on `main`. */
export function makeRepo(files: Record<string, string> = { "README.md": "# demo\n" }): string {
  const dir = tempDir("codeden-repo-");
  sh(dir, "init", "-q", "-b", "main");
  sh(dir, "config", "user.name", "Test");
  sh(dir, "config", "user.email", "test@example.com");
  sh(dir, "config", "core.autocrlf", "false");
  for (const [path, content] of Object.entries(files)) write(dir, path, content);
  sh(dir, "add", "-A");
  sh(dir, "commit", "-q", "-m", "initial");
  return dir;
}

export async function waitUntil(check: () => boolean, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 20));
  }
}

/** Minimal protocol client standing in for the server. */
export class TestServer {
  readonly messages: RunnerToServerMessage[] = [];
  private counter = 0;

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

  /** Connect and complete the handshake (`hello`, `welcome`, `resume`). */
  static async attach(runner: RunningRunner, lastAckedSeq = 0): Promise<TestServer> {
    const server = await TestServer.connect(runner);
    server.send({ type: "hello", protocolVersion: RUNNER_PROTOCOL_VERSION, serverVersion: "test" });
    await server.waitFor((m) => m.type === "welcome");
    server.send({ type: "resume", lastAckedSeq });
    return server;
  }

  send(msg: ServerToRunnerMessage): void {
    this.ws.send(JSON.stringify(msg));
  }

  /** Send a command and resolve with its result (rejects on `ok: false`). */
  async request<N extends RunnerCommandName>(
    command: Extract<RunnerCommand, { name: N }>,
    timeoutMs = 30_000,
  ): Promise<RunnerCommandResult<N>> {
    const id = `req-${++this.counter}`;
    this.send({ type: "command", id, command: command as RunnerCommand });
    const result = await this.waitFor((m) => m.type === "result" && m.id === id, timeoutMs);
    if (result.type !== "result") throw new Error("unexpected");
    if (!result.ok) throw Object.assign(new Error(result.error.message), result.error);
    return result.result as RunnerCommandResult<N>;
  }

  events(): Array<Extract<RunnerToServerMessage, { type: "event" }>> {
    return this.messages.flatMap((m) => (m.type === "event" ? [m] : []));
  }

  async waitFor(
    pred: (m: RunnerToServerMessage) => boolean,
    timeoutMs = 10_000,
  ): Promise<RunnerToServerMessage> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const found = this.messages.find(pred);
      if (found) return found;
      if (Date.now() > deadline) throw new Error("timed out waiting for message");
      await new Promise((r) => setTimeout(r, 10));
    }
  }

  close(): Promise<void> {
    return new Promise((resolve) => {
      if (this.ws.readyState === WebSocket.CLOSED) return resolve();
      this.ws.once("close", () => resolve());
      this.ws.close();
    });
  }
}

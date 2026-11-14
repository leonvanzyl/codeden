import { once } from "node:events";
import { writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import {
  CODEDEN_VERSION,
  RUNNER_PROTOCOL_VERSION,
  type RunnerEvent,
  type RunnerLock,
  type RunnerStream,
  type RunnerWelcome,
} from "@codeden/contracts";
import type WebSocket from "ws";
import { WebSocketServer } from "ws";
import { waitUntil } from "./harness";

const TS = "2026-11-14T10:00:00.000Z";

/**
 * A scripted runner endpoint: answers `/health` and speaks the runner protocol on `/runner`,
 * welcoming the server with whatever journal id the test says (as a compromised sandbox runner
 * could), answering every command with success, and sending the events and streams the test
 * gives it. Its lock file points the server's `RunnerClient` at it; no runner process runs.
 */
export interface FakeRunner {
  lockFile: string;
  /** Seqs the server acknowledged. */
  acked: number[];
  /** Whether a server connection is open. */
  open: () => boolean;
  /** Send a durable event; resolves once the server acked it or dropped the connection. */
  send: (seq: number, event: RunnerEvent) => Promise<void>;
  /** Send ephemeral stream data (no ack). */
  stream: (stream: RunnerStream) => void;
  /** Report this journal id in later welcomes. */
  claim: (runnerId: string) => void;
  /** Drop the server's connection (it reconnects). */
  drop: () => void;
  close: () => Promise<void>;
}

/** Start a scripted runner whose lock file is written to `dir`. */
export async function startFakeRunner(dir: string, runnerId: string): Promise<FakeRunner> {
  const token = "t".repeat(32);
  const acked: number[] = [];
  let claimed = runnerId;
  let socket: WebSocket | undefined;
  const wss = new WebSocketServer({ noServer: true });
  const http = createServer((req, res) => {
    const ok = req.url === "/health" && req.headers.authorization === `Bearer ${token}`;
    res.writeHead(ok ? 200 : 401).end();
  });
  http.on("upgrade", (req, sock, head) => {
    wss.handleUpgrade(req, sock, head, (ws) => {
      socket = ws;
      ws.on("message", (data) => {
        const msg = JSON.parse(data.toString()) as {
          type: string;
          seq?: number;
          id?: string;
          command?: { name: string };
        };
        if (msg.type === "hello") ws.send(JSON.stringify(welcome(claimed)));
        if (msg.type === "ack" && msg.seq !== undefined) acked.push(msg.seq);
        if (msg.type === "command") {
          const result = msg.command?.name === "pty.open" ? { pid: 1 } : {};
          ws.send(JSON.stringify({ type: "result", id: msg.id, ok: true, result }));
        }
      });
    });
  });
  http.listen(0, "127.0.0.1");
  await once(http, "listening");
  const port = (http.address() as AddressInfo).port;
  const lockFile = join(dir, `runner-${port}.json`);
  const lock: RunnerLock = {
    pid: process.pid,
    port,
    token,
    version: CODEDEN_VERSION,
    protocolVersion: RUNNER_PROTOCOL_VERSION,
    runnerId,
    startedAt: TS,
    providers: [],
  };
  writeFileSync(lockFile, JSON.stringify(lock));
  const open = () => socket?.readyState === 1;
  return {
    lockFile,
    acked,
    open,
    send: async (seq, event) => {
      if (!open()) return;
      socket?.send(JSON.stringify({ type: "event", seq, ts: TS, event }));
      await waitUntil(() => acked.includes(seq) || !open(), 15_000);
    },
    stream: (stream) => socket?.send(JSON.stringify({ type: "stream", ts: TS, stream })),
    claim: (id) => {
      claimed = id;
    },
    drop: () => socket?.terminate(),
    close: async () => {
      for (const client of wss.clients) client.terminate();
      wss.close();
      http.close();
      await once(http, "close");
    },
  };
}

function welcome(runnerId: string): RunnerWelcome {
  return {
    type: "welcome",
    protocolVersion: RUNNER_PROTOCOL_VERSION,
    runnerId,
    runnerVersion: CODEDEN_VERSION,
    pid: process.pid,
    startedAt: TS,
    capabilities: { pty: true, browser: true, git: true, mcpProxy: false },
    providers: [],
    sessions: [],
    journal: { lastSeq: 0, unacked: 0 },
    draining: false,
  };
}

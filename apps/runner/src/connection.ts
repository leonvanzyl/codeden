import { resolve } from "node:path";
import {
  RUNNER_PROTOCOL_VERSION,
  type RunnerToServerMessage,
  type ServerToRunnerMessage,
  ServerToRunnerMessage as ServerToRunnerSchema,
} from "@codeden/contracts";
import type { WSContext, WSEvents } from "hono/ws";
import { executeCommand, type RunnerCore } from "./commands";
import { CommandError } from "./errors";

export type { RunnerCore };

/**
 * One server connection. Handshake (`hello` -> `welcome` -> `resume`), then commands, acks
 * and journaled events. Only one connection is "attached" (receives events) at a time.
 */
export class ServerConnection {
  private attached = false;

  constructor(
    private readonly ws: WSContext,
    private readonly core: RunnerCore,
    private readonly onAttach: (conn: ServerConnection) => void,
  ) {}

  get isAttached(): boolean {
    return this.attached;
  }

  /** Deliver a freshly journaled event or stream message if attached. */
  deliver(msg: RunnerToServerMessage): void {
    if (this.attached) this.send(msg);
  }

  detach(): void {
    this.attached = false;
  }

  close(reason: string): void {
    this.attached = false;
    this.ws.close(1000, reason);
  }

  async handle(raw: unknown): Promise<void> {
    const parsed = ServerToRunnerSchema.safeParse(raw);
    if (!parsed.success) return;
    const msg: ServerToRunnerMessage = parsed.data;
    switch (msg.type) {
      case "hello":
        if (msg.protocolVersion !== RUNNER_PROTOCOL_VERSION) {
          this.send({
            type: "reject",
            reason: "protocol_mismatch",
            message: `Runner speaks protocol ${RUNNER_PROTOCOL_VERSION}, server sent ${msg.protocolVersion}`,
            supportedProtocolVersions: [RUNNER_PROTOCOL_VERSION],
          });
          return;
        }
        this.send({
          type: "welcome",
          protocolVersion: RUNNER_PROTOCOL_VERSION,
          runnerId: this.core.journal.runnerId,
          runnerVersion: this.core.version,
          pid: process.pid,
          startedAt: this.core.startedAt,
          capabilities: {
            pty: this.core.terminals.available,
            browser: true,
            git: true,
            mcpProxy: true,
          },
          providers: this.core.registry.info(),
          sessions: this.core.host.list(),
          journal: { lastSeq: this.core.journal.lastSeq, unacked: this.core.journal.unacked },
          draining: this.core.isDraining(),
          // Where it runs, so the server never guesses paths or separators (remote runners).
          platform: process.platform,
          arch: process.arch,
          home: resolve(this.core.home),
          backend: this.core.backend,
        });
        return;
      case "resume":
        // Synchronous replay + attach: nothing can be journaled in between.
        this.core.journal.ack(msg.lastAckedSeq);
        for (const event of this.core.journal.after(msg.lastAckedSeq)) this.send(event);
        this.attached = true;
        this.onAttach(this);
        // Models discovered between `welcome` and now would otherwise be missed.
        this.send({ type: "providers", providers: this.core.registry.info() });
        return;
      case "ack":
        this.core.journal.ack(msg.seq);
        return;
      case "command":
        try {
          const result = await executeCommand(this.core, msg.command);
          this.send({ type: "result", id: msg.id, ok: true, result });
        } catch (error) {
          const code = error instanceof CommandError ? error.code : "command_failed";
          const message = error instanceof Error ? error.message : String(error);
          this.send({ type: "result", id: msg.id, ok: false, error: { code, message } });
        }
        return;
      case "ping":
        this.send({ type: "pong", id: msg.id });
        return;
      case "pong":
        return;
    }
  }

  private send(msg: RunnerToServerMessage): void {
    if (this.ws.readyState === 1) this.ws.send(JSON.stringify(msg));
  }
}

/** Build `upgradeWebSocket` handlers bound to a connection. */
export function connectionHandlers(
  core: RunnerCore,
  register: (conn: ServerConnection) => void,
  unregister: (conn: ServerConnection) => void,
  onAttach: (conn: ServerConnection) => void,
): WSEvents {
  let conn: ServerConnection | undefined;
  return {
    onOpen: (_event, ws) => {
      conn = new ServerConnection(ws, core, onAttach);
      register(conn);
    },
    onMessage: (event) => {
      if (!conn || typeof event.data !== "string") return;
      let raw: unknown;
      try {
        raw = JSON.parse(event.data);
      } catch {
        return;
      }
      void conn.handle(raw);
    },
    onClose: () => {
      if (conn) unregister(conn);
    },
  };
}

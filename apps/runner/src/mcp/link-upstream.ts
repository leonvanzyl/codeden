import { randomUUID } from "node:crypto";
import {
  MCP_LINK_MAX_REQUEST_BYTES,
  MCP_REQUEST_HEADERS,
  MCP_RESPONSE_HEADERS,
  McpLinkRequest as McpLinkRequestSchema,
  type McpLinkResponse,
  type McpLinkRunnerFrame,
} from "@codeden/contracts";
import { jsonRpcError, type McpUpstream } from "./proxy";

/** A server connection MCP frames can go out on (the attached `ServerConnection`). */
export interface McpLinkChannel {
  /** Send a frame; false when the connection can't take it (closed, or no longer attached). */
  sendMcp(frame: McpLinkRunnerFrame): boolean;
}

export interface LinkMcpUpstreamOptions {
  /** The connection requests go out on now, if the server is attached. */
  channel: () => McpLinkChannel | undefined;
  /**
   * How long to wait for a response's head, and how long a body may stall (no frame from the
   * server and no read by the agent). Default 300 s each, as `fetch` waits on the HTTP upstream.
   */
  headTimeoutMs?: number;
  idleTimeoutMs?: number;
}

/** `fetch`'s (undici's) default headers and body timeouts, which the HTTP upstream has. */
const DEFAULT_TIMEOUT_MS = 300_000;
const MiB = 1024 * 1024;
const STALLED = "the CodeDen server stopped answering";

interface Pending {
  channel: McpLinkChannel;
  /** Waiting for the head: settles `forward`. */
  head?: { resolve: (response: Response) => void; reject: (error: Error) => void };
  /** Body pieces the agent hasn't read yet. */
  queue: Uint8Array[];
  /** Wakes a read waiting for the next piece. */
  wake?: () => void;
  ended: boolean;
  failed?: Error;
  timer?: NodeJS.Timeout;
}

/**
 * The MCP proxy's upstream for a runner that can't reach the server's loopback `/mcp`
 * (`docs/remote-runners.md` §11): each agent request becomes an `mcp.request` frame on the
 * server connection, answered in-process by the server's MCP handler. The response streams
 * back as `mcp.response` frames; the body is read by the agent as it arrives, and every piece
 * it reads is acked so the server sends more (at most `MCP_LINK_WINDOW_BYTES` ahead). An agent
 * that goes away cancels the request on the server. A request whose connection closes fails
 * like an unreachable HTTP upstream (502 from the proxy, or a broken body stream).
 */
export class LinkMcpUpstream implements McpUpstream {
  private readonly pending = new Map<string, Pending>();
  private readonly headTimeoutMs: number;
  private readonly idleTimeoutMs: number;

  constructor(private readonly opts: LinkMcpUpstreamOptions) {
    this.headTimeoutMs = opts.headTimeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.idleTimeoutMs = opts.idleTimeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  /** Requests waiting for or reading a response. */
  get inFlight(): number {
    return this.pending.size;
  }

  async forward(request: Request): Promise<Response> {
    const tooLarge = () =>
      jsonRpcError(
        413,
        `Request too large for the CodeDen runner link (over ${MCP_LINK_MAX_REQUEST_BYTES / MiB} MiB); share large files by path`,
      );
    if (Number(request.headers.get("content-length") ?? 0) > MCP_LINK_MAX_REQUEST_BYTES) {
      return tooLarge();
    }
    const hasBody = request.method !== "GET" && request.method !== "HEAD";
    const body = hasBody ? Buffer.from(await request.arrayBuffer()) : undefined;
    if (body && body.length > MCP_LINK_MAX_REQUEST_BYTES) return tooLarge();
    const headers: Record<string, string> = {};
    for (const name of MCP_REQUEST_HEADERS) {
      const value = request.headers.get(name);
      if (value !== null) headers[name] = value;
    }
    const frame = McpLinkRequestSchema.safeParse({
      type: "mcp.request",
      id: randomUUID(),
      method: request.method,
      headers,
      ...(body && body.length > 0 ? { body: body.toString("base64") } : {}),
    });
    if (!frame.success) return jsonRpcError(400, "Request can't be sent over the runner link");
    const id = frame.data.id;

    request.signal.throwIfAborted();
    const channel = this.opts.channel();
    if (!channel?.sendMcp(frame.data)) {
      throw new Error("the runner is not connected to the CodeDen server");
    }
    const entry: Pending = { channel, queue: [], ended: false };
    const head = new Promise<Response>((resolve, reject) => {
      entry.head = { resolve, reject };
    });
    this.pending.set(id, entry);
    this.arm(id, entry, this.headTimeoutMs, "no answer from the CodeDen server in time");
    const onAbort = () => this.cancel(id, new Error("the agent closed the request"));
    request.signal.addEventListener("abort", onAbort, { once: true });
    return head.finally(() => {
      if (!this.pending.has(id)) request.signal.removeEventListener("abort", onAbort);
    });
  }

  /** An `mcp.response` frame from `channel`. Frames for unknown ids, or from another, are dropped. */
  receive(channel: McpLinkChannel, frame: McpLinkResponse): void {
    const entry = this.pending.get(frame.id);
    if (!entry || entry.channel !== channel) return;
    switch (frame.part) {
      case "head": {
        if (!entry.head) return;
        const head = entry.head;
        entry.head = undefined;
        const headers = new Headers();
        for (const name of MCP_RESPONSE_HEADERS) {
          const value = frame.headers[name];
          if (value !== undefined) headers.set(name, value);
        }
        // These statuses carry no body (the Response constructor refuses one): done.
        if (frame.status === 204 || frame.status === 205 || frame.status === 304) {
          this.settle(frame.id, entry);
          head.resolve(new Response(null, { status: frame.status, headers }));
          return;
        }
        this.arm(frame.id, entry, this.idleTimeoutMs, STALLED);
        const body = this.body(frame.id, entry);
        head.resolve(new Response(body, { status: frame.status, headers }));
        return;
      }
      case "chunk":
        if (entry.head || entry.ended) return;
        entry.queue.push(Buffer.from(frame.data, "base64"));
        this.arm(frame.id, entry, this.idleTimeoutMs, STALLED);
        entry.wake?.();
        return;
      case "end":
        if (frame.error !== undefined || entry.head) {
          const error = frame.error ?? "the CodeDen server ended the request";
          this.fail(frame.id, entry, new Error(error));
          return;
        }
        // Complete: what the agent hasn't read yet stays readable, whatever the link does now.
        entry.ended = true;
        this.settle(frame.id, entry);
        entry.wake?.();
        return;
    }
  }

  /** `channel` closed: every request that went out on it fails. */
  closed(channel: McpLinkChannel): void {
    for (const [id, entry] of this.pending) {
      if (entry.channel === channel) {
        this.fail(id, entry, new Error("the connection to the CodeDen server closed"));
      }
    }
  }

  /**
   * A response body read as the agent reads it (one piece per read, nothing read ahead); each
   * piece read is acked, and reading counts as activity for the idle timeout.
   */
  private body(id: string, entry: Pending): ReadableStream<Uint8Array> {
    return new ReadableStream<Uint8Array>(
      {
        pull: async (controller) => {
          for (;;) {
            const piece = entry.queue.shift();
            if (piece) {
              if (piece.length === 0) continue;
              controller.enqueue(piece);
              if (!entry.ended) {
                entry.channel.sendMcp({ type: "mcp.ack", id, bytes: piece.length });
                this.arm(id, entry, this.idleTimeoutMs, STALLED);
              }
              return;
            }
            if (entry.failed) return controller.error(entry.failed);
            if (entry.ended) return controller.close();
            await new Promise<void>((resolve) => {
              entry.wake = resolve;
            });
            entry.wake = undefined;
          }
        },
        cancel: () => this.cancel(id, new Error("the agent stopped reading")),
      },
      { highWaterMark: 0 },
    );
  }

  /** The agent went away: tell the server, and end the request here. */
  private cancel(id: string, why: Error): void {
    const entry = this.pending.get(id);
    if (!entry) return;
    if (!entry.ended) entry.channel.sendMcp({ type: "mcp.cancel", id });
    this.fail(id, entry, why);
  }

  /** End a request with an error: `forward` rejects, or the body stream errors. */
  private fail(id: string, entry: Pending, error: Error): void {
    entry.failed ??= error;
    entry.head?.reject(error);
    entry.head = undefined;
    entry.queue = [];
    entry.wake?.();
    this.settle(id, entry);
  }

  private settle(id: string, entry: Pending): void {
    clearTimeout(entry.timer);
    if (this.pending.get(id) === entry) this.pending.delete(id);
  }

  /** (Re)start a request's timer; when it fires the server is told and the request fails. */
  private arm(id: string, entry: Pending, ms: number, why: string): void {
    clearTimeout(entry.timer);
    entry.timer = setTimeout(() => {
      if (this.pending.get(id) !== entry) return;
      entry.channel.sendMcp({ type: "mcp.cancel", id });
      this.fail(id, entry, new Error(why));
    }, ms);
    entry.timer.unref?.();
  }
}

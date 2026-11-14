import {
  MCP_LINK_CHUNK_BYTES,
  MCP_LINK_MAX_IN_FLIGHT,
  MCP_LINK_WINDOW_BYTES,
  MCP_REQUEST_HEADERS,
  MCP_RESPONSE_HEADERS,
  type McpLinkRequest,
  type McpLinkResponse,
  type McpLinkRunnerFrame,
  type McpTokenClaims,
} from "@codeden/contracts";
import type { McpHandler } from "../mcp/endpoint";

export interface McpLinkServerOptions {
  /** The server's MCP handler, the same one `/mcp` uses. */
  handler: McpHandler;
  /** Send a frame to the runner on this connection (dropped once it is closed). */
  send: (frame: McpLinkResponse) => void;
  /**
   * Whether a live token's claims may be used from this runner; refused ones are answered as
   * invalid tokens. Unset for the home runner, which may use any.
   */
  accept?: (claims: McpTokenClaims) => boolean;
  /** Most requests in flight at once; more get 429. Default `MCP_LINK_MAX_IN_FLIGHT`. */
  maxInFlight?: number;
  log?: (message: string) => void;
}

interface InFlight {
  abort: AbortController;
  /** Body bytes sent and not yet acked by the runner. */
  unacked: number;
  /** Wakes the response pump waiting for acks. */
  wake?: () => void;
  body?: ReadableStreamDefaultReader<Uint8Array>;
}

/** Most characters of an error sent in an `end` frame (the contract allows 1,000). */
const ERROR_CHARS = 500;

/**
 * The server's end of MCP over the runner link (`docs/remote-runners.md` §11), one per runner
 * connection. Each `mcp.request` becomes a `Request` (allow-listed headers only) for the same
 * handler `/mcp` uses, so a bad, expired or revoked token gets the same answer; `accept` adds
 * the check that the token's session is routed to this runner. The response streams back as
 * `mcp.response` frames: the head, the body in pieces of at most `MCP_LINK_CHUNK_BYTES`, never
 * more than `MCP_LINK_WINDOW_BYTES` ahead of the runner's acks, then the end. A cancel, or the
 * connection closing, aborts the request (the MCP server closes, which ends the tool call).
 */
export class McpLinkServer {
  private readonly requests = new Map<string, InFlight>();
  private closed = false;

  constructor(private readonly opts: McpLinkServerOptions) {}

  /** Requests being answered. */
  get inFlight(): number {
    return this.requests.size;
  }

  receive(frame: McpLinkRunnerFrame): void {
    if (this.closed) return;
    switch (frame.type) {
      case "mcp.request":
        this.start(frame);
        return;
      case "mcp.cancel":
        this.cancel(frame.id);
        return;
      case "mcp.ack": {
        const entry = this.requests.get(frame.id);
        if (!entry) return;
        entry.unacked = Math.max(0, entry.unacked - frame.bytes);
        entry.wake?.();
        return;
      }
    }
  }

  /** The connection closed: abort everything in flight; nothing more is answered. */
  close(): void {
    this.closed = true;
    for (const id of [...this.requests.keys()]) this.cancel(id);
  }

  private start(frame: McpLinkRequest): void {
    if (this.requests.has(frame.id)) return; // a repeated id: the first one is answered
    const max = this.opts.maxInFlight ?? MCP_LINK_MAX_IN_FLIGHT;
    if (this.requests.size >= max) {
      this.reply(
        frame.id,
        429,
        `Too many CodeDen MCP requests in flight on this runner (at most ${max}); try again shortly`,
      );
      return;
    }
    const entry: InFlight = { abort: new AbortController(), unacked: 0 };
    this.requests.set(frame.id, entry);
    void this.answer(frame, entry).finally(() => {
      if (this.requests.get(frame.id) === entry) this.requests.delete(frame.id);
    });
  }

  private async answer(frame: McpLinkRequest, entry: InFlight): Promise<void> {
    const { id } = frame;
    const signal = entry.abort.signal;
    try {
      const response = await this.opts.handler(toRequest(frame, signal), {
        accept: this.opts.accept,
      });
      if (signal.aborted) {
        await response.body?.cancel().catch(() => undefined);
        return;
      }
      const headers: Record<string, string> = {};
      for (const name of MCP_RESPONSE_HEADERS) {
        const value = response.headers.get(name);
        if (value !== null) headers[name] = value;
      }
      this.opts.send({ type: "mcp.response", id, part: "head", status: response.status, headers });
      if (response.body) await this.pump(id, entry, response.body.getReader());
      if (!signal.aborted) this.opts.send({ type: "mcp.response", id, part: "end" });
    } catch (error) {
      if (signal.aborted) return;
      const message = error instanceof Error ? error.message : String(error);
      this.opts.log?.(`runner: MCP request over the link failed: ${message}`);
      this.opts.send({
        type: "mcp.response",
        id,
        part: "end",
        error: message.slice(0, ERROR_CHARS),
      });
    }
  }

  /** Send the body as the runner acks it: never more than the window ahead. */
  private async pump(
    id: string,
    entry: InFlight,
    reader: ReadableStreamDefaultReader<Uint8Array>,
  ): Promise<void> {
    entry.body = reader;
    const signal = entry.abort.signal;
    for (;;) {
      await this.credit(entry);
      if (signal.aborted) return;
      const { done, value } = await reader.read();
      if (done || signal.aborted) return;
      for (let offset = 0; offset < value.length; offset += MCP_LINK_CHUNK_BYTES) {
        if (offset > 0) await this.credit(entry);
        if (signal.aborted) return;
        const piece = value.subarray(offset, offset + MCP_LINK_CHUNK_BYTES);
        entry.unacked += piece.length;
        const data = Buffer.from(piece.buffer, piece.byteOffset, piece.length).toString("base64");
        this.opts.send({ type: "mcp.response", id, part: "chunk", data });
      }
    }
  }

  /** Resolve once the runner has acked enough for another piece, or the request is aborted. */
  private async credit(entry: InFlight): Promise<void> {
    while (entry.unacked >= MCP_LINK_WINDOW_BYTES && !entry.abort.signal.aborted) {
      await new Promise<void>((resolve) => {
        entry.wake = resolve;
      });
      entry.wake = undefined;
    }
  }

  private cancel(id: string): void {
    const entry = this.requests.get(id);
    if (!entry) return;
    this.requests.delete(id);
    entry.abort.abort();
    void entry.body?.cancel().catch(() => undefined);
    entry.wake?.();
  }

  /** Answer at once with a JSON-RPC error, as the proxy's own errors look. */
  private reply(id: string, status: number, message: string): void {
    const body = JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32000, message } });
    const headers = { "content-type": "application/json" };
    this.opts.send({ type: "mcp.response", id, part: "head", status, headers });
    const data = Buffer.from(body).toString("base64");
    this.opts.send({ type: "mcp.response", id, part: "chunk", data });
    this.opts.send({ type: "mcp.response", id, part: "end" });
  }
}

/** The frame as a `Request` for the MCP handler, with only the allow-listed headers. */
function toRequest(frame: McpLinkRequest, signal: AbortSignal): Request {
  const headers = new Headers();
  for (const name of MCP_REQUEST_HEADERS) {
    const value = frame.headers[name];
    if (value !== undefined) headers.set(name, value);
  }
  const hasBody = frame.body !== undefined && frame.method !== "GET" && frame.method !== "HEAD";
  return new Request("http://127.0.0.1/mcp", {
    method: frame.method,
    headers,
    body: hasBody ? Buffer.from(frame.body as string, "base64") : undefined,
    signal,
  });
}

import {
  MCP_LINK_CHUNK_BYTES,
  MCP_LINK_MAX_IN_FLIGHT,
  MCP_LINK_MAX_REQUEST_BYTES,
  MCP_LINK_WINDOW_BYTES,
  type McpLinkRunnerFrame,
  RunnerToServerMessage,
  ServerToRunnerMessage,
} from "@codeden/contracts";
import { handleMcpRequest, LinkMcpUpstream, type McpLinkChannel } from "@codeden/runner";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { McpHandler } from "../src/mcp/endpoint";
import { McpLinkServer } from "../src/runner/mcp-link";

/**
 * MCP over the runner link (`docs/remote-runners.md` §11), both ends in memory: the runner's
 * `LinkMcpUpstream` and the server's `McpLinkServer`, with every frame validated by the
 * protocol schemas on its way across, as on a real link. The handler is scripted here; the
 * real one over a real link is `remote-mcp.test.ts`.
 */

/** Let frames cross and streams settle (no timers). */
async function settle(): Promise<void> {
  for (let i = 0; i < 30; i++) await new Promise((resolve) => setImmediate(resolve));
}

interface Seen {
  request: Request;
  body: string;
}

/** Wire both ends together around `handler`; `sent` records the runner's frames. */
function link(handler: McpHandler, opts: { headTimeoutMs?: number } = {}) {
  const sent: McpLinkRunnerFrame[] = [];
  let open = true;
  let server: McpLinkServer;
  const channel: McpLinkChannel = {
    sendMcp: (frame) => {
      if (!open) return false;
      const parsed = RunnerToServerMessage.parse(JSON.parse(JSON.stringify(frame)));
      sent.push(parsed as McpLinkRunnerFrame);
      queueMicrotask(() => server.receive(parsed as McpLinkRunnerFrame));
      return true;
    },
  };
  const upstream = new LinkMcpUpstream({ channel: () => channel, ...opts });
  server = new McpLinkServer({
    handler,
    send: (frame) => {
      if (!open) return;
      const parsed = ServerToRunnerMessage.parse(JSON.parse(JSON.stringify(frame)));
      if (parsed.type === "mcp.response") queueMicrotask(() => upstream.receive(channel, parsed));
    },
  });
  /** An agent's request to the runner's `/mcp`, answered as the proxy answers it. */
  const agent = (init: RequestInit & { headers?: Record<string, string> } = {}) =>
    handleMcpRequest(
      new Request("http://127.0.0.1:1/mcp", {
        method: "POST",
        ...init,
        headers: { authorization: "Bearer cdm_test", ...init.headers },
      }),
      upstream,
    );
  /** The link drops: both ends are told. */
  const drop = () => {
    open = false;
    upstream.closed(channel);
    server.close();
  };
  return { upstream, server, sent, agent, drop };
}

/** A handler that records requests and answers with `respond`. */
function scripted(respond: (seen: Seen) => Response | Promise<Response>) {
  const seen: Seen[] = [];
  const handler: McpHandler = async (request) => {
    const entry = { request, body: await request.text() };
    seen.push(entry);
    return respond(entry);
  };
  return { seen, handler };
}

/** An SSE body the test feeds by hand; `pulled` counts bytes the server read from it. */
function manualStream() {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const state = { pulled: 0, cancelled: false };
  const pending: Uint8Array[] = [];
  /** A read is waiting for the next piece. */
  let waiting = false;
  const give = (piece: Uint8Array) => {
    waiting = false;
    state.pulled += piece.length;
    controller.enqueue(piece);
  };
  const stream = new ReadableStream<Uint8Array>(
    {
      start: (c) => {
        controller = c;
      },
      pull: () => {
        const next = pending.shift();
        if (next) give(next);
        else waiting = true;
      },
      cancel: () => {
        state.cancelled = true;
      },
    },
    { highWaterMark: 0 },
  );
  return {
    stream,
    state,
    /** Make `piece` available to the next read (at once, if one is waiting). */
    push: (piece: Uint8Array) => (waiting ? give(piece) : pending.push(piece)),
    end: () => controller.close(),
  };
}

const sse = (n: number) => `event: message\ndata: {"jsonrpc":"2.0","method":"n${n}"}\n\n`;

afterEach(() => {
  vi.useRealTimers();
});

describe("MCP over the runner link", () => {
  it("forwards a request and its answer unchanged, allow-listed headers only", async () => {
    const { seen, handler } = scripted(
      () =>
        new Response('{"jsonrpc":"2.0","id":1,"result":{}}', {
          status: 200,
          headers: { "content-type": "application/json", "x-internal": "nope" },
        }),
    );
    const { agent, upstream, server } = link(handler);
    const body = '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{"q":"naïve ✓"}}';
    const res = await agent({
      body,
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        "mcp-protocol-version": "2025-06-18",
        cookie: "secret=1",
      },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/json");
    expect(res.headers.get("x-internal")).toBeNull();
    expect(await res.text()).toBe('{"jsonrpc":"2.0","id":1,"result":{}}');
    expect(seen[0]?.body).toBe(body);
    expect(seen[0]?.request.method).toBe("POST");
    expect(seen[0]?.request.headers.get("authorization")).toBe("Bearer cdm_test");
    expect(seen[0]?.request.headers.get("mcp-protocol-version")).toBe("2025-06-18");
    expect(seen[0]?.request.headers.get("cookie")).toBeNull();
    await settle();
    expect(upstream.inFlight).toBe(0);
    expect(server.inFlight).toBe(0);
  });

  it("passes a DELETE and a bodiless status through", async () => {
    const { seen, handler } = scripted(({ request }) =>
      request.method === "DELETE"
        ? new Response(null, { status: 204 })
        : new Response("{}", { status: 405, headers: { "content-type": "application/json" } }),
    );
    const { agent } = link(handler);
    const del = await agent({ method: "DELETE", headers: { "mcp-session-id": "s-1" } });
    expect(del.status).toBe(204);
    expect(del.body).toBeNull();
    expect(seen[0]?.request.headers.get("mcp-session-id")).toBe("s-1");
    const get = await agent({ method: "GET" });
    expect(get.status).toBe(405);
    expect(seen.map((s) => s.request.method)).toEqual(["DELETE", "GET"]);
  });

  it("streams SSE in order, never reading more than the window ahead of the agent", async () => {
    const body = manualStream();
    const { handler } = scripted(
      () => new Response(body.stream, { headers: { "content-type": "text/event-stream" } }),
    );
    const { agent, sent } = link(handler);
    const res = await agent({ body: "{}" });
    expect(res.headers.get("content-type")).toBe("text/event-stream");
    const reader = (res.body as ReadableStream<Uint8Array>).getReader();
    const decoder = new TextDecoder();

    // Events arrive one by one, in order, as the handler writes them.
    for (const n of [1, 2, 3]) {
      body.push(new TextEncoder().encode(sse(n)));
      const { value } = await reader.read();
      expect(decoder.decode(value)).toBe(sse(n));
    }

    // The agent stops reading: the server reads a window's worth and then waits for acks.
    const big = new Uint8Array(MCP_LINK_CHUNK_BYTES).fill(0x61);
    const total = 12;
    for (let i = 0; i < total; i++) body.push(big);
    await settle();
    const ahead = body.state.pulled - 3 * sse(1).length;
    expect(ahead).toBeGreaterThan(0);
    expect(ahead).toBeLessThanOrEqual(MCP_LINK_WINDOW_BYTES + MCP_LINK_CHUNK_BYTES);
    expect(ahead).toBeLessThan(total * MCP_LINK_CHUNK_BYTES);

    // Reading on lets the rest through, acked piece by piece.
    let received = 0;
    while (received < total * MCP_LINK_CHUNK_BYTES) {
      const { value, done } = await reader.read();
      if (done) break;
      received += value.length;
    }
    expect(received).toBe(total * MCP_LINK_CHUNK_BYTES);
    expect(sent.filter((f) => f.type === "mcp.ack").length).toBeGreaterThanOrEqual(total);
    body.end();
    expect((await reader.read()).done).toBe(true);
  });

  it("cancels the server's request when the agent goes away", async () => {
    const before = manualStream();
    const during = manualStream();
    const streams = [before, during];
    const { seen, handler } = scripted(
      () =>
        new Response(streams.shift()?.stream, { headers: { "content-type": "text/event-stream" } }),
    );
    const { agent, server, upstream, sent } = link(handler);

    // While the agent reads the stream: it cancels its body.
    const res = await agent({ body: "{}" });
    await (res.body as ReadableStream).cancel();
    await settle();
    expect(seen[0]?.request.signal.aborted).toBe(true);
    expect(before.state.cancelled).toBe(true);

    // Before the head: its request is aborted (the proxy answers 499).
    const abort = new AbortController();
    const holding = scripted(() => new Promise<Response>(() => undefined));
    const slow = link(holding.handler);
    const pending = handleMcpRequest(
      new Request("http://127.0.0.1:1/mcp", {
        method: "POST",
        body: "{}",
        headers: { authorization: "Bearer cdm_test" },
        signal: abort.signal,
      }),
      slow.upstream,
    );
    await settle();
    abort.abort();
    expect((await pending).status).toBe(499);
    await settle();
    expect(holding.seen[0]?.request.signal.aborted).toBe(true);
    expect(slow.server.inFlight).toBe(0);
    expect(slow.upstream.inFlight).toBe(0);

    expect(sent.filter((f) => f.type === "mcp.cancel")).toHaveLength(1);
    expect(server.inFlight).toBe(0);
    expect(upstream.inFlight).toBe(0);
  });

  it("refuses a body over the limit without sending it", async () => {
    const { handler, seen } = scripted(() => new Response("{}"));
    const { agent, sent } = link(handler);
    const res = await agent({ body: "x".repeat(MCP_LINK_MAX_REQUEST_BYTES + 1) });
    expect(res.status).toBe(413);
    expect(await res.json()).toMatchObject({
      error: { message: expect.stringMatching(/too large/) },
    });
    expect(sent).toEqual([]);
    expect(seen).toEqual([]);
  });

  it("answers 429 beyond the in-flight limit", async () => {
    const { handler } = scripted(() => new Promise<Response>(() => undefined));
    const { agent, server } = link(handler);
    const held = Array.from({ length: MCP_LINK_MAX_IN_FLIGHT }, () => agent({ body: "{}" }));
    void held;
    await settle();
    expect(server.inFlight).toBe(MCP_LINK_MAX_IN_FLIGHT);
    const over = await agent({ body: "{}" });
    expect(over.status).toBe(429);
    expect(await over.json()).toMatchObject({
      error: { message: expect.stringMatching(/Too many CodeDen MCP requests/) },
    });
  });

  it("fails in-flight requests on both ends when the link drops", async () => {
    const { seen, handler } = scripted(() => new Promise<Response>(() => undefined));
    const { agent, drop, server, upstream } = link(handler);
    const pending = agent({ body: "{}" });
    await settle();
    expect(server.inFlight).toBe(1);
    drop();
    const res = await pending;
    expect(res.status).toBe(502);
    expect(await res.json()).toMatchObject({
      error: { message: expect.stringMatching(/^CodeDen server unreachable/) },
    });
    expect(seen[0]?.request.signal.aborted).toBe(true);
    expect(server.inFlight).toBe(0);
    expect(upstream.inFlight).toBe(0);
    // With no connection, a new request fails the same way at once.
    expect((await agent({ body: "{}" })).status).toBe(502);
  });

  it("gives up on a head after 300 s, as fetch does on the HTTP upstream", async () => {
    vi.useFakeTimers();
    const { seen, handler } = scripted(() => new Promise<Response>(() => undefined));
    const { agent, server } = link(handler);
    const pending = agent({ body: "{}" });
    await vi.advanceTimersByTimeAsync(299_000);
    expect(server.inFlight).toBe(1);
    await vi.advanceTimersByTimeAsync(1_000);
    const res = await pending;
    expect(res.status).toBe(502);
    expect(seen[0]?.request.signal.aborted).toBe(true);
    expect(server.inFlight).toBe(0);
  });
});

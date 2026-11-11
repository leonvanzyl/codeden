/**
 * Local MCP proxy (§4.4). Agents always talk to `http://127.0.0.1:<runnerPort>/mcp`; the
 * runner forwards Streamable-HTTP MCP traffic (POST with JSON or SSE responses, GET SSE
 * streams, DELETE to end a session) to the server's `/mcp` with the agent's own
 * session-scoped bearer token, which the server validates.
 *
 * The transport behind the proxy is an `McpUpstream`, so a remote runner can later tunnel
 * over the runner connection instead of plain HTTP without changing the agent-facing side.
 */

/** Something that can answer a forwarded MCP HTTP request. */
export interface McpUpstream {
  forward(request: Request): Promise<Response>;
}

/** Request headers passed through to the upstream. */
const REQUEST_HEADERS = [
  "authorization",
  "accept",
  "content-type",
  "mcp-session-id",
  "mcp-protocol-version",
  "last-event-id",
];

/** Response headers passed back to the agent. */
const RESPONSE_HEADERS = [
  "content-type",
  "cache-control",
  "mcp-session-id",
  "mcp-protocol-version",
  "www-authenticate",
];

function pick(source: Headers, names: string[]): Headers {
  const out = new Headers();
  for (const name of names) {
    const value = source.get(name);
    if (value !== null) out.set(name, value);
  }
  return out;
}

/** Direct HTTP to the server's MCP endpoint (local runners). */
export class HttpMcpUpstream implements McpUpstream {
  constructor(readonly url: string) {}

  async forward(request: Request): Promise<Response> {
    const hasBody = request.method !== "GET" && request.method !== "HEAD";
    const upstream = await fetch(this.url, {
      method: request.method,
      headers: pick(request.headers, REQUEST_HEADERS),
      body: hasBody ? await request.arrayBuffer() : undefined,
      signal: request.signal,
      redirect: "manual",
    });
    return new Response(upstream.body, {
      status: upstream.status,
      statusText: upstream.statusText,
      headers: pick(upstream.headers, RESPONSE_HEADERS),
    });
  }
}

function jsonRpcError(status: number, message: string): Response {
  return new Response(
    JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32000, message } }),
    { status, headers: { "content-type": "application/json" } },
  );
}

/**
 * Handle one agent request to `/mcp`. Requires a bearer token (the session's scoped
 * token); the upstream decides whether it is valid.
 */
export async function handleMcpRequest(
  request: Request,
  upstream: McpUpstream | undefined,
): Promise<Response> {
  if (!/^Bearer\s+\S+/i.test(request.headers.get("authorization") ?? "")) {
    return jsonRpcError(401, "Missing session token");
  }
  if (!upstream) return jsonRpcError(503, "CodeDen MCP endpoint is not configured");
  try {
    return await upstream.forward(request);
  } catch (error) {
    if (request.signal.aborted) return new Response(null, { status: 499 });
    return jsonRpcError(
      502,
      `CodeDen server unreachable (it may be restarting; call the same tool again in a few seconds): ${(error as Error).message}`,
    );
  }
}

import { CODEDEN_VERSION, type McpTokenClaims } from "@codeden/contracts";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import type { ToolRegistry } from "./registry";
import type { McpTokenStore } from "./tokens";

export interface McpEndpointDeps {
  tokens: McpTokenStore;
  registry: ToolRegistry;
  log?: (message: string) => void;
}

function jsonRpcError(status: number, message: string, headers: Record<string, string> = {}) {
  return new Response(
    JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32000, message } }),
    { status, headers: { "content-type": "application/json", ...headers } },
  );
}

function bearerOf(request: Request): string | undefined {
  const auth = request.headers.get("authorization") ?? "";
  return /^Bearer\s+/i.test(auth) ? auth.replace(/^Bearer\s+/i, "").trim() : undefined;
}

export interface McpRequestOptions {
  /**
   * Whether this caller may use a live token's claims. A refused token is answered exactly as
   * an invalid one, so the caller learns nothing about it (a runner using a token of a session
   * that isn't routed to it, `docs/remote-runners.md` §11).
   */
  accept?: (claims: McpTokenClaims) => boolean;
}

/** Answers one MCP HTTP request: `/mcp`, or one that came over a runner link. */
export type McpHandler = (request: Request, opts?: McpRequestOptions) => Promise<Response>;

/**
 * The internal MCP endpoint (`/mcp`, §4.4, §8.3): Streamable HTTP in stateless mode, one MCP
 * server and transport per request. Every request needs a live per-session bearer token,
 * whose role decides which tools are listed and callable. Responses stream as SSE, so a
 * long-running tool (`ask_user`) keeps the connection alive while it waits. Requests from a
 * remote runner's proxy arrive over its link and are answered here too (`runner/mcp-link.ts`).
 */
export function createMcpHandler(deps: McpEndpointDeps): McpHandler {
  return async (request, opts = {}) => {
    const verified = deps.tokens.verify(bearerOf(request));
    const claims = verified && (opts.accept?.(verified) ?? true) ? verified : undefined;
    if (!claims) {
      return jsonRpcError(401, "Missing or invalid CodeDen session token", {
        "www-authenticate": 'Bearer realm="codeden"',
      });
    }
    if (request.method !== "POST") {
      return jsonRpcError(405, "Method not allowed (stateless endpoint)", { allow: "POST" });
    }

    const server = new Server(
      { name: "codeden", version: CODEDEN_VERSION },
      {
        capabilities: { tools: { listChanged: false } },
        instructions:
          "CodeDen tools: report progress, ask the user, share images, drive the session browser, generate images, suggest follow-ups and finish.",
      },
    );
    server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: deps.registry.list(claims.role, {
        projectId: claims.projectId,
        sessionId: claims.sessionId,
      }),
    }));
    server.setRequestHandler(CallToolRequestSchema, async (req, extra) => {
      const result = await deps.registry.call(req.params.name, req.params.arguments, {
        role: claims.role,
        sessionId: claims.sessionId,
        projectId: claims.projectId,
        caller: "mcp",
        signal: extra.signal,
      });
      const images = (result.images ?? []).map((image) => ({
        type: "image" as const,
        data: image.data,
        mimeType: image.mediaType,
      }));
      return { content: [{ type: "text", text: result.text }, ...images], isError: result.isError };
    });

    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
    });
    await server.connect(transport);
    request.signal.addEventListener("abort", () => void server.close(), { once: true });
    try {
      return await transport.handleRequest(request);
    } catch (error) {
      deps.log?.(`mcp: ${error instanceof Error ? error.message : String(error)}`);
      return jsonRpcError(500, "Internal error");
    }
  };
}
